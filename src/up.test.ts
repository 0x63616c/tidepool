import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { type BucketStore, ensureBucket } from './object-storage.ts';
import {
  bootstrapPaths,
  boxAttemptPlan,
  CONTROL_BOX_TYPES,
  CommandRunner,
  h2ScpCommand,
  isCapacityError,
  parseReadiness,
  preflight,
  pulumiLoginUrl,
  up,
} from './up.ts';

/**
 * Unit-level proofs for the bring-up orchestrator — all WITHOUT provisioning.
 * The pure helpers (plan, capacity classifier, readiness parser, templates) are
 * exercised directly; the dry-run path is proven to never touch the injected
 * `CommandRunner`; preflight is proven to gate on the H1 inputs.
 */

/** Make a bootstrap dir; optionally drop in a `hetzner-s3.env` so preflight passes. */
const tmpBootstrap = (withS3Env: boolean): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-up-'));
  if (withS3Env) {
    writeFileSync(
      join(dir, 'hetzner-s3.env'),
      [
        'AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
        'AWS_SECRET_ACCESS_KEY=s3cr3t',
        'AWS_REGION=nbg1',
        'S3_ENDPOINT=https://nbg1.your-objectstorage.com',
      ].join('\n'),
    );
  }
  return dir;
};

describe('preflight', () => {
  it.effect('missing S3 creds → fails with the H1 instructions', () =>
    Effect.gen(function* () {
      const paths = bootstrapPaths(tmpBootstrap(false));
      const exit = yield* Effect.exit(preflight(paths));
      assert.isTrue(exit._tag === 'Failure');
      if (exit._tag !== 'Failure' || exit.cause._tag !== 'Fail')
        return assert.fail('expected Fail');
      const { message, stage } = exit.cause.error;
      assert.strictEqual(stage, 'preflight');
      assert.include(message, 'H1');
      assert.include(message, 'hetzner-s3.env');
      // The H1 block tells the human exactly which keys to write.
      for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_ENDPOINT'])
        assert.include(message, key);
    }),
  );

  it.effect('present S3 creds → succeeds', () =>
    Effect.gen(function* () {
      const paths = bootstrapPaths(tmpBootstrap(true));
      yield* preflight(paths); // no failure
    }),
  );
});

describe('boxAttemptPlan', () => {
  it('leads with the cheap primary cx23 @ nbg1 and walks the full chain', () => {
    const plan = boxAttemptPlan();
    assert.deepStrictEqual(plan[0], { type: 'cx23', location: 'nbg1' });
    // Every type is tried in the primary location before any location change.
    assert.deepStrictEqual(
      plan.slice(0, CONTROL_BOX_TYPES.length).map((a) => a.type),
      [...CONTROL_BOX_TYPES],
    );
    assert.strictEqual(plan.length, CONTROL_BOX_TYPES.length * 3);
    // cpx21 (AMD) is the reliable second, ahead of the second Intel type.
    assert.strictEqual(plan[1]?.type, 'cpx21');
  });
});

describe('isCapacityError', () => {
  it('matches Hetzner no-stock signatures, not unrelated failures', () => {
    assert.isTrue(isCapacityError('Error: resource_unavailable for server type cx23'));
    assert.isTrue(isCapacityError('the selected server type is currently out of stock'));
    assert.isTrue(isCapacityError('no available capacity in nbg1'));
    assert.isFalse(isCapacityError('invalid HCLOUD_TOKEN'));
    assert.isFalse(isCapacityError('pulumi: stack already exists'));
  });
});

describe('parseReadiness', () => {
  it('is ready only when cloud-init done, key present, and unit active', () => {
    const ok = parseReadiness('cloud_init=done age_key=present tidepool=active\n');
    assert.deepStrictEqual(ok, {
      cloudInit: 'done',
      ageKey: 'present',
      tidepool: 'active',
      ready: true,
    });
    assert.isFalse(parseReadiness('cloud_init=running age_key=present tidepool=active').ready);
    assert.isFalse(parseReadiness('cloud_init=done age_key=missing tidepool=inactive').ready);
    // Empty (ssh not up yet) parses cleanly and is not ready.
    assert.isFalse(parseReadiness('').ready);
  });
});

describe('templates', () => {
  it('h2ScpCommand fills the real box IP into the exact scp template', () => {
    const paths = bootstrapPaths('/home/op/.tidepool/bootstrap');
    assert.strictEqual(
      h2ScpCommand('203.0.113.7', paths),
      'scp /home/op/.tidepool/bootstrap/age-mainbox.key root@203.0.113.7:/root/.tidepool/bootstrap/age-mainbox.key',
    );
  });

  it('pulumiLoginUrl is the path-style S3 backend URL', () => {
    assert.strictEqual(
      pulumiLoginUrl('tidepool-pulumi-state', 'https://nbg1.your-objectstorage.com'),
      's3://tidepool-pulumi-state?endpoint=nbg1.your-objectstorage.com&s3ForcePathStyle=true',
    );
  });
});

/** A fake `BucketStore` recording head/create — reused from the object-storage seam. */
const fakeBucketStore = (existing: ReadonlyArray<string> = []) => {
  const buckets = new Set(existing);
  const calls: string[] = [];
  const store: BucketStore = {
    head: (b) =>
      Effect.sync(() => {
        calls.push(`head:${b}`);
        return buckets.has(b);
      }),
    create: (b) =>
      Effect.sync(() => {
        calls.push(`create:${b}`);
        buckets.add(b);
      }),
  };
  return { store, calls };
};

describe('bucket-init idempotency (object-storage seam)', () => {
  it.effect('ensure twice → exactly one create, second is a no-op', () =>
    Effect.gen(function* () {
      const { store, calls } = fakeBucketStore([]);
      const first = yield* ensureBucket(store, 'tidepool-pulumi-state');
      const second = yield* ensureBucket(store, 'tidepool-pulumi-state');
      assert.strictEqual(first.created, true);
      assert.strictEqual(second.created, false);
      assert.strictEqual(calls.filter((c) => c.startsWith('create:')).length, 1);
    }),
  );
});

describe('up --skip-pulumi (dry-run)', () => {
  /** A runner that explodes if touched — proves dry-run provisions nothing. */
  const explodingRunner = Layer.succeed(CommandRunner, {
    run: () => Effect.die(new Error('CommandRunner must not be called in dry-run')),
  });

  it.effect('completes after preflight without invoking the runner', () =>
    Effect.gen(function* () {
      const dir = tmpBootstrap(true);
      const exit = yield* Effect.exit(
        up({
          bootstrapDir: dir,
          pulumiDir: '/repo/infra/pulumi',
          skipPulumi: true,
          readinessTimeoutSec: 600,
        }).pipe(Effect.provide(explodingRunner)),
      );
      assert.strictEqual(exit._tag, 'Success');
    }),
  );

  it.effect('missing creds in dry-run still exits via the H1 failure', () =>
    Effect.gen(function* () {
      const dir = tmpBootstrap(false);
      const exit = yield* Effect.exit(
        up({
          bootstrapDir: dir,
          pulumiDir: '/repo/infra/pulumi',
          skipPulumi: true,
          readinessTimeoutSec: 600,
        }).pipe(Effect.provide(explodingRunner)),
      );
      assert.isTrue(exit._tag === 'Failure');
    }),
  );
});
