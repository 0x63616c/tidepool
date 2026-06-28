import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  type BucketStore,
  ensureBucket,
  ObjectStorageError,
  parseS3Credentials,
} from './object-storage.ts';

/**
 * A fake `BucketStore` backed by an in-memory set of existing buckets, recording
 * every head/create call. Lets the idempotency contract be asserted without
 * SigV4, network, or real keys — the seam `makeBucketStore` hides.
 */
const fakeBucketStore = (existing: ReadonlyArray<string> = []) => {
  const buckets = new Set(existing);
  const calls: string[] = [];
  const store: BucketStore = {
    head: (bucket) =>
      Effect.sync(() => {
        calls.push(`head:${bucket}`);
        return buckets.has(bucket);
      }),
    create: (bucket) =>
      Effect.sync(() => {
        calls.push(`create:${bucket}`);
        buckets.add(bucket);
      }),
  };
  return { store, calls, buckets };
};

describe('ensureBucket', () => {
  it.effect('is a no-op when the bucket already exists (HeadBucket hit)', () =>
    Effect.gen(function* () {
      const { store, calls } = fakeBucketStore(['tidepool-pulumi-state']);
      const result = yield* ensureBucket(store, 'tidepool-pulumi-state');
      assert.deepStrictEqual(result, { bucket: 'tidepool-pulumi-state', created: false });
      assert.deepStrictEqual(calls, ['head:tidepool-pulumi-state']);
    }),
  );

  it.effect('creates the bucket when HeadBucket reports it absent', () =>
    Effect.gen(function* () {
      const { store, calls, buckets } = fakeBucketStore([]);
      const result = yield* ensureBucket(store, 'tidepool-pulumi-state');
      assert.deepStrictEqual(result, { bucket: 'tidepool-pulumi-state', created: true });
      assert.deepStrictEqual(calls, ['head:tidepool-pulumi-state', 'create:tidepool-pulumi-state']);
      assert.isTrue(buckets.has('tidepool-pulumi-state'));
    }),
  );

  it.effect('is idempotent: a second ensure on the now-existing bucket no-ops', () =>
    Effect.gen(function* () {
      const { store, calls } = fakeBucketStore([]);
      const first = yield* ensureBucket(store, 'tidepool-pulumi-state');
      const second = yield* ensureBucket(store, 'tidepool-pulumi-state');
      assert.strictEqual(first.created, true);
      assert.strictEqual(second.created, false);
      // Exactly one create across both calls — never recreates an existing bucket.
      assert.strictEqual(calls.filter((c) => c.startsWith('create:')).length, 1);
    }),
  );

  it.effect('propagates a typed ObjectStorageError from HeadBucket', () =>
    Effect.gen(function* () {
      const failing: BucketStore = {
        head: () => Effect.fail(new ObjectStorageError({ op: 'headBucket', reason: 'HTTP 500' })),
        create: () => Effect.void,
      };
      const exit = yield* Effect.exit(ensureBucket(failing, 'tidepool-pulumi-state'));
      assert.isTrue(
        exit._tag === 'Failure' &&
          exit.cause._tag === 'Fail' &&
          exit.cause.error._tag === 'ObjectStorageError',
      );
    }),
  );
});

describe('parseS3Credentials', () => {
  it.effect('parses a valid env file (export prefix, quotes, trailing slash)', () =>
    Effect.gen(function* () {
      const creds = yield* parseS3Credentials(
        [
          '# Hetzner Object Storage creds',
          'export AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
          "AWS_SECRET_ACCESS_KEY='s3cr3t/value'",
          'AWS_REGION=nbg1',
          'S3_ENDPOINT="https://nbg1.your-objectstorage.com/"',
          '',
        ].join('\n'),
      );
      assert.deepStrictEqual(creds, {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 's3cr3t/value',
        region: 'nbg1',
        endpoint: 'https://nbg1.your-objectstorage.com',
      });
    }),
  );

  it.effect('fails with a typed error naming the missing key', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        parseS3Credentials('AWS_ACCESS_KEY_ID=AKIA\nAWS_REGION=nbg1\n'),
      );
      assert.isTrue(
        exit._tag === 'Failure' &&
          exit.cause._tag === 'Fail' &&
          exit.cause.error._tag === 'ObjectStorageError' &&
          exit.cause.error.reason.includes('AWS_SECRET_ACCESS_KEY') &&
          exit.cause.error.reason.includes('S3_ENDPOINT'),
      );
    }),
  );
});
