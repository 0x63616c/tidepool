import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpBody, type HttpClient, type HttpClientError } from '@effect/platform';
import { Data, Effect } from 'effect';
import { BoxFailed } from './domain.ts';

/**
 * Hetzner HTTP/provisioning helpers — thin Effect wrappers over the hcloud REST
 * API (server create/delete, the worker-snapshot bake lifecycle, SSH readiness,
 * cloud-init, token resolution). Consumed by `infra/worker/bake-snapshot.ts`
 * (the Talos image bake, PR-5) and `src/hetzner-volume.ts`. The synchronous
 * box-lease seam (`BoxMaker`) that used to live here was removed when the
 * reconciler moved to the async `AgentWorker` model; the SSH worker-fleet path
 * is retired in PR-7.
 */

const HCLOUD_API = 'https://api.hetzner.cloud/v1';

/** SSH key ID registered in the Hetzner project (created during bootstrap). */
export const SSH_KEY_ID = 114_362_250;
/** Private network ID for worker boxes (tidepool-private). */
export const NETWORK_ID = 12_380_644;

// ── Hetzner API types ────────────────────────────────────────────────────────

interface HcloudServerCreated {
  readonly server: {
    readonly id: number;
    readonly public_net: { readonly ipv4: { readonly ip: string } };
  };
  readonly error?: { readonly code: string; readonly message: string };
}

// ── Sentinel for resource capacity errors ────────────────────────────────────

/**
 * Tagged sentinel: Hetzner has no capacity for this type+location. The lease
 * loop catches it (`Effect.catchTag`) to fall through to the next combination;
 * every other failure surfaces as `BoxFailed`.
 */
class ResourceUnavailable extends Data.TaggedError('ResourceUnavailable')<{
  readonly serverType: string;
  readonly location: string;
}> {}

/**
 * Fold an `@effect/platform` HTTP transport/decode failure into the seam's
 * `BoxFailed`. Used with `Effect.catchTags` so the deliberate `ResourceUnavailable`
 * and `BoxFailed` failures pass through untouched.
 */
const httpFail = (e: HttpClientError.HttpClientError): Effect.Effect<never, BoxFailed> =>
  Effect.fail(new BoxFailed({ reason: String(e) }));

/** True for a 2xx response (mirrors the old `Response.ok`). */
const isOk = (status: number): boolean => status >= 200 && status < 300;

// ── Worker install recipe (single source of truth) ───────────────────────────

/** Repo path to the worker install recipe — what is baked into a worker. */
const BAKE_SCRIPT_PATH = new URL('../infra/worker/bake.sh', import.meta.url);

/**
 * The install recipe as a list of shell command lines, read from
 * `infra/worker/bake.sh`. Both consumers — the cloud-init runcmd below and the
 * prebaked image (`infra/worker/Dockerfile`) — derive from this one file, so the
 * stock-boot path and the snapshot path can never drift. Shebang, comments and
 * blank lines are dropped; only the commands are inlined.
 */
export const bakeRecipeCommands = (): ReadonlyArray<string> =>
  readFileSync(BAKE_SCRIPT_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

/**
 * The worker install recipe as the verbatim bake.sh script body. The local
 * container harness (CI job `container-harness`) runs THIS exact text in a stock
 * `ubuntu:24.04` container, so the harness install is byte-identical to what the
 * cloud snapshot bakes and what cloud-init inlines — one source, no drift. The
 * per-boot `.tp-ready` sentinel is deliberately absent (it is appended at boot,
 * not baked); the harness touches it after this script succeeds.
 */
export const workerInstallScript = (): string => readFileSync(BAKE_SCRIPT_PATH, 'utf8');

// ── Pure cloud-init generator ────────────────────────────────────────────────

/** Per-boot readiness sentinel the runner polls before delivering JIT auth. */
const TP_READY = 'touch /tmp/.tp-ready';

/**
 * Cloud-init for a worker node. Two shapes from one source of truth:
 *
 *   - `baked: false` (default): a stock `ubuntu-24.04` box. cloud-init installs
 *     bun + the opencode SDK/binary by inlining the bake.sh recipe verbatim,
 *     then drops the per-boot sentinel. This is the ~minutes cold boot.
 *   - `baked: true`: a prebaked snapshot already has the whole recipe applied,
 *     so cloud-init shrinks to the ssh key + the per-boot sentinel ONLY. There
 *     is nothing to apt-install and no recipe to run, so the box is ready in
 *     seconds. The sentinel is never baked (it must reappear on every boot), so
 *     it stays here regardless of mode.
 *
 * The reconciler delivers openai credentials separately over SSH in both modes.
 */
export const workerCloudInit = (
  sshPubKey: string,
  opts: { readonly baked?: boolean } = {},
): string => {
  const head = [
    '#cloud-config',
    'users:',
    '  - name: root',
    '    ssh_authorized_keys:',
    `      - ${sshPubKey}`,
  ];

  if (opts.baked === true) {
    // Everything is in the image; the only first-boot work is the sentinel. A
    // bare command (no embedded quoting) sidesteps the nested-single-quote
    // runcmd mangle that bites the full-mode `bash -c '...'` wrapper.
    return [...head, 'runcmd:', `  - ${TP_READY}`].join('\n');
  }

  // Stock boot: inline the SAME recipe bake.sh defines, then append the
  // sentinel. One fail-fast `bash -c` (bake.sh begins `set -ex`); .tp-ready is
  // touched ONLY if every step succeeds, and all output is captured to
  // /var/log/tp-cloudinit.log.
  const recipe = [...bakeRecipeCommands(), TP_READY].join('; ');
  return [
    ...head,
    // Ubuntu fires apt-daily + unattended-upgrades on first boot, which grab the
    // apt lock and stall `packages:` for many minutes (the whole cold-boot was
    // ~12 min). bootcmd runs before packages, so kill them here to free the lock.
    'bootcmd:',
    '  - systemctl stop apt-daily.service apt-daily-upgrade.service unattended-upgrades.service || true',
    '  - systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true',
    'packages: [git, curl, unzip]',
    'runcmd:',
    `  - bash -c '${recipe}' > /var/log/tp-cloudinit.log 2>&1`,
  ].join('\n');
};

// ── Hetzner API helpers ──────────────────────────────────────────────────────

const hcloudHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export const createServer = Effect.fn('createServer')(
  function* (
    client: HttpClient.HttpClient,
    token: string,
    params: {
      readonly name: string;
      readonly serverType: string;
      readonly location: string;
      readonly sshKeyId: number;
      readonly networkId: number;
      readonly userData: string;
      /** Boot image: a Hetzner image name or a snapshot id. Defaults to ubuntu-24.04. */
      readonly image?: string | number;
      readonly labels?: Record<string, string>;
    },
  ) {
    const response = yield* client.post(`${HCLOUD_API}/servers`, {
      headers: hcloudHeaders(token),
      body: HttpBody.raw(
        JSON.stringify({
          name: params.name,
          server_type: params.serverType,
          image: params.image ?? 'ubuntu-24.04',
          location: params.location,
          ssh_keys: [params.sshKeyId],
          networks: [params.networkId],
          // Caller labels first, then the reaper-critical labels (never overridable).
          labels: { ...params.labels, managed_by: 'tidepool', role: 'worker' },
          user_data: params.userData,
        }),
        { contentType: 'application/json' },
      ),
    });
    const body = (yield* response.json) as HcloudServerCreated;
    if (!isOk(response.status)) {
      if (body.error?.code === 'resource_unavailable') {
        return yield* Effect.fail(
          new ResourceUnavailable({ serverType: params.serverType, location: params.location }),
        );
      }
      return yield* Effect.fail(
        new BoxFailed({
          reason: `hcloud createServer ${response.status}: ${body.error?.message ?? 'unknown'}`,
        }),
      );
    }
    return { serverId: body.server.id, ip: body.server.public_net.ipv4.ip };
  },
  Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }),
);

export const deleteServer = Effect.fn('deleteServer')(
  function* (client: HttpClient.HttpClient, token: string, serverId: number) {
    const response = yield* client.del(`${HCLOUD_API}/servers/${serverId}`, {
      headers: hcloudHeaders(token),
    });
    if (!isOk(response.status) && response.status !== 404) {
      return yield* Effect.fail(
        new BoxFailed({ reason: `hcloud deleteServer ${serverId} → ${response.status}` }),
      );
    }
  },
  Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }),
);

// ── Prebaked worker snapshot (#8) ────────────────────────────────────────────
// One tidepool-managed snapshot holds the fully-baked worker image; config
// `box.imageId` points workers at it for a seconds-fast baked boot. These three
// helpers are the snapshot lifecycle: find the existing one, image a builder
// box into a new one, and poll it to `available`. The bake orchestration that
// ties them together lives in `infra/worker/bake-snapshot.ts`.

interface HcloudImage {
  readonly id: number;
  readonly status: string;
}

/** Labels stamped on the worker snapshot, also its find/reuse selector. */
const SNAPSHOT_LABELS = { managed_by: 'tidepool', role: 'worker' } as const;

/**
 * The existing tidepool worker snapshot, if one is already baked. Lets the bake
 * be idempotent — reuse rather than pile up snapshots. Returns the newest by id.
 */
export const findWorkerSnapshot = Effect.fn('findWorkerSnapshot')(
  function* (client: HttpClient.HttpClient, token: string) {
    const response = yield* client.get(
      `${HCLOUD_API}/images?type=snapshot&label_selector=managed_by%3Dtidepool%2Crole%3Dworker`,
      { headers: hcloudHeaders(token) },
    );
    if (!isOk(response.status)) {
      return yield* Effect.fail(
        new BoxFailed({ reason: `hcloud findWorkerSnapshot → ${response.status}` }),
      );
    }
    const body = (yield* response.json) as { images: HcloudImage[] };
    return [...body.images].sort((a, b) => b.id - a.id)[0];
  },
  Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }),
);

/**
 * Snapshot a (fully-baked) builder server into a new image. Returns the image
 * id; the image starts `creating` and must be polled to `available` before use.
 */
export const createServerSnapshot = Effect.fn('createServerSnapshot')(
  function* (client: HttpClient.HttpClient, token: string, serverId: number, description: string) {
    const response = yield* client.post(`${HCLOUD_API}/servers/${serverId}/actions/create_image`, {
      headers: hcloudHeaders(token),
      body: HttpBody.raw(
        JSON.stringify({ type: 'snapshot', description, labels: SNAPSHOT_LABELS }),
        { contentType: 'application/json' },
      ),
    });
    const body = (yield* response.json) as {
      image?: HcloudImage;
      error?: { message: string };
    };
    if (!isOk(response.status) || body.image === undefined) {
      return yield* Effect.fail(
        new BoxFailed({
          reason: `hcloud createServerSnapshot ${serverId} → ${response.status}: ${body.error?.message ?? 'unknown'}`,
        }),
      );
    }
    return body.image.id;
  },
  Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }),
);

/** Current status of an image (`creating` → `available`). */
export const getImageStatus = Effect.fn('getImageStatus')(
  function* (client: HttpClient.HttpClient, token: string, imageId: number) {
    const response = yield* client.get(`${HCLOUD_API}/images/${imageId}`, {
      headers: hcloudHeaders(token),
    });
    if (!isOk(response.status)) {
      return yield* Effect.fail(
        new BoxFailed({ reason: `hcloud getImageStatus ${imageId} → ${response.status}` }),
      );
    }
    const body = (yield* response.json) as { image: HcloudImage };
    return body.image.status;
  },
  Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }),
);

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

// ── Live token resolution ────────────────────────────────────────────────────

export const hcloudToken: Effect.Effect<string, BoxFailed> = Effect.try({
  try: () => {
    const fromEnv = process.env.HCLOUD_TOKEN;
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    return readFileSync(join(homedir(), '.tidepool/bootstrap/hcloud_token'), 'utf8').trim();
  },
  catch: (e) => new BoxFailed({ reason: `hcloud token not found: ${e}` }),
});
