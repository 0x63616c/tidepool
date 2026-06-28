import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Console, Context, Data, Duration, Effect, Layer, Schedule, Schema } from 'effect';
import {
  ensureBucket,
  makeBucketStore,
  type ObjectStorageError,
  PULUMI_STATE_BUCKET,
  parseS3Credentials,
  type S3Credentials,
} from './object-storage.ts';

/**
 * `tp up` — the one-shot, idempotent bring-up orchestrator for the control-plane
 * (MAIN) box. It wires the human-only bootstrap inputs (S3 creds, Hetzner token,
 * sops passphrase) into a `pulumi up`, then waits for the box to come alive.
 *
 * Deep module (tenet 4): the front is `up(options)`; SigV4/bucket init, the
 * pulumi child-process protocol, the capacity fallback walk, and the SSH
 * readiness probe all stay hidden. Side-effecting work goes through the narrow
 * `CommandRunner` port so the orchestration is unit-testable WITHOUT provisioning
 * (the dry-run path never touches the runner at all).
 *
 * Two human gates frame the automation, surfaced as printed steps:
 *   H1 — create the Hetzner Object Storage S3 credentials (preflight requires them).
 *   H2 — SCP the age master key to the freshly-provisioned box (secrets stay home,
 *        tenet 9: the key is delivered out-of-band, never baked into the image).
 */

// ── Errors ────────────────────────────────────────────────────────────────────

/** Bring-up failed at a named stage; `message` is the agent-facing explanation. */
export class UpError extends Data.TaggedError('UpError')<{
  readonly stage: string;
  readonly message: string;
}> {}

// ── Bootstrap layout (lives OUTSIDE git — tenet 9) ──────────────────────────────

/** Default bootstrap dir holding the human-only inputs (never committed). */
export const DEFAULT_BOOTSTRAP_DIR = join(homedir(), '.tidepool', 'bootstrap');

/** On-box destination for the age master key (the systemd unit's guard path). */
export const AGE_KEY_ON_BOX = '/root/.tidepool/bootstrap/age-mainbox.key';

export interface BootstrapPaths {
  readonly dir: string;
  /** `hetzner-s3.env` — AWS_* creds for the self-managed S3 state backend. */
  readonly s3Env: string;
  /** `hcloud_token` — Hetzner Cloud API token for the provider. */
  readonly hcloudToken: string;
  /** `age-mainbox.key` — the master key delivered to the box in H2. */
  readonly ageKey: string;
}

/** Resolve the bootstrap file layout under `dir` (defaults to `~/.tidepool/bootstrap`). */
export const bootstrapPaths = (dir: string = DEFAULT_BOOTSTRAP_DIR): BootstrapPaths => ({
  dir,
  s3Env: join(dir, 'hetzner-s3.env'),
  hcloudToken: join(dir, 'hcloud_token'),
  ageKey: join(dir, 'age-mainbox.key'),
});

/** Collapse the user's home prefix to `~` for readable printed paths. */
const tildeify = (path: string): string => {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};

// ── H1 / H2 human steps ─────────────────────────────────────────────────────

/** The one-time human step printed when the S3 bootstrap creds are absent. */
export const h1Instructions = (paths: BootstrapPaths): string =>
  [
    'error: missing Hetzner S3 bootstrap credentials',
    `  expected: ${tildeify(paths.s3Env)}`,
    'H1 (one-time, human): create the Hetzner Object Storage S3 credentials',
    '  1. Hetzner Cloud Console → your project → Object Storage → create a bucket in nbg1',
    '  2. Generate an S3 access key + secret key for that project',
    `  3. Write ${tildeify(paths.s3Env)} with:`,
    '       AWS_ACCESS_KEY_ID=<access key>',
    '       AWS_SECRET_ACCESS_KEY=<secret key>',
    '       AWS_REGION=nbg1',
    '       S3_ENDPOINT=https://nbg1.your-objectstorage.com',
    '  4. Re-run `tp up`',
  ].join('\n');

/** The exact SCP command the operator runs in H2 to deliver the age master key. */
export const h2ScpCommand = (ip: string, paths: BootstrapPaths): string =>
  `scp ${tildeify(paths.ageKey)} root@${ip}:${AGE_KEY_ON_BOX}`;

/** The full H2 block: deliver the key, then the box's systemd unit activates. */
const h2Step = (ip: string, paths: BootstrapPaths): string =>
  [
    `H2 (human): deliver the age master key to the box (${ip}) — secrets stay home`,
    `  ${h2ScpCommand(ip, paths)}`,
    '  The control-plane systemd unit is inert until this key is present, then starts.',
  ].join('\n');

// ── Control-box capacity fallback ────────────────────────────────────────────

/**
 * Cheap-first control-box fallback chain (all x86, all under €30/mo). cx23 is the
 * primary (€6.49, Intel 2c/4GB); cpx21 is the reliable AMD second because Intel
 * `cx` stock is the type most likely to be capacity-blocked in a region.
 */
export const CONTROL_BOX_TYPES = ['cx23', 'cpx21', 'cx33', 'cpx31'] as const;

/** Location fallback (all eu-central, so the shared private network still reaches). */
export const CONTROL_BOX_LOCATIONS = ['nbg1', 'hel1', 'fsn1'] as const;

export interface BoxAttempt {
  readonly type: string;
  readonly location: string;
}

/**
 * The ordered provisioning attempts: stay in a location and walk the type chain
 * before moving location (a location move drags the durable volume, so it's the
 * last resort). First attempt is always the cheap primary cx23@nbg1.
 */
export const boxAttemptPlan = (): ReadonlyArray<BoxAttempt> =>
  CONTROL_BOX_LOCATIONS.flatMap((location) =>
    CONTROL_BOX_TYPES.map((type) => ({ type, location })),
  );

/** Heuristic: does this pulumi/Hetzner error mean "no stock for that type/region"? */
export const isCapacityError = (text: string): boolean =>
  /resource_unavailable|resource unavailable|no available|capacity|out of stock|unavailable in|insufficient/i.test(
    text,
  );

// ── SSH readiness probe (control box, host-key hardened) ────────────────────

const SSH_OPTS = [
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
] as const;

/** `ssh` argv to run `cmd` on `root@ip`; `cmd` is the single trailing arg. */
export const sshArgv = (ip: string, cmd: string): ReadonlyArray<string> => [
  ...SSH_OPTS,
  `root@${ip}`,
  cmd,
];

/**
 * One remote line probing all three readiness signals at once: cloud-init phase,
 * the age key's presence, and the control-plane unit's activeness. Emitted in a
 * stable `k=v` shape so `parseReadiness` can decide without re-running anything.
 */
export const READINESS_PROBE =
  "printf 'cloud_init=%s age_key=%s tidepool=%s\\n' " +
  `"$(cloud-init status 2>/dev/null | sed -n 's/.*status: //p')" ` +
  `"$(test -f ${AGE_KEY_ON_BOX} && echo present || echo missing)" ` +
  '"$(systemctl is-active tidepool 2>/dev/null || true)"';

export interface Readiness {
  readonly cloudInit: string;
  readonly ageKey: string;
  readonly tidepool: string;
  readonly ready: boolean;
}

const field = (text: string, key: string): string =>
  text.match(new RegExp(`${key}=(\\S*)`))?.[1] ?? '';

/** Decode the probe line; ready ⇔ cloud-init done, key present, unit active. */
export const parseReadiness = (stdout: string): Readiness => {
  const cloudInit = field(stdout, 'cloud_init');
  const ageKey = field(stdout, 'age_key');
  const tidepool = field(stdout, 'tidepool');
  return {
    cloudInit,
    ageKey,
    tidepool,
    ready: cloudInit === 'done' && ageKey === 'present' && tidepool === 'active',
  };
};

// ── CommandRunner: the narrow child-process port (injectable, mockable) ──────

export interface CommandRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Extra env merged over the parent process env for this child only. */
  readonly env?: Record<string, string>;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunnerApi {
  /** Spawn a child to completion. Non-zero exit is a RESULT, not a failure, so the
   *  caller can inspect stderr (e.g. for capacity errors) and decide. */
  readonly run: (req: CommandRequest) => Effect.Effect<CommandResult, UpError>;
}

export class CommandRunner extends Context.Tag('CommandRunner')<
  CommandRunner,
  CommandRunnerApi
>() {}

/** Real runner backed by `Bun.spawn` (the codebase's subprocess idiom). */
export const BunCommandRunner: Layer.Layer<CommandRunner> = Layer.succeed(CommandRunner, {
  run: (req) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn([req.command, ...req.args], {
          cwd: req.cwd,
          env: req.env === undefined ? process.env : { ...process.env, ...req.env },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { stdout, stderr, exitCode };
      },
      catch: (e) => new UpError({ stage: 'spawn', message: `cannot run ${req.command}: ${e}` }),
    }),
});

// ── Pulumi backend wiring ─────────────────────────────────────────────────────

/** Host (no scheme) for the S3 backend endpoint, e.g. `nbg1.your-objectstorage.com`. */
const endpointHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.replace(/^https?:\/\//, '');
  }
};

/** The `pulumi login` URL for the self-managed S3 state backend (path-style). */
export const pulumiLoginUrl = (bucket: string, endpoint: string): string =>
  `s3://${bucket}?endpoint=${endpointHost(endpoint)}&s3ForcePathStyle=true`;

/** Stack outputs the bring-up consumes — decoded, never `as`-cast. */
const StackOutputs = Schema.Struct({
  mainBoxIpv4: Schema.String,
  stateVolumeId: Schema.Union(Schema.String, Schema.Number),
});
const decodeStackOutputs = Schema.decodeUnknown(Schema.parseJson(StackOutputs));

// ── Credential loading ───────────────────────────────────────────────────────

const readText = (path: string, stage: string): Effect.Effect<string, UpError> =>
  Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (e) => new UpError({ stage, message: `cannot read ${tildeify(path)}: ${e}` }),
  });

const loadS3Credentials = (paths: BootstrapPaths): Effect.Effect<S3Credentials, UpError> =>
  readText(paths.s3Env, 's3-creds').pipe(
    Effect.flatMap((text) =>
      parseS3Credentials(text).pipe(
        Effect.mapError((e) => new UpError({ stage: 's3-creds', message: e.reason })),
      ),
    ),
  );

/**
 * Resolve PULUMI_CONFIG_PASSPHRASE: prefer the sops bundle key `pulumi_passphrase`
 * (secrets stay in sops, tenet 1); fall back to the env var when that key is
 * absent. Fails only when neither yields a value.
 */
const resolvePassphrase = (sopsFile: string): Effect.Effect<string, UpError, CommandRunner> =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const fromSops = yield* runner
      .run({ command: 'sops', args: ['-d', '--extract', '["pulumi_passphrase"]', sopsFile] })
      .pipe(
        Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() : '')),
        Effect.catchAll(() => Effect.succeed('')),
      );
    if (fromSops.length > 0) return fromSops;
    const fromEnv = process.env.PULUMI_CONFIG_PASSPHRASE ?? '';
    if (fromEnv.length > 0) return fromEnv;
    return yield* Effect.fail(
      new UpError({
        stage: 'passphrase',
        message:
          'PULUMI_CONFIG_PASSPHRASE unresolved: no `pulumi_passphrase` in sops and the env var is unset',
      }),
    );
  });

// ── Preflight ─────────────────────────────────────────────────────────────────

/** Gate the bring-up on the H1 inputs existing; fail with the H1 steps otherwise. */
export const preflight = (paths: BootstrapPaths): Effect.Effect<void, UpError> =>
  existsSync(paths.s3Env)
    ? Effect.void
    : Effect.fail(new UpError({ stage: 'preflight', message: h1Instructions(paths) }));

// ── Bucket init (idempotent, reuses the object-storage seam) ─────────────────

/** Ensure the Pulumi state bucket exists, reusing the SigV4 `BucketStore` seam. */
export const ensureStateBucket = (
  creds: S3Credentials,
  bucket: string = PULUMI_STATE_BUCKET,
): Effect.Effect<{ readonly bucket: string; readonly created: boolean }, ObjectStorageError> =>
  ensureBucket(makeBucketStore(creds), bucket);

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface UpOptions {
  /** Bootstrap dir (defaults to `~/.tidepool/bootstrap`). */
  readonly bootstrapDir: string;
  /** Working dir for the pulumi program (the node package under `infra/pulumi`). */
  readonly pulumiDir: string;
  /** Dry-run: validate inputs + print the plan, but provision nothing. */
  readonly skipPulumi: boolean;
  /** Max seconds to wait for the box to report ready over SSH. */
  readinessTimeoutSec: number;
}

/** Run pulumi with the wired backend env in the pulumi package dir. */
const pulumi = (
  runner: CommandRunnerApi,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  cwd: string,
): Effect.Effect<CommandResult, UpError> => runner.run({ command: 'pulumi', args, cwd, env });

/** Walk the capacity fallback chain: stop at the first type/location that provisions. */
const provision = (
  runner: CommandRunnerApi,
  env: Record<string, string>,
  cwd: string,
): Effect.Effect<BoxAttempt, UpError> =>
  Effect.gen(function* () {
    for (const attempt of boxAttemptPlan()) {
      yield* Console.log(`up: provisioning control box ${attempt.type} @ ${attempt.location}`);
      yield* pulumi(runner, ['config', 'set', 'tp:controlBoxType', attempt.type], env, cwd);
      yield* pulumi(runner, ['config', 'set', 'tp:controlBoxLocation', attempt.location], env, cwd);
      const res = yield* pulumi(runner, ['up', '--yes'], env, cwd);
      if (res.exitCode === 0) {
        yield* Console.log(`up: won — provisioned ${attempt.type} @ ${attempt.location}`);
        return attempt;
      }
      const diag = `${res.stderr}\n${res.stdout}`;
      if (!isCapacityError(diag)) {
        return yield* Effect.fail(
          new UpError({ stage: 'pulumi-up', message: diag.trim().slice(0, 800) }),
        );
      }
      yield* Console.log(
        `up: no capacity for ${attempt.type} @ ${attempt.location} — trying next in the chain`,
      );
    }
    return yield* Effect.fail(
      new UpError({
        stage: 'pulumi-up',
        message: 'no capacity across every control-box type/location fallback',
      }),
    );
  });

/** Poll the box over SSH until ready or the timeout; prints each probe's status. */
const awaitReady = (
  runner: CommandRunnerApi,
  ip: string,
  timeoutSec: number,
): Effect.Effect<void, UpError> =>
  runner.run({ command: 'ssh', args: [...sshArgv(ip, READINESS_PROBE)] }).pipe(
    Effect.map((r) => parseReadiness(r.stdout)),
    Effect.tap((s) =>
      Console.log(
        `up: readiness cloud_init=${s.cloudInit || '-'} age_key=${s.ageKey || '-'} tidepool=${s.tidepool || '-'}`,
      ),
    ),
    Effect.flatMap((s) =>
      s.ready
        ? Effect.void
        : Effect.fail(new UpError({ stage: 'readiness', message: 'box not ready yet' })),
    ),
    Effect.retry(Schedule.spaced(Duration.seconds(10))),
    Effect.timeoutFail({
      duration: Duration.seconds(timeoutSec),
      onTimeout: () =>
        new UpError({
          stage: 'readiness',
          message: `control box ${ip} did not report ready within ${timeoutSec}s — check H2 (age key delivered?) and \`systemctl status tidepool\` on the box`,
        }),
    }),
  );

/**
 * The bring-up. Idempotent end to end: re-running ensures the bucket, re-selects
 * the stack, and `pulumi up` reconciles to the same declared state. `--skip-pulumi`
 * short-circuits after preflight, printing the plan + H2 template without touching
 * the network — that's the unit-test / inspection path.
 */
export const up = (options: UpOptions): Effect.Effect<void, UpError, CommandRunner> =>
  Effect.gen(function* () {
    const paths = bootstrapPaths(options.bootstrapDir);

    // (a) Preflight — H1 inputs must exist.
    yield* preflight(paths);
    yield* Console.log(`up: preflight ok — found ${tildeify(paths.s3Env)}`);

    if (options.skipPulumi) {
      const url = pulumiLoginUrl(PULUMI_STATE_BUCKET, 'https://nbg1.your-objectstorage.com');
      yield* Console.log(
        [
          'up: dry-run (--skip-pulumi) — no bucket / pulumi / ssh side effects',
          'plan[5]:',
          `  1. ensureBucket ${PULUMI_STATE_BUCKET} (idempotent, SigV4 over the bootstrap S3 creds)`,
          `  2. pulumi login ${url}`,
          '  3. pulumi stack select main --create',
          `  4. pulumi up --yes  (cwd ${tildeify(options.pulumiDir)}; capacity chain ${CONTROL_BOX_TYPES.join(' → ')})`,
          '  5. poll readiness over SSH (cloud-init done + age key present + tidepool active)',
          h2Step('<ip>', paths),
        ].join('\n'),
      );
      return;
    }

    const runner = yield* CommandRunner;
    const creds = yield* loadS3Credentials(paths);

    // (b) Ensure the Pulumi state bucket (idempotent).
    const bucket = yield* ensureStateBucket(creds).pipe(
      Effect.mapError((e) => new UpError({ stage: 'bucket', message: `${e.op}: ${e.reason}` })),
    );
    yield* Console.log(
      `up: state bucket ${bucket.bucket} ${bucket.created ? 'created' : 'already present'}`,
    );

    // (c) Assemble the pulumi backend env from bootstrap + sops.
    const hcloudToken = yield* readText(paths.hcloudToken, 'hcloud-token').pipe(
      Effect.map((t) => t.trim()),
    );
    const sopsFile = join(options.pulumiDir, '..', '..', 'secrets', 'tidepool.enc.yaml');
    const passphrase = yield* resolvePassphrase(sopsFile);
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_REGION: creds.region,
      HCLOUD_TOKEN: hcloudToken,
      PULUMI_CONFIG_PASSPHRASE: passphrase,
    };

    // (d) Drive pulumi: login → select stack → up (with capacity fallback).
    yield* pulumi(
      runner,
      ['login', pulumiLoginUrl(bucket.bucket, creds.endpoint)],
      env,
      options.pulumiDir,
    ).pipe(
      Effect.flatMap((r) =>
        r.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new UpError({ stage: 'pulumi-login', message: r.stderr.trim().slice(0, 500) }),
            ),
      ),
    );
    yield* pulumi(runner, ['stack', 'select', 'main', '--create'], env, options.pulumiDir).pipe(
      Effect.flatMap((r) =>
        r.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new UpError({ stage: 'pulumi-stack', message: r.stderr.trim().slice(0, 500) }),
            ),
      ),
    );
    yield* provision(runner, env, options.pulumiDir);

    // Capture stack outputs (box IP + volume id).
    const outRes = yield* pulumi(runner, ['stack', 'output', '--json'], env, options.pulumiDir);
    const outputs = yield* decodeStackOutputs(outRes.stdout).pipe(
      Effect.mapError(
        (e) => new UpError({ stage: 'stack-output', message: `unparseable stack outputs: ${e}` }),
      ),
    );
    yield* Console.log(
      `up: stack outputs ip=${outputs.mainBoxIpv4} volume=${String(outputs.stateVolumeId)}`,
    );

    // (e) H2 — print the SCP step with the REAL box IP.
    yield* Console.log(h2Step(outputs.mainBoxIpv4, paths));

    // (f) Poll readiness until the box is fully alive.
    yield* awaitReady(runner, outputs.mainBoxIpv4, options.readinessTimeoutSec);
    yield* Console.log(`up: control box ${outputs.mainBoxIpv4} is ready`);
  });
