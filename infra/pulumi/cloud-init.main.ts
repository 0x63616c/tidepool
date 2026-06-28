/**
 * Pure cloud-init generator for the Tidepool MAIN box (the control plane).
 *
 * No Pulumi imports — this is a plain string builder so it stays trivially unit
 * testable and importable from `index.ts`, which resolves the volume device and
 * pinned git ref as Pulumi `Output`s and feeds the concrete values in via
 * `.apply(...)`.
 *
 * What the main box gets on first boot (mirrors the worker recipe's "single
 * source of truth" discipline, but for the management node):
 *   1. Toolchain: git, curl, age, node, sops (pinned), bun (pinned 1.2.19).
 *   2. Durable state volume: mkfs (idempotent) + fstab mount at /mnt/tidepool
 *      with `nofail,discard` so a boot never blocks on a detached volume.
 *   3. The repo cloned to /opt/tidepool at a pinned ref + `bun install --frozen`.
 *   4. The systemd unit installed and ENABLED but left STOPPED — its
 *      `ConditionPathExists=/root/.tidepool/bootstrap/age-mainbox.key` keeps it
 *      inert until the operator delivers the master age key out-of-band.
 *
 * SECURITY (tenet 9): the age master key is NEVER embedded here. The box boots
 * inert; the human SCPs `age-mainbox.key` into place, then the unit's condition
 * passes on the next start and `materialize-secrets.sh` decrypts the rest.
 */

/** Pinned toolchain versions for the main box (kept in lockstep with `.mise.toml`). */
export const MAIN_BOX_BUN_VERSION = '1.2.19';
/** sops binary version — matches the version that encrypted `secrets/*.enc.yaml`. */
export const MAIN_BOX_SOPS_VERSION = '3.13.1';
/** Node major used on the box (Pulumi + tooling run under node; pinned for parity). */
export const MAIN_BOX_NODE_MAJOR = '22';

export interface MainCloudInitParams {
  /** Clone URL of the Tidepool repo, e.g. `https://github.com/0x63616c/tidepool.git`. */
  readonly repoUrl: string;
  /**
   * Pinned git ref to check out (a tag or full SHA — NOT a moving branch, so the
   * box's code is reproducible per GitOps). Defaults to `main` only as a
   * scaffolding placeholder; callers should pass an immutable ref.
   */
  readonly gitRef: string;
  /**
   * Linux device path of the attached Hetzner volume, e.g.
   * `/dev/disk/by-id/scsi-0HC_Volume_<id>` (the `linuxDevice` output of the
   * `hcloud.Volume`). Resolved by `index.ts` via `.apply`.
   */
  readonly volumeDevice: string;
  /** Where the state volume mounts (the control-plane sqlite lives here). */
  readonly mountPoint?: string;
  /** SSH public key to authorize for root (operator access). Optional. */
  readonly sshPubKey?: string;
}

const DEFAULT_MOUNT = '/mnt/tidepool';
const CLONE_DIR = '/opt/tidepool';
/** Where the operator SCPs the master age key; created (0700) by the install script. */
const AGE_KEY_DIR = '/root/.tidepool/bootstrap';
const AGE_KEY_GUARD = `${AGE_KEY_DIR}/age-mainbox.key`;
/** Path on the box where the install recipe is written by cloud-init `write_files`. */
const BOOTSTRAP_SCRIPT = '/opt/bootstrap-main.sh';
/** Where the install script's combined stdout/stderr is captured for the reconciler. */
const BOOTSTRAP_LOG = '/var/log/tp-cloudinit.log';

/**
 * Build the `#cloud-config` document for the main box. Every step is idempotent
 * (re-running on a reboot is a no-op).
 *
 * The install recipe is delivered as a SCRIPT FILE via `write_files:` and merely
 * INVOKED by a single, quote-free `runcmd`. It must never be inlined as a
 * `bash -c '<recipe>'` string: the recipe contains single-quoted fragments
 * (e.g. `echo 'tidepool: inert …'`, `grep -q '<mount>'`), which would terminate
 * the outer `bash -c '…'` at the first inner quote — silently mangling the whole
 * command so NOTHING installs. Routing through a file sidesteps shell quoting
 * entirely. All output is captured to `/var/log/tp-cloudinit.log` for the
 * reconciler to surface.
 */
export const mainCloudInit = (params: MainCloudInitParams): string => {
  const mount = params.mountPoint ?? DEFAULT_MOUNT;
  // systemd escapes a mount unit name from the path (e.g. /mnt/tidepool →
  // mnt-tidepool.mount); the service's After= depends on this exact name.
  const recipe = [
    '#!/usr/bin/env bash',
    'set -ex',
    'export HOME=/root',
    // ── Toolchain ───────────────────────────────────────────────────────────
    // node (NodeSource, pinned major) — Pulumi + box tooling run under node.
    `curl -fsSL https://deb.nodesource.com/setup_${MAIN_BOX_NODE_MAJOR}.x | bash -`,
    'apt-get install -y nodejs',
    // sops (pinned .deb from the official release) — used by materialize-secrets.
    `curl -fsSLo /tmp/sops.deb https://github.com/getsops/sops/releases/download/v${MAIN_BOX_SOPS_VERSION}/sops_${MAIN_BOX_SOPS_VERSION}_amd64.deb`,
    'apt-get install -y /tmp/sops.deb',
    'rm -f /tmp/sops.deb',
    // bun (pinned) — the control plane runs under bun.
    `curl -fsSL https://bun.sh/install | bash -s "bun-v${MAIN_BOX_BUN_VERSION}"`,
    // ── State volume: format (idempotent) + persistent mount ─────────────────
    `mkdir -p ${mount}`,
    // Only mkfs a blank device — `blkid` succeeds once a filesystem exists, so a
    // reboot or reattach never reformats (and never wipes the sqlite store).
    `blkid ${params.volumeDevice} || mkfs.ext4 -F ${params.volumeDevice}`,
    // fstab with nofail (boot proceeds if the volume is detached) + discard
    // (TRIM for the network block device). Append only if not already present.
    `grep -q '${mount}' /etc/fstab || echo '${params.volumeDevice} ${mount} ext4 defaults,nofail,discard 0 2' >> /etc/fstab`,
    'systemctl daemon-reload',
    `mount ${mount} || true`,
    // ── Repo at a pinned ref ─────────────────────────────────────────────────
    `git clone ${params.repoUrl} ${CLONE_DIR} || true`,
    `git -C ${CLONE_DIR} fetch --all --tags`,
    `git -C ${CLONE_DIR} checkout ${params.gitRef}`,
    `/root/.bun/bin/bun install --frozen-lockfile --cwd ${CLONE_DIR}`,
    // ── systemd unit: install + enable, but leave STOPPED ────────────────────
    // The unit ships in the repo (single source of truth). Enable so it starts
    // on the NEXT boot, but do not start now — its ConditionPathExists guard on
    // the age master key keeps it inert until the operator delivers the key.
    `install -m 755 ${CLONE_DIR}/infra/scripts/materialize-secrets.sh /usr/local/bin/materialize-secrets.sh`,
    `install -m 644 ${CLONE_DIR}/infra/systemd/tidepool.service /etc/systemd/system/tidepool.service`,
    'systemctl daemon-reload',
    'systemctl enable tidepool.service',
    // ── Age-key drop dir ─────────────────────────────────────────────────────
    // The operator SCPs the master age key here out-of-band; create it 0700 so
    // the scp target exists (and the unit's ConditionPathExists can ever pass).
    `install -d -m 700 ${AGE_KEY_DIR}`,
    // Surface, in the boot log, exactly why the service is not running yet.
    `test -f ${AGE_KEY_GUARD} || echo 'tidepool: inert — awaiting ${AGE_KEY_GUARD} (deliver age-mainbox.key, then: systemctl start tidepool)'`,
  ].join('\n');

  // Indent the script under the `content: |` YAML block scalar (6 spaces, two
  // levels past the `- ` list item). cloud-init writes it verbatim to disk.
  const scriptBlock = recipe
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');

  const lines = [
    '#cloud-config',
    'users:',
    '  - name: root',
  ];
  if (params.sshPubKey) {
    lines.push('    ssh_authorized_keys:', `      - ${params.sshPubKey}`);
  }
  lines.push(
    // Free the apt lock early (Ubuntu's first-boot apt-daily stalls package: for
    // minutes) — same trick the worker cloud-init uses.
    'bootcmd:',
    '  - systemctl stop apt-daily.service apt-daily-upgrade.service unattended-upgrades.service || true',
    '  - systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true',
    'packages: [git, curl, unzip, age]',
    // The install recipe is written to disk as a script (no shell quoting hazard)
    // and run by a single clean runcmd below.
    'write_files:',
    `  - path: ${BOOTSTRAP_SCRIPT}`,
    "    permissions: '0755'",
    '    content: |',
    scriptBlock,
    'runcmd:',
    `  - bash ${BOOTSTRAP_SCRIPT} > ${BOOTSTRAP_LOG} 2>&1`,
  );
  return lines.join('\n');
};
