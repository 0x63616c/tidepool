import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Data, Effect } from 'effect';

/**
 * Self-managed S3 state backend init — the one helper that makes the Pulumi
 * control plane's state bucket exist before `pulumi login`. Hetzner Object
 * Storage is plain S3 (path-style, custom endpoint), so this signs requests with
 * AWS SigV4 over `fetch` (HMAC/SHA-256 via `node:crypto`) rather than pulling an SDK.
 *
 * Deep module (tenet 4): the front is `ensureBucket` over a narrow `BucketStore`
 * port (head/create); SigV4 signing, the wire format, and Hetzner's endpoint all
 * stay hidden behind `makeBucketStore`. The bucket-init logic is therefore unit
 * testable against a fake store — no network, no real keys.
 *
 * Bootstrap creds live OUTSIDE git (tenet 9): `~/.tidepool/bootstrap/hetzner-s3.env`
 * holds `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `S3_ENDPOINT`.
 */

/** The Pulumi remote-state bucket (provisioned in nbg1; see `infra/pulumi`). */
export const PULUMI_STATE_BUCKET = 'tidepool-pulumi-state';

/** Default location of the bootstrap S3 credential env file (never committed). */
export const DEFAULT_S3_ENV_PATH = join(homedir(), '.tidepool', 'bootstrap', 'hetzner-s3.env');

/** S3 op failed (bad creds, network, unexpected status, missing env keys). */
export class ObjectStorageError extends Data.TaggedError('ObjectStorageError')<{
  readonly op: string;
  readonly reason: string;
}> {}

/** Resolved S3 credentials + endpoint for the self-managed Hetzner backend. */
export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** Base endpoint, e.g. `https://nbg1.your-objectstorage.com` (no bucket). */
  readonly endpoint: string;
}

/**
 * Narrow port over the two bucket-level wire ops the init helper needs. Hides
 * signing + transport so the orchestration is swappable and testable.
 */
export interface BucketStore {
  /** HeadBucket: `true` if the bucket exists + is reachable, `false` on 404. */
  readonly head: (bucket: string) => Effect.Effect<boolean, ObjectStorageError>;
  /** CreateBucket. Treated as idempotent (already-owned is not an error). */
  readonly create: (bucket: string) => Effect.Effect<void, ObjectStorageError>;
}

/**
 * Idempotent bucket init: HeadBucket → no-op if it already exists, else
 * CreateBucket. Returns whether a create actually happened, so callers can log
 * "already present" vs "provisioned" without a second round-trip.
 */
export const ensureBucket = Effect.fn('ensureBucket')(function* (
  store: BucketStore,
  bucket: string,
) {
  const exists = yield* store.head(bucket);
  if (exists) {
    return { bucket, created: false };
  }
  yield* store.create(bucket);
  return { bucket, created: true };
});

// ── Credential loading ────────────────────────────────────────────────────────

const stripQuotes = (value: string): string =>
  (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;

/** Parse a `KEY=value` env file (supports `export ` prefix, `#` comments, quotes). */
const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    out[line.slice(0, eq).trim()] = stripQuotes(line.slice(eq + 1).trim());
  }
  return out;
};

/**
 * Decode S3 credentials from raw env-file text. Pure (no fs) so the parse +
 * validation is directly testable; fails with a typed error naming the missing
 * key(s).
 */
export const parseS3Credentials = (
  text: string,
): Effect.Effect<S3Credentials, ObjectStorageError> =>
  Effect.gen(function* () {
    const env = parseEnvFile(text);
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    const region = env.AWS_REGION;
    const endpoint = env.S3_ENDPOINT;
    if (!accessKeyId || !secretAccessKey || !region || !endpoint) {
      const missing = (
        [
          ['AWS_ACCESS_KEY_ID', accessKeyId],
          ['AWS_SECRET_ACCESS_KEY', secretAccessKey],
          ['AWS_REGION', region],
          ['S3_ENDPOINT', endpoint],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k);
      return yield* Effect.fail(
        new ObjectStorageError({
          op: 'parseCredentials',
          reason: `missing required key(s): ${missing.join(', ')}`,
        }),
      );
    }
    return { accessKeyId, secretAccessKey, region, endpoint: endpoint.replace(/\/+$/, '') };
  });

/** Read + decode S3 credentials from the bootstrap env file (default path). */
export const readS3Credentials = (
  path: string = DEFAULT_S3_ENV_PATH,
): Effect.Effect<S3Credentials, ObjectStorageError> =>
  Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (e) => new ObjectStorageError({ op: 'readCredentials', reason: String(e) }),
  }).pipe(Effect.flatMap(parseS3Credentials));

// ── AWS SigV4 signer (S3, path-style, empty payload) ──────────────────────────

/** SHA-256 of the empty string — the payload hash for body-less HEAD/PUT. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** `{ amzDate: YYYYMMDDTHHMMSSZ, dateStamp: YYYYMMDD }` from a Date. */
const amzDates = (now: Date): { readonly amzDate: string; readonly dateStamp: string } => {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

const signingKey = (secret: string, dateStamp: string, region: string, service: string): Buffer => {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
};

/** Issue a SigV4-signed, body-less request to `<endpoint>/<bucket>` (path-style). */
const signedBucketRequest = (
  creds: S3Credentials,
  method: 'HEAD' | 'PUT',
  bucket: string,
): Promise<Response> => {
  const url = new URL(`${creds.endpoint}/${bucket}`);
  const { host } = url;
  const { amzDate, dateStamp } = amzDates(new Date());
  const service = 's3';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256,
  ].join('\n');
  const scope = `${dateStamp}/${creds.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(creds.secretAccessKey, dateStamp, creds.region, service),
    stringToSign,
  ).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url, {
    method,
    headers: {
      authorization,
      'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
      'x-amz-date': amzDate,
    },
  });
};

/**
 * Build the real `BucketStore` backed by SigV4-signed `fetch` against the
 * Hetzner S3 endpoint. The network/signing details never leak past this seam.
 */
export const makeBucketStore = (creds: S3Credentials): BucketStore => ({
  head: (bucket) =>
    Effect.tryPromise({
      try: async () => {
        const res = await signedBucketRequest(creds, 'HEAD', bucket);
        if (res.status === 200) {
          return true;
        }
        if (res.status === 404) {
          return false;
        }
        throw new Error(`HeadBucket ${bucket} → HTTP ${res.status}`);
      },
      catch: (e) => new ObjectStorageError({ op: 'headBucket', reason: String(e) }),
    }),
  create: (bucket) =>
    Effect.tryPromise({
      try: async () => {
        const res = await signedBucketRequest(creds, 'PUT', bucket);
        // 409 = BucketAlreadyOwnedByYou — a concurrent create won; still our bucket.
        if (!res.ok && res.status !== 409) {
          throw new Error(`CreateBucket ${bucket} → HTTP ${res.status}`);
        }
      },
      catch: (e) => new ObjectStorageError({ op: 'createBucket', reason: String(e) }),
    }),
});

/**
 * End-to-end convenience: read bootstrap creds, then idempotently ensure the
 * given bucket exists. Defaults to the Pulumi state bucket.
 */
export const initStateBucket = (
  bucket: string = PULUMI_STATE_BUCKET,
  credsPath: string = DEFAULT_S3_ENV_PATH,
): Effect.Effect<{ readonly bucket: string; readonly created: boolean }, ObjectStorageError> =>
  readS3Credentials(credsPath).pipe(
    Effect.map(makeBucketStore),
    Effect.flatMap((store) => ensureBucket(store, bucket)),
  );
