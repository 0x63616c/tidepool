import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { BoxFailed } from './domain.ts';
import { type BoxId, newBoxId } from './ids.ts';
import { BoxMaker, type BoxMakerApi, type BoxSpec } from './services.ts';

/**
 * Real Hetzner `BoxMaker` for Phase C. Workers are API cattle provisioned and
 * destroyed imperatively — no Pulumi (would drift on self-destruct). Each lease
 * is wrapped in `acquireRelease` so the DELETE fires even on defect (guardrail L3).
 *
 * Type fallback: `spec.type` → `cpx32` → `cpx44` on `resource_unavailable`.
 * Location fallback: spec.locations tried in order on each type attempt.
 * Labels: `managed_by=tidepool,role=worker` — targeted by the reaper.
 */

const HCLOUD_API = 'https://api.hetzner.cloud/v1';
const MAX_TTL_MS = 3_600_000; // 1 h hard cap

/** SSH key ID registered in the Hetzner project (created during bootstrap). */
const SSH_KEY_ID = 114_362_250;
/** Private network ID for worker boxes (tidepool-private). */
const NETWORK_ID = 12_380_644;

// ── Hetzner API types ────────────────────────────────────────────────────────

interface HcloudServerCreated {
  readonly server: {
    readonly id: number;
    readonly public_net: { readonly ipv4: { readonly ip: string } };
  };
  readonly error?: { readonly code: string; readonly message: string };
}

interface HcloudServerListed {
  readonly id: number;
  readonly name: string;
  readonly created: string; // ISO-8601
}

// ── Sentinel for resource capacity errors ────────────────────────────────────

class ResourceUnavailable extends Error {
  constructor(
    readonly serverType: string,
    readonly location: string,
  ) {
    super(`resource_unavailable: ${serverType} in ${location}`);
  }
}

// ── Pure cloud-init generator ────────────────────────────────────────────────

/**
 * Minimal cloud-init for a worker node: installs bun, adds the opencode SDK
 * globally. The reconciler delivers openai credentials separately over SSH.
 */
export const workerCloudInit = (sshPubKey: string): string =>
  [
    '#cloud-config',
    'users:',
    '  - name: root',
    '    ssh_authorized_keys:',
    `      - ${sshPubKey}`,
    // Ubuntu fires apt-daily + unattended-upgrades on first boot, which grab the
    // apt lock and stall `packages:` for many minutes (the whole cold-boot was
    // ~12 min). bootcmd runs before packages, so kill them here to free the lock.
    'bootcmd:',
    '  - systemctl stop apt-daily.service apt-daily-upgrade.service unattended-upgrades.service || true',
    '  - systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true',
    'packages: [git, curl, unzip]',
    'runcmd:',
    // Single fail-fast shell: .tp-ready is touched ONLY if every install succeeds
    // (set -e). All output captured to /var/log/tp-cloudinit.log for diagnosis.
    // HOME is unset in cloud-init's runcmd context; the bun installer needs it
    // (and bun lands in $HOME/.bun). `set -e` fails fast; `-u` is omitted as the
    // third-party install scripts legitimately reference optional vars.
    "  - bash -c 'set -ex; export HOME=/root; " +
      'curl -fsSL https://bun.sh/install | bash; ' +
      // bun install (also populates the global package cache used by the runner)
      '/root/.bun/bin/bun add -g @opencode-ai/sdk@1.17.11; ' +
      // opencode binary (spawned by createOpencodeServer via cross-spawn). The
      // curl installer's -b flag is broken ("Binary not found"); the npm package
      // ships the binary and lands it on the bun global bin (already on the
      // runner's PATH), so install it the same way as the SDK.
      '/root/.bun/bin/bun add -g opencode-ai@1.17.11; ' +
      // ensure opencode auth dir exists; JIT auth.json is delivered over SSH
      'mkdir -p /root/.local/share/opencode; ' +
      // sentinel: the runner polls this before delivering auth + executing work
      "touch /tmp/.tp-ready' > /var/log/tp-cloudinit.log 2>&1",
  ].join('\n');

// ── Hetzner API helpers ──────────────────────────────────────────────────────

const hcloudHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * Hetzner server name for a worker box. Encodes the ticket id (when known) so a
 * live box is traceable to its work from the name alone. Hetzner names allow
 * only `[a-zA-Z0-9-]` (max 63), so underscores in the ticket id are hyphenated.
 */
export const workerServerName = (boxId: string, labels: Record<string, string>): string => {
  const suffix = boxId.replace('box_', '');
  const ticket = labels.ticket?.replace(/_/g, '-');
  return (ticket ? `tp-worker-${ticket}-${suffix}` : `tp-worker-${suffix}`).slice(0, 63);
};

export const createServer = async (
  token: string,
  params: {
    readonly name: string;
    readonly serverType: string;
    readonly location: string;
    readonly sshKeyId: number;
    readonly networkId: number;
    readonly userData: string;
    readonly labels?: Record<string, string>;
  },
): Promise<{ readonly serverId: number; readonly ip: string }> => {
  const res = await fetch(`${HCLOUD_API}/servers`, {
    method: 'POST',
    headers: hcloudHeaders(token),
    body: JSON.stringify({
      name: params.name,
      server_type: params.serverType,
      image: 'ubuntu-24.04',
      location: params.location,
      ssh_keys: [params.sshKeyId],
      networks: [params.networkId],
      // Caller labels first, then the reaper-critical labels (never overridable).
      labels: { ...params.labels, managed_by: 'tidepool', role: 'worker' },
      user_data: params.userData,
    }),
  });
  const body = (await res.json()) as HcloudServerCreated;
  if (!res.ok) {
    if (body.error?.code === 'resource_unavailable') {
      throw new ResourceUnavailable(params.serverType, params.location);
    }
    throw new Error(`hcloud createServer ${res.status}: ${body.error?.message ?? 'unknown'}`);
  }
  return { serverId: body.server.id, ip: body.server.public_net.ipv4.ip };
};

export const deleteServer = async (token: string, serverId: number): Promise<void> => {
  const res = await fetch(`${HCLOUD_API}/servers/${serverId}`, {
    method: 'DELETE',
    headers: hcloudHeaders(token),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`hcloud deleteServer ${serverId} → ${res.status}`);
  }
};

export const listWorkerServers = async (
  token: string,
): Promise<ReadonlyArray<HcloudServerListed>> => {
  const res = await fetch(
    `${HCLOUD_API}/servers?label_selector=managed_by%3Dtidepool%2Crole%3Dworker`,
    { headers: hcloudHeaders(token) },
  );
  if (!res.ok) throw new Error(`hcloud listWorkers → ${res.status}`);
  const body = (await res.json()) as { servers: HcloudServerListed[] };
  return body.servers;
};

/**
 * Poll TCP port 22 every 5 s until SSH accepts a connection.
 * Bun.connect rejects immediately on ECONNREFUSED; resolves on handshake.
 */
export const waitForSsh = async (ip: string, timeoutSec = 120): Promise<void> => {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const conn = await Bun.connect({
        hostname: ip,
        port: 22,
        socket: { open: () => {}, data: () => {}, close: () => {}, error: () => {} },
      });
      conn.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`SSH on ${ip} not ready after ${timeoutSec}s`);
};

// ── BoxMaker factory ─────────────────────────────────────────────────────────

/** Type fallback chain: start with spec.type, then try larger sizes. */
const typeChain = (primary: string): ReadonlyArray<string> => {
  const known = ['cpx22', 'cpx32', 'cpx44'];
  const idx = known.indexOf(primary);
  return idx >= 0 ? known.slice(idx) : [primary, 'cpx32', 'cpx44'];
};

export const makeHetznerBoxMaker = (params: {
  readonly token: string;
  readonly sshKeyId: number;
  readonly networkId: number;
  readonly sshPubKey: string;
}): BoxMakerApi => ({
  lease: (spec: BoxSpec) => {
    // Track the provisioned server id so the release can delete it.
    let provisionedServerId = -1;

    return Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const userData = workerCloudInit(params.sshPubKey);
          for (const serverType of typeChain(spec.type)) {
            for (const location of spec.locations) {
              try {
                const boxId = newBoxId();
                const serverName = workerServerName(boxId, spec.labels ?? {});
                const { serverId, ip } = await createServer(params.token, {
                  name: serverName,
                  serverType,
                  location,
                  sshKeyId: params.sshKeyId,
                  networkId: params.networkId,
                  userData,
                  labels: spec.labels,
                });
                provisionedServerId = serverId;
                await waitForSsh(ip);
                return { id: boxId, ip, role: 'worker' as const, provider: 'hetzner' as const };
              } catch (e) {
                if (e instanceof ResourceUnavailable) continue;
                throw e;
              }
            }
          }
          throw new Error(`all type+location combinations exhausted`);
        },
        catch: (e) => new BoxFailed({ reason: String(e) }),
      }),
      (_box) =>
        Effect.tryPromise({
          try: () =>
            provisionedServerId >= 0
              ? deleteServer(params.token, provisionedServerId)
              : Promise.resolve(),
          catch: (e) =>
            // Log but never throw — the reaper will clean up orphans.
            new Error(`hcloud delete failed (reaper will clean up): ${e}`),
        }).pipe(Effect.orDie),
    );
  },

  reap: () =>
    Effect.tryPromise({
      try: async () => {
        const servers = await listWorkerServers(params.token);
        const now = Date.now();
        const deleted: BoxId[] = [];
        await Promise.all(
          servers.map(async (s) => {
            if (now - Date.parse(s.created) > MAX_TTL_MS) {
              await deleteServer(params.token, s.id);
              deleted.push(newBoxId()); // generate a local id for the audit log
            }
          }),
        );
        return { deleted };
      },
      catch: (e) => new BoxFailed({ reason: String(e) }),
    }),
});

// ── Live token resolution ────────────────────────────────────────────────────

export const hcloudToken: Effect.Effect<string, BoxFailed> = Effect.try({
  try: () => {
    const fromEnv = process.env.HCLOUD_TOKEN;
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    return readFileSync(join(homedir(), '.tidepool/bootstrap/hcloud_token'), 'utf8').trim();
  },
  catch: (e) => new BoxFailed({ reason: `hcloud token not found: ${e}` }),
});

// ── Live Layer ───────────────────────────────────────────────────────────────

/** Live `BoxMaker` — real Hetzner workers behind the locked interface. */
export const HetznerBoxMakerLive: Layer.Layer<BoxMaker, BoxFailed> = Layer.effect(
  BoxMaker,
  Effect.map(hcloudToken, (token) =>
    makeHetznerBoxMaker({
      token,
      sshKeyId: SSH_KEY_ID,
      networkId: NETWORK_ID,
      sshPubKey: readFileSync(
        join(homedir(), '.tidepool/bootstrap/ssh-tidepool.pub'),
        'utf8',
      ).trim(),
    }),
  ),
);
