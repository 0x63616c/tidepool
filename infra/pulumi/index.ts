import * as hcloud from '@pulumi/hcloud';
import * as pulumi from '@pulumi/pulumi';
import { mainCloudInit } from './cloud-init.main';

/**
 * Tidepool control-plane infrastructure (Pulumi-first, declarative — tenet 2).
 *
 * This program declares the MAIN box and the durable resources around it. Unlike
 * the worker fleet (imperative API cattle in `src/hetzner-box.ts`, which would
 * drift on self-destruct), the management node is long-lived, so it is Pulumi
 * state managed.
 *
 * R1 decision: REFERENCE the pre-existing private network + SSH key (workers
 * hardcode these ids; the main box must join the SAME network). We never create
 * a second network/key here.
 *
 * Runs under NODE in this standalone package (`@pulumi/*` are node deps, not part
 * of the Bun root). The S3 state backend + secrets passphrase are wired via the
 * environment at `pulumi login` / `pulumi up` time, not in code.
 */

// ── Provider: token strictly from the environment (never committed) ────────────
const token = process.env.HCLOUD_TOKEN;
if (!token) {
  throw new Error('HCLOUD_TOKEN is required (export it before `pulumi up`)');
}
const provider = new hcloud.Provider('hcloud', { token });

// Control-box shape is stack config, not a code literal, so `tp up` can walk a
// capacity fallback chain (`pulumi config set tp:controlBoxType …`) when Hetzner
// has no stock of a given type/region — without editing this program. Defaults
// keep the cheap Intel primary (cx23, 2c/4GB) in nbg1.
const stackConfig = new pulumi.Config('tp');
const CONTROL_BOX_TYPE = stackConfig.get('controlBoxType') ?? 'cx23';
const LOCATION = stackConfig.get('controlBoxLocation') ?? 'nbg1';
const MOUNT_POINT = '/mnt/tidepool';

// R1 ids — the pre-existing network + ssh key workers hardcode (src/hetzner-box.ts).
// The main box MUST reference these exact resources, never create new ones.
const NETWORK_ID = 12_380_644;
const SSH_KEY_ID = 114_362_250;

// ── R1: reference EXISTING shared network + ssh key (do NOT create) ────────────
/** The private network workers + main box share (`tidepool-private`). */
const network = hcloud.getNetworkOutput({ id: NETWORK_ID }, { provider });
/** The shared SSH key registered in the project (`tidepool`). */
const sshKey = hcloud.getSshKeyOutput({ id: SSH_KEY_ID }, { provider });

// ── Durable state volume (holds the control-plane sqlite) ──────────────────────
// Created WITHOUT a serverId so the server's cloud-init can depend only on the
// volume id (breaking the server↔volume cycle); attached below via
// VolumeAttachment. `deleteProtection` + the `protect` resource option are belt
// and braces: neither Hetzner nor `pulumi destroy` can drop the state volume.
const volume = new hcloud.Volume(
  'tp-state',
  {
    name: 'tp-state',
    size: 10,
    location: LOCATION,
    format: 'ext4',
    deleteProtection: true,
  },
  { provider, protect: true },
);

// Hetzner exposes an attached volume at a deterministic by-id path derived from
// its numeric id, so cloud-init can format/mount it without the (attachment-only)
// `linuxDevice` output — keeping the dependency one-directional.
const volumeDevice = pulumi.interpolate`/dev/disk/by-id/scsi-0HC_Volume_${volume.id}`;

// ── Main box ───────────────────────────────────────────────────────────────────
const userData = pulumi
  .all([volumeDevice, sshKey.publicKey])
  .apply(([device, pubKey]) =>
    mainCloudInit({
      repoUrl: process.env.TIDEPOOL_REPO_URL ?? 'https://github.com/0x63616c/tidepool.git',
      // Prefer an immutable ref (tag/SHA) for reproducibility; defaults to main
      // only as a scaffolding placeholder.
      gitRef: process.env.TIDEPOOL_GIT_REF ?? 'main',
      volumeDevice: device,
      mountPoint: MOUNT_POINT,
      sshPubKey: pubKey,
    }),
  );

const server = new hcloud.Server(
  'tp-main',
  {
    name: 'tp-main',
    // Default cx23 = 2 vCPU Intel / 4GB (nbg1) — the cheap control-plane pick;
    // overridable via `tp:controlBoxType` for the capacity fallback chain.
    // Workers are a separate, larger fleet sized in config (src/hetzner-box.ts).
    serverType: CONTROL_BOX_TYPE,
    image: 'ubuntu-24.04',
    location: LOCATION,
    sshKeys: [`${SSH_KEY_ID}`],
    labels: { role: 'management', managed_by: 'tidepool' },
    userData,
  },
  { provider },
);

const serverId = server.id.apply((id) => Number.parseInt(id, 10));

// Join the main box to the SAME private network the workers live on.
new hcloud.ServerNetwork(
  'tp-main-net',
  {
    serverId,
    networkId: network.id,
  },
  { provider },
);

// Attach the state volume (mounting is handled by cloud-init's fstab entry).
new hcloud.VolumeAttachment(
  'tp-state-attach',
  {
    serverId,
    volumeId: volume.id.apply((id) => Number.parseInt(id, 10)),
    automount: false,
  },
  { provider },
);

// ── Firewall: deny-all-inbound except tcp/22 (tenet 9: outbound-only box) ───────
// Hetzner firewalls are inbound allow-lists (unmatched inbound is dropped) and
// leave outbound open when no outbound rules are set — exactly "no public inbound
// except SSH, free outbound".
new hcloud.Firewall(
  'tp-main-fw',
  {
    name: 'tp-main-fw',
    rules: [
      {
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['0.0.0.0/0', '::/0'],
      },
    ],
    applyTos: [{ server: serverId }],
  },
  { provider },
);

// ── Outputs ────────────────────────────────────────────────────────────────────
export const mainBoxIpv4 = server.ipv4Address;
export const mainBoxId = server.id;
export const stateVolumeId = volume.id;
export const privateNetworkId = network.id;
