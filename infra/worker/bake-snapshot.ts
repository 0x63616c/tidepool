#!/usr/bin/env bun
/**
 * Bake the prebaked worker snapshot (#8).
 *
 * Provisions a ONE-TIME stock `ubuntu-24.04` builder box, lets cloud-init run
 * the full bake.sh recipe, waits for the `/tmp/.tp-ready` sentinel, then images
 * the box into a tidepool-managed Hetzner snapshot. The resulting image id goes
 * into `tidepool.config.ts` `box.imageId`, after which workers boot the snapshot
 * (seconds-fast baked boot) instead of running the recipe on every cold boot.
 *
 * Idempotent-ish: if an `available` tidepool worker snapshot already exists, it
 * is reused and echoed rather than re-baked. The builder box is ALWAYS deleted
 * (success or failure) — zero leaked servers.
 *
 *   bun infra/worker/bake-snapshot.ts
 *
 * Token: `HCLOUD_TOKEN` env or `~/.tidepool/bootstrap/hcloud_token` (never
 * printed). Progress goes to stderr; the final snapshot id goes to stdout.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sshArgv } from '../../src/agent-runner.ts';
import {
  createServer,
  createServerSnapshot,
  deleteServer,
  findWorkerSnapshot,
  getImageStatus,
  NETWORK_ID,
  SSH_KEY_ID,
  waitForSsh,
  workerCloudInit,
} from '../../src/hetzner-box.ts';
import config from '../../tidepool.config.ts';

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

const readToken = (): string => {
  const fromEnv = process.env.HCLOUD_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readFileSync(join(homedir(), '.tidepool/bootstrap/hcloud_token'), 'utf8').trim();
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `cmd` on `root@ip`, return true iff exit 0. */
const sshOk = async (ip: string, cmd: string): Promise<boolean> => {
  const proc = Bun.spawn([...sshArgv(ip, cmd)], { stdout: 'ignore', stderr: 'ignore' });
  return (await proc.exited) === 0;
};

/** Poll the per-boot sentinel until the bake recipe has finished. */
const waitForBake = async (ip: string, timeoutSec: number): Promise<void> => {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await sshOk(ip, 'test -f /tmp/.tp-ready')) return;
    await sleep(10_000);
  }
  throw new Error(`bake did not finish (no /tmp/.tp-ready) within ${timeoutSec}s`);
};

/** Poll an image until it reports `available`. */
const waitForImage = async (token: string, imageId: number, timeoutSec: number): Promise<void> => {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const status = await getImageStatus(token, imageId);
    if (status === 'available') return;
    log(`  image ${imageId} status=${status} …`);
    await sleep(10_000);
  }
  throw new Error(`image ${imageId} not available within ${timeoutSec}s`);
};

const main = async (): Promise<void> => {
  const token = readToken();

  const existing = await findWorkerSnapshot(token);
  if (existing !== undefined && existing.status === 'available') {
    log(`reusing existing tidepool worker snapshot (idempotent, no re-bake)`);
    process.stdout.write(`snapshot:\n  id: ${existing.id}\n  status: available\n  reused: true\n`);
    return;
  }

  const sshPubKey = readFileSync(
    join(homedir(), '.tidepool/bootstrap/ssh-tidepool.pub'),
    'utf8',
  ).trim();
  const serverType = process.env.TP_BAKE_TYPE ?? config.box.type;
  const location = process.env.TP_BAKE_LOCATION ?? config.box.locations[0];
  const name = `tp-worker-builder-${Date.now().toString(36)}`;

  log(`provisioning stock builder ${name} (${serverType} @ ${location}) …`);
  const { serverId, ip } = await createServer(token, {
    name,
    serverType,
    location,
    sshKeyId: SSH_KEY_ID,
    networkId: NETWORK_ID,
    // Full recipe on a STOCK box — that is exactly what we are baking.
    userData: workerCloudInit(sshPubKey),
    labels: { role: 'builder' },
  });

  try {
    log(`builder ${serverId} @ ${ip}: waiting for SSH …`);
    await waitForSsh(ip, 180);
    log(`builder ${serverId}: running bake.sh (this takes a few minutes) …`);
    await waitForBake(ip, 900);
    log(`builder ${serverId}: bake complete, creating snapshot …`);
    const imageId = await createServerSnapshot(token, serverId, 'tidepool worker (baked)');
    await waitForImage(token, imageId, 900);
    log(`snapshot ${imageId} available`);
    process.stdout.write(`snapshot:\n  id: ${imageId}\n  status: available\n  reused: false\n`);
  } finally {
    log(`deleting builder ${serverId} …`);
    await deleteServer(token, serverId);
    log(`builder ${serverId} deleted`);
  }
};

main().catch((err: unknown) => {
  process.stdout.write(`error: snapshot bake failed\n  reason: ${String(err)}\n`);
  process.exit(1);
});
