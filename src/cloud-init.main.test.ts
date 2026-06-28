import { describe, expect, it } from 'vitest';
import {
  MAIN_BOX_BUN_VERSION,
  MAIN_BOX_SOPS_VERSION,
  mainCloudInit,
} from '../infra/pulumi/cloud-init.main.ts';

/**
 * Unit proofs for the MAIN-box cloud-init generator (a pure string builder).
 *
 * The load-bearing regression these guard against: the install steps used to be
 * inlined as a single `bash -c '<recipe>'` runcmd, but the recipe itself
 * contained single-quoted fragments (`echo 'tidepool: inert …'`). The shell
 * terminated `bash -c '…'` at the FIRST inner quote, so the runcmd never ran and
 * NOTHING installed on the box. The fix routes the recipe through a `write_files:`
 * script that `runcmd` merely invokes — no nested quoting in runcmd at all.
 */

const PARAMS = {
  repoUrl: 'https://github.com/0x63616c/tidepool.git',
  gitRef: 'v1.2.3',
  volumeDevice: '/dev/disk/by-id/scsi-0HC_Volume_12345',
  sshPubKey: 'ssh-ed25519 AAAA operator@host',
} as const;

/** The runcmd section of the cloud-config (everything after the `runcmd:` key). */
const runcmdSection = (yaml: string): string => {
  const idx = yaml.indexOf('\nruncmd:');
  expect(idx).toBeGreaterThanOrEqual(0);
  return yaml.slice(idx);
};

describe('mainCloudInit', () => {
  it('emits a #cloud-config document with bootcmd + packages preserved', () => {
    const yaml = mainCloudInit(PARAMS);
    expect(yaml.startsWith('#cloud-config')).toBe(true);
    expect(yaml).toContain('bootcmd:');
    expect(yaml).toContain('apt-daily');
    expect(yaml).toContain('packages: [git, curl, unzip, age]');
  });

  it('writes the install steps to a script via write_files, not an inline runcmd', () => {
    const yaml = mainCloudInit(PARAMS);
    expect(yaml).toContain('write_files:');
    expect(yaml).toContain('path: /opt/bootstrap-main.sh');
    expect(yaml).toContain("permissions: '0755'");
  });

  it('runcmd is a single clean invocation of the script (no nested quotes)', () => {
    const yaml = mainCloudInit(PARAMS);
    const runcmd = runcmdSection(yaml);
    expect(runcmd).toContain('bash /opt/bootstrap-main.sh > /var/log/tp-cloudinit.log 2>&1');
    // REGRESSION GUARD: the runcmd must never reintroduce a nested-quoted inline
    // command — no `bash -c '` and no stray `echo '` inside the runcmd section.
    expect(runcmd).not.toContain("bash -c '");
    expect(runcmd).not.toContain("echo '");
  });

  it('install script carries every provisioning step with interpolated inputs', () => {
    const yaml = mainCloudInit(PARAMS);
    // Toolchain (pinned versions interpolated).
    expect(yaml).toContain('apt-get install -y nodejs');
    expect(yaml).toContain(`v${MAIN_BOX_SOPS_VERSION}`);
    expect(yaml).toContain(`bun-v${MAIN_BOX_BUN_VERSION}`);
    // Volume: mkfs + fstab + mount using the interpolated device path.
    expect(yaml).toContain(`mkfs.ext4 -F ${PARAMS.volumeDevice}`);
    expect(yaml).toContain('mkdir -p /mnt/tidepool');
    expect(yaml).toContain(PARAMS.volumeDevice);
    // Repo at the pinned ref.
    expect(yaml).toContain(`git clone ${PARAMS.repoUrl}`);
    expect(yaml).toContain(`git -C /opt/tidepool checkout ${PARAMS.gitRef}`);
    expect(yaml).toContain('bun install --frozen-lockfile');
    // systemd unit + secrets helper.
    expect(yaml).toContain('/usr/local/bin/materialize-secrets.sh');
    expect(yaml).toContain('/etc/systemd/system/tidepool.service');
    expect(yaml).toContain('systemctl enable tidepool.service');
  });

  it('creates the age-key scp target dir /root/.tidepool/bootstrap mode 0700', () => {
    const yaml = mainCloudInit(PARAMS);
    expect(yaml).toContain('install -d -m 700 /root/.tidepool/bootstrap');
  });

  it('the whole document is free of the broken nested single-quote pattern', () => {
    const yaml = mainCloudInit(PARAMS);
    // No runcmd line should wrap the recipe in a single-quoted bash -c.
    expect(yaml).not.toContain("- bash -c '");
  });
});
