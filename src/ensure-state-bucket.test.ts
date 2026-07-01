// Tests for infra/pulumi/cluster/ensure-state-bucket.sh — the bootstrap seam that
// (re)creates the self-managed Pulumi state bucket before `pulumi up`. Pulumi cannot
// create its own backend (circular), so a cold start (scorched-earth teardown) rebuilds
// it here from just the surviving S3 keys. Driven like the deploy job runs it: a stubbed
// `aws` on PATH, so the bash idempotency logic is covered by `bun run test` + CI without
// touching the live Hetzner endpoint.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'infra/pulumi/cluster/ensure-state-bucket.sh');
const BUCKET = 'tidepool-pulumi-state';

type Result = { stdout: string; stderr: string; exitCode: number };

// Write a fake `aws` onto a fresh PATH dir. `mode` controls how the stubbed
// create-bucket behaves; every invocation appends its argv to $argsFile so the test can
// assert the call shape. RGW-idempotent success, already-owned, and a hard failure are
// the three branches the script must distinguish.
const run = async (mode: 'ok' | 'already-owned' | 'denied'): Promise<Result> => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-bucket-'));
  const argsFile = join(dir, 'args.log');
  const body =
    mode === 'ok'
      ? 'exit 0'
      : mode === 'already-owned'
        ? 'echo "An error occurred (BucketAlreadyOwnedByYou) when calling the CreateBucket operation" >&2; exit 1'
        : 'echo "An error occurred (AccessDenied) when calling the CreateBucket operation" >&2; exit 1';
  writeFileSync(
    join(dir, 'aws'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${argsFile}"\n${body}\n`,
  );
  chmodSync(join(dir, 'aws'), 0o755);

  const proc = Bun.spawn(['/bin/bash', SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      AWS_ACCESS_KEY_ID: 'test-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_REGION: 'nbg1',
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const args = (() => {
    try {
      return readFileSync(argsFile, 'utf8');
    } catch {
      return '';
    }
  })();
  return { stdout: stdout + args, stderr, exitCode };
};

describe('ensure-state-bucket.sh', () => {
  it('creates the state bucket with the Hetzner endpoint + region on a fresh cold start', async () => {
    const r = await run('ok');
    assert.strictEqual(r.exitCode, 0);
    // Call shape mirrors the Pulumi-managed pg-backups bucket (cnpg.ts): plain
    // create-bucket, path-style endpoint, nbg1 region — NO LocationConstraint.
    assert.include(r.stdout, 'create-bucket');
    assert.include(r.stdout, `--bucket ${BUCKET}`);
    assert.include(r.stdout, 'nbg1.your-objectstorage.com');
    assert.include(r.stdout, '--region nbg1');
    assert.notInclude(r.stdout, 'LocationConstraint');
  });

  it('is idempotent: a normal deploy against an existing bucket is a no-op success', async () => {
    const r = await run('already-owned');
    assert.strictEqual(r.exitCode, 0);
  });

  it('fails closed on a real S3 error (e.g. AccessDenied), never a silent skip', async () => {
    const r = await run('denied');
    assert.notStrictEqual(r.exitCode, 0);
    assert.include(r.stderr, 'AccessDenied');
  });
});
