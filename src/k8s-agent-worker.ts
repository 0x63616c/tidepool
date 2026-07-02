import { HttpBody, HttpClient, type HttpClientError } from '@effect/platform';
import { Context, Effect, Layer, Schema } from 'effect';
import {
  commitMessage,
  fetchPrDiff,
  parseVerdict,
  reviewPrompt,
  workBody,
  workPrompt,
  workTitle,
} from './agent-runner.ts';
import { AgentFailed, makeWorkHandle, RateCapped, type WorkHandle } from './domain.ts';
import {
  AgentWorker,
  CredentialBroker,
  type DispatchInput,
  DispatchOutcome,
  type WorkerCredentials,
  WorkStatus,
} from './services.ts';
import { type AgentWorkerConfig, ReviewRunnerResult, RunnerResult } from './worker/protocol.ts';

/**
 * `K8sAgentWorker` — the out-of-band `AgentWorker` (tenet 4 swap of the sync
 * `LocalAgentWorker`). `dispatch` POSTs a Kubernetes `Job` (+ a per-Job `Secret`
 * carrying the broker's creds) into the `agents` namespace and returns
 * the Job name as the durable `WorkHandle`; `poll` reads Job status and, on
 * success, harvests the pod's final stdout line (the existing `RunnerResult` —
 * no new channel). Because the handle is just the Job name, poll works after a
 * control-plane restart with no in-memory state (unlike `LocalAgentWorker`).
 *
 * Only the k8s REST surface it needs is used, all over the one HTTP layer
 * (`@effect/platform`, tenet 10). k8s API auth is abstracted behind
 * `K8sWorkerConfig` (base URL + bearer + CA): in-cluster is SA token + CA under
 * `/var/run/secrets/kubernetes.io/serviceaccount` (wired at PR-6), kind/CI is a
 * kubeconfig-derived endpoint. This Layer is provided, NOT prod-wired — the live
 * path stays `LocalAgentWorker` until cutover.
 */

// ── Config ───────────────────────────────────────────────────────────────────

export interface K8sWorkerConfig {
  /** k8s API server base, e.g. `https://kubernetes.default.svc` or a proxy URL. */
  readonly apiBaseUrl: string;
  /** Bearer token for the API. May be empty (e.g. against `kubectl proxy`). */
  readonly token: string;
  /** Namespace the worker Jobs live in. */
  readonly namespace: string;
  /** agent-worker container image (registry ref + tag), by config. */
  readonly image: string;
  /**
   * Override the container command (else the image ENTRYPOINT runs). The prod
   * agent-worker image declares a RELATIVE entrypoint (`src/worker/agent-worker.ts`
   * under /app), but the Job sets workingDir to the /work workspace — so a relative
   * entrypoint resolves to /work/src/... and fails `Module not found`. Prod sets an
   * absolute command here; the kind-e2e stub omits it to keep its own entrypoint.
   */
  readonly command?: ReadonlyArray<string>;
  /** CPU request; NO cpu limit is set (bursty agents, tenet-6 blast control). */
  readonly cpuRequest: string;
  /** Memory request == limit (hard OOM cap). */
  readonly memRequest: string;
  /** Job `activeDeadlineSeconds` — hard wall-clock kill. */
  readonly activeDeadlineSeconds: number;
  /** Job `ttlSecondsAfterFinished` — auto-reap finished Jobs (+ owned Secrets). */
  readonly ttlSecondsAfterFinished: number;
  /**
   * Git commit the dispatching reconciler was built from (its own `TIDEPOOL_GIT_SHA`
   * env, `dev` locally). Stamped as `tidepool/git-sha` on every worker pod so
   * `kubectl get pods -L tidepool/git-sha` maps a pod → its dispatching commit.
   */
  readonly gitSha: string;
}

/** DI tag for the k8s connection/shape config. */
export class K8sConfig extends Context.Tag('K8sWorkerConfig')<K8sConfig, K8sWorkerConfig>() {}

/** Provide a concrete `K8sWorkerConfig` (tests, kind CI, PR-6 in-cluster boot). */
export const k8sWorkerConfigLayer = (config: K8sWorkerConfig): Layer.Layer<K8sConfig> =>
  Layer.succeed(K8sConfig, config);

// ── Naming ───────────────────────────────────────────────────────────────────

const PART_OF = 'app.kubernetes.io/part-of';
/**
 * Provenance label: the commit the dispatching reconciler was built from. Same key
 * the control-plane Deployment stamps (guards.ts `GIT_SHA_LABEL`), duplicated here
 * because src/ must not import across the infra/pulumi seam — the two sides share
 * only the string, exactly like the `tidepool/role` keys already do.
 */
const GIT_SHA_LABEL = 'tidepool/git-sha';
// The Job's ephemeral workspace: the repo is cloned here and config.json is
// mounted here, so the container runs with this as its cwd.
const WORKDIR = '/work';

/** Coerce an arbitrary id into a DNS-1123 label fragment (`_`→`-`, lowercased). */
export const k8sName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The Job name AND `WorkHandle`: `<kind>-<ticket>-<suffix>`. The ticket id's
 * sops-style `_` is not DNS-1123-legal, so it is sanitized; the raw id is still
 * carried verbatim on the `tidepool/ticket` label (where `_` is allowed).
 */
export const workHandleFor = (kind: 'work' | 'review', ticketId: string, suffix: string): string =>
  `${kind}-${k8sName(ticketId)}-${k8sName(suffix)}`.slice(0, 63).replace(/-+$/g, '');

const jobLabels = (
  kind: 'work' | 'review',
  ticketId: string,
  gitSha: string,
): Record<string, string> => ({
  [PART_OF]: 'tidepool',
  'tidepool/role': 'agent',
  'tidepool/kind': kind,
  'tidepool/ticket': ticketId,
  [GIT_SHA_LABEL]: gitSha,
});

/** Label selector matching every agent Job (for `reap`). */
export const AGENT_SELECTOR = `${PART_OF}=tidepool,tidepool/role=agent`;

// ── Manifest builders (pure) ─────────────────────────────────────────────────

/**
 * The `config.json` the worker container reads. Mirrors the SSH runner's config
 * exactly (single source: same prompt/title/commit builders) so work runs are
 * transport-independent. The work clone URL embeds the broker's GitHub token; the
 * review prompt embeds the pre-fetched diff (worker needs no clone/`gh`).
 */
export const buildAgentWorkerConfig = (
  input: DispatchInput,
  creds: WorkerCredentials,
  diff = '',
): AgentWorkerConfig =>
  input.kind === 'work'
    ? {
        kind: 'work',
        cloneUrl: `https://x-access-token:${creds.githubToken}@github.com/${input.repo}.git`,
        base: input.base,
        branch: input.branch,
        dir: `${WORKDIR}/work-${input.ticket.id}`,
        model: input.model,
        prompt: workPrompt(input.ticket),
        commitMsg: commitMessage(input.ticket),
      }
    : {
        kind: 'review',
        dir: `${WORKDIR}/review-${input.ticket.id}`,
        model: input.model,
        prompt: reviewPrompt(input.ticket, diff),
      };

/** Title/body annotations so `poll` can rebuild `WorkResult` after a restart. */
const workAnnotations = (input: DispatchInput): Record<string, string> =>
  input.kind === 'work'
    ? { 'tidepool/pr-title': workTitle(input.ticket), 'tidepool/pr-body': workBody(input.ticket) }
    : {};

interface VolumeMount {
  readonly name: string;
  readonly mountPath: string;
  readonly subPath: string;
  readonly readOnly: boolean;
}

/** Typed Job manifest — encodes the invariants (no cpu limit) in the type. */
export interface JobManifest {
  readonly apiVersion: 'batch/v1';
  readonly kind: 'Job';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Record<string, string>;
    readonly annotations: Record<string, string>;
  };
  readonly spec: {
    readonly backoffLimit: number;
    readonly activeDeadlineSeconds: number;
    readonly ttlSecondsAfterFinished: number;
    readonly template: {
      readonly metadata: { readonly labels: Record<string, string> };
      readonly spec: {
        readonly restartPolicy: 'Never';
        readonly containers: ReadonlyArray<{
          readonly name: string;
          readonly image: string;
          readonly command?: ReadonlyArray<string>;
          readonly workingDir: string;
          // TIDEPOOL_GIT_SHA (tckt_shaenv0dev) traces a pod back to its commit;
          // TIDEPOOL_RUN_ID (tckt_4utv62nij6) is the correlation id — same value
          // as the Job's own name (`handle`) — so the worker's own logs carry
          // the same runId the reconciler's dispatch log does (run-id.ts).
          readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
          readonly resources: {
            readonly requests: { readonly cpu: string; readonly memory: string };
            // No cpu limit by design (agents burst); `cpu?: never` documents it.
            readonly limits: { readonly memory: string; readonly cpu?: never };
          };
          readonly volumeMounts: ReadonlyArray<VolumeMount>;
        }>;
        readonly volumes: ReadonlyArray<{
          readonly name: string;
          readonly secret: { readonly secretName: string; readonly defaultMode: number };
        }>;
      };
    };
  };
}

/** Typed per-Job Secret manifest. */
export interface SecretManifest {
  readonly apiVersion: 'v1';
  readonly kind: 'Secret';
  readonly type: 'Opaque';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Record<string, string>;
    readonly ownerReferences: ReadonlyArray<{
      readonly apiVersion: string;
      readonly kind: string;
      readonly name: string;
      readonly uid: string;
      readonly controller: boolean;
      readonly blockOwnerDeletion: boolean;
    }>;
  };
  readonly stringData: { readonly 'config.json': string; readonly 'auth.json': string };
}

/** The namespaced `batch/v1` Job manifest. */
export const buildJobManifest = (args: {
  readonly handle: string;
  readonly config: K8sWorkerConfig;
  readonly input: DispatchInput;
  readonly annotations?: Record<string, string>;
}): JobManifest => {
  const { handle, config, input } = args;
  const labels = jobLabels(input.kind, input.ticket.id, config.gitSha);
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: handle,
      namespace: config.namespace,
      labels,
      annotations: args.annotations ?? {},
    },
    spec: {
      // No agent is ever retried by k8s: a failed attempt is the reconciler's call.
      backoffLimit: 0,
      activeDeadlineSeconds: config.activeDeadlineSeconds,
      ttlSecondsAfterFinished: config.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'agent',
              image: config.image,
              // Only override when config provides one; else the image ENTRYPOINT runs.
              ...(config.command ? { command: config.command } : {}),
              workingDir: WORKDIR,
              env: [
                { name: 'TIDEPOOL_GIT_SHA', value: config.gitSha },
                { name: 'TIDEPOOL_RUN_ID', value: handle },
              ],
              resources: {
                // CPU request but NO cpu limit (agents burst); mem request==limit.
                requests: { cpu: config.cpuRequest, memory: config.memRequest },
                limits: { memory: config.memRequest },
              },
              volumeMounts: [
                {
                  name: 'creds',
                  mountPath: '/secrets/auth.json',
                  subPath: 'auth.json',
                  readOnly: true,
                },
                {
                  name: 'creds',
                  mountPath: `${WORKDIR}/config.json`,
                  subPath: 'config.json',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [{ name: 'creds', secret: { secretName: handle, defaultMode: 0o400 } }],
        },
      },
    },
  };
};

/**
 * The per-Job `Secret` (auth.json + config.json). Owned by the Job so k8s GC
 * removes it whenever the Job is deleted (by `cancel` or `ttlSecondsAfterFinished`)
 * — creds never outlive their run and `cancel` stays a single Job DELETE.
 */
export const buildSecretManifest = (args: {
  readonly handle: string;
  readonly namespace: string;
  readonly jobUid: string;
  readonly configJson: string;
  readonly opencodeAuth: string;
  readonly labels: Record<string, string>;
}): SecretManifest => ({
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'Opaque',
  metadata: {
    name: args.handle,
    namespace: args.namespace,
    labels: args.labels,
    ownerReferences: [
      {
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: args.handle,
        uid: args.jobUid,
        controller: true,
        blockOwnerDeletion: true,
      },
    ],
  },
  stringData: { 'config.json': args.configJson, 'auth.json': args.opencodeAuth },
});

// ── Status + harvest (pure) ──────────────────────────────────────────────────

// Inbound k8s responses are decoded with `@effect/schema` (tenet 10), same as
// the harvest path — never hand-cast. Structs ignore unknown keys, so these list
// only the handful of fields poll/dispatch actually read.
const K8sRecord = Schema.Record({ key: Schema.String, value: Schema.String });

const JobStatusSchema = Schema.Struct({
  active: Schema.optional(Schema.Number),
  succeeded: Schema.optional(Schema.Number),
  failed: Schema.optional(Schema.Number),
  conditions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
        reason: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
});
type JobStatus = Schema.Schema.Type<typeof JobStatusSchema>;

const K8sMeta = Schema.Struct({
  uid: Schema.optional(Schema.String),
  labels: Schema.optional(K8sRecord),
  annotations: Schema.optional(K8sRecord),
});

/** A created/read Job — only `.metadata` + `.status` are consumed. */
const JobResource = Schema.Struct({
  metadata: Schema.optional(K8sMeta),
  status: Schema.optional(JobStatusSchema),
});

/** A pod list — only the first item's name is consumed. */
const PodList = Schema.Struct({
  items: Schema.optional(
    Schema.Array(
      Schema.Struct({
        metadata: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});

/** A k8s `Status` error body — only `.message` is surfaced. */
const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String) });

/** Fold a k8s Job `.status` into a coarse phase (+ a reason for failures). */
export const classifyJobStatus = (
  status: JobStatus,
): { readonly phase: 'running' | 'succeeded' | 'failed'; readonly reason: string } => {
  if ((status.succeeded ?? 0) >= 1) return { phase: 'succeeded', reason: '' };
  if ((status.failed ?? 0) >= 1) {
    const cond = status.conditions?.find((c) => c.type === 'Failed');
    const reason = [cond?.reason, cond?.message].filter(Boolean).join(': ') || 'job failed';
    return { phase: 'failed', reason };
  }
  return { phase: 'running', reason: '' };
};

/**
 * Decode the LAST line of `logs` that parses as `schema`. The worker writes its
 * result as the final stdout line, but a later log/warning could also start with
 * `{`; scanning newest-first for the first VALID decode is robust to that.
 */
const decodeLastResult = <A, I>(
  logs: string,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, AgentFailed> => {
  const candidates = logs
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .reverse();
  const noLine = new AgentFailed({
    reason: `no valid result line in worker logs. tail: ${logs.slice(-300)}`,
  });
  if (candidates.length === 0) return Effect.fail(noLine);
  return Effect.firstSuccessOf(
    candidates.map((c) => Schema.decode(Schema.parseJson(schema))(c)),
  ).pipe(Effect.mapError(() => noLine));
};

/**
 * Turn a succeeded Job's pod logs into a `DispatchOutcome`. Work runs emit a
 * `RunnerResult` (commitSha + usage) — title/body come from the Job annotations
 * set at dispatch. Review runs emit a `ReviewRunnerResult` whose raw text is
 * parsed to a verdict on THIS side of the seam (tenet 4).
 */
export const harvestOutcome = (args: {
  readonly kind: 'work' | 'review';
  readonly logs: string;
  readonly annotations: Record<string, string>;
}): Effect.Effect<DispatchOutcome, AgentFailed> =>
  Effect.gen(function* () {
    if (args.kind === 'work') {
      const { commitSha, usage } = yield* decodeLastResult(args.logs, RunnerResult);
      return DispatchOutcome.Work({
        result: {
          title: args.annotations['tidepool/pr-title'] ?? '',
          body: args.annotations['tidepool/pr-body'] ?? '',
          commitSha,
          usage,
        },
      });
    }
    const { text, usage } = yield* decodeLastResult(args.logs, ReviewRunnerResult);
    return DispatchOutcome.Review({ result: { verdict: parseVerdict(text), reason: text, usage } });
  });

// ── HTTP layer ───────────────────────────────────────────────────────────────

const k8sHeaders = (token: string): Record<string, string> => ({
  Accept: 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * Fold a transport/decode failure into `AgentFailed`. (A 429 is mapped to
 * `RateCapped` inline at the dispatch call site from the response status;
 * everything reaching here is a transport/decode error, hence always AgentFailed.)
 */
const httpFail = (e: HttpClientError.HttpClientError): Effect.Effect<never, AgentFailed> =>
  Effect.fail(new AgentFailed({ reason: String(e) }));

/**
 * Deterministic per (ticket, attempt): the SAME ticket attempt always names the
 * SAME Job. This is what makes a crash between `dispatch()` creating the Job and
 * the reconciler's `store.patch(state: 'running')` recoverable — a re-dispatch on
 * retry lands on the exact same Job name instead of `Math.random()`-ing a second
 * one, so it collides (409 AlreadyExists) rather than double-creating a live Job.
 * A NEW attempt (retry after a real failure) gets a new name, same as before.
 */
const defaultSuffix = (input: DispatchInput): string => String(input.ticket.attempts);

/**
 * `K8sAgentWorker` factory. `genSuffix`/`fetchDiff` are injected (defaulting to the
 * deterministic per-attempt suffix above and the shared REST diff fetch) so the
 * wire behavior is drivable from the kind e2e without real GitHub.
 */
export const makeK8sAgentWorker = (
  opts: {
    readonly genSuffix?: (input: DispatchInput) => string;
    readonly fetchDiff?: (i: {
      readonly token: string;
      readonly repo: string;
      readonly prNumber: number;
    }) => Promise<string>;
  } = {},
): Layer.Layer<AgentWorker, never, HttpClient.HttpClient | CredentialBroker | K8sConfig> =>
  Layer.effect(
    AgentWorker,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const broker = yield* CredentialBroker;
      const cfg = yield* K8sConfig;
      const genSuffix = opts.genSuffix ?? defaultSuffix;
      const fetchDiff = opts.fetchDiff ?? fetchPrDiff;

      const jobsUrl = `${cfg.apiBaseUrl}/apis/batch/v1/namespaces/${cfg.namespace}/jobs`;
      const secretsUrl = `${cfg.apiBaseUrl}/api/v1/namespaces/${cfg.namespace}/secrets`;
      const podsUrl = `${cfg.apiBaseUrl}/api/v1/namespaces/${cfg.namespace}/pods`;
      // In-cluster apiserver TLS trust is established at the process level, not
      // per-request: the control-plane Deployment sets NODE_EXTRA_CA_CERTS to the
      // auto-mounted SA CA (see SA_CA_CERT_PATH), which Bun's fetch reads at
      // startup. The caller only has to provide a plain HttpClient layer (kind CI
      // points it at a plain-http proxy, so no CA is needed there either).
      const headers = k8sHeaders(cfg.token);
      const post = (url: string, body: unknown) =>
        client.post(url, {
          headers,
          body: HttpBody.raw(JSON.stringify(body), { contentType: 'application/json' }),
        });
      const deleteJob = (handle: string) =>
        client.del(`${jobsUrl}/${handle}?propagationPolicy=Background`, { headers });
      const decodeJson = <A, I>(schema: Schema.Schema<A, I>, value: unknown, ctx: string) =>
        Schema.decodeUnknown(schema)(value).pipe(
          Effect.mapError((e) => new AgentFailed({ reason: `decode k8s ${ctx}: ${e}` })),
        );

      const dispatch: (
        input: DispatchInput,
      ) => Effect.Effect<WorkHandle, AgentFailed | RateCapped> = (input) =>
        Effect.gen(function* () {
          // Only cred source on this path. A missing cred is a config defect
          // (as the old inline token was), not a retryable agent failure — orDie.
          const creds = yield* broker
            .credsFor({ kind: input.kind, repo: input.repo, ticketId: input.ticket.id })
            .pipe(Effect.orDie);
          const diff =
            input.kind === 'review'
              ? yield* Effect.tryPromise({
                  try: () =>
                    fetchDiff({
                      token: creds.githubToken,
                      repo: input.repo,
                      prNumber: input.prNumber,
                    }),
                  catch: (e) => new AgentFailed({ reason: `fetch PR diff: ${e}` }),
                })
              : '';
          const handle = workHandleFor(input.kind, input.ticket.id, genSuffix(input));
          const configJson = JSON.stringify(buildAgentWorkerConfig(input, creds, diff));

          const jobRes = yield* post(
            jobsUrl,
            buildJobManifest({ handle, config: cfg, input, annotations: workAnnotations(input) }),
          );
          // A 409 here means THIS EXACT (ticket, attempt) Job already exists — the
          // deterministic name (see `defaultSuffix`) turned what would have been a
          // crash-window double-dispatch into a natural collision. Treat it as
          // idempotent success: fetch the existing Job (for its uid) and carry on
          // as if this call had created it.
          const job = yield* jobRes.status === 409
            ? Effect.gen(function* () {
                yield* Effect.logInfo('Job already exists; idempotent re-dispatch').pipe(
                  Effect.annotateLogs({ handle }),
                );
                const existing = yield* client.get(`${jobsUrl}/${handle}`, { headers });
                if (!isOk(existing.status)) {
                  const body = yield* decodeJson(
                    ErrorBody,
                    yield* existing.json,
                    'get existing Job error',
                  );
                  return yield* Effect.fail(
                    new AgentFailed({
                      reason: `k8s get existing Job ${existing.status}: ${body.message ?? 'unknown'}`,
                    }),
                  );
                }
                return yield* decodeJson(JobResource, yield* existing.json, 'get existing Job');
              })
            : isOk(jobRes.status)
              ? decodeJson(JobResource, yield* jobRes.json, 'create Job')
              : Effect.gen(function* () {
                  const body = yield* decodeJson(ErrorBody, yield* jobRes.json, 'create Job error');
                  return yield* jobRes.status === 429
                    ? Effect.fail(new RateCapped({}))
                    : Effect.fail(
                        new AgentFailed({
                          reason: `k8s create Job ${jobRes.status}: ${body.message ?? 'unknown'}`,
                        }),
                      );
                });
          const jobUid = job.metadata?.uid;
          // The Secret's ownerReference (→ GC that cascades creds when the Job is
          // deleted) is meaningless without the Job's uid. An empty uid would
          // silently orphan the Secret so creds outlive the run (tenet 9) — fail
          // hard rather than default to '' and mount stale creds.
          if (!jobUid) {
            yield* deleteJob(handle).pipe(Effect.ignore);
            return yield* Effect.fail(
              new AgentFailed({
                reason: `k8s create Job ${handle}: no uid returned (ownerRef GC)`,
              }),
            );
          }

          const secretRes = yield* post(
            secretsUrl,
            buildSecretManifest({
              handle,
              namespace: cfg.namespace,
              jobUid,
              configJson,
              opencodeAuth: creds.opencodeAuth,
              labels: jobLabels(input.kind, input.ticket.id, cfg.gitSha),
            }),
          );
          if (secretRes.status === 409) {
            // Same idempotent re-dispatch case as the Job 409 above, just caught
            // one step later: the crashed first attempt got past the Job POST but
            // this is our first time seeing it succeed, so the Secret already
            // exists too. No orphan to clean up — proceed as success.
            yield* Effect.logInfo('Secret already exists; idempotent re-dispatch').pipe(
              Effect.annotateLogs({ handle }),
            );
          } else if (!isOk(secretRes.status)) {
            const body = yield* decodeJson(ErrorBody, yield* secretRes.json, 'create Secret error');
            // dispatch is non-atomic: the Job exists but has no creds Secret, so
            // its pod would hang until `activeDeadlineSeconds`. Best-effort delete
            // the orphan before surfacing the failure (the reconciler re-dispatches).
            yield* deleteJob(handle).pipe(Effect.ignore);
            return yield* Effect.fail(
              new AgentFailed({
                reason: `k8s create Secret ${secretRes.status}: ${body.message ?? 'unknown'}`,
              }),
            );
          }
          yield* Effect.logInfo('created worker Job + creds Secret').pipe(
            Effect.annotateLogs({ handle, kind: input.kind, namespace: cfg.namespace }),
          );
          return makeWorkHandle(handle);
        }).pipe(Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }));

      const poll: (handle: WorkHandle) => Effect.Effect<WorkStatus, AgentFailed> = (handle) =>
        Effect.gen(function* () {
          const jobRes = yield* client.get(`${jobsUrl}/${handle}`, { headers });
          // A 404 here is the ttl-vs-cadence race: once a finished Job's
          // `ttlSecondsAfterFinished` elapses, k8s GCs it (and its logs), so a poll
          // that lands after GC can no longer read the outcome. Report a clear
          // terminal Failed rather than a confusing generic AgentFailed.
          // TODO(PR-6): wire `ttlSecondsAfterFinished` >> the reconciler poll
          // interval so a completed Job is always harvested before it is reaped.
          if (jobRes.status === 404)
            return WorkStatus.Failed({
              reason: `Job ${handle} not found (never created, or ttl-reaped before harvest)`,
            });
          if (!isOk(jobRes.status))
            return yield* Effect.fail(new AgentFailed({ reason: `k8s get Job ${jobRes.status}` }));
          const job = yield* decodeJson(JobResource, yield* jobRes.json, 'get Job');

          const { phase, reason } = classifyJobStatus(job.status ?? {});
          if (phase === 'running') return WorkStatus.Running();
          if (phase === 'failed') return WorkStatus.Failed({ reason });

          // Succeeded: find the (single) pod for this Job and harvest its stdout.
          const podRes = yield* client.get(
            `${podsUrl}?labelSelector=${encodeURIComponent(`job-name=${handle}`)}`,
            { headers },
          );
          const pods = yield* decodeJson(PodList, yield* podRes.json, 'list pods');
          const podName = pods.items?.[0]?.metadata?.name;
          if (podName === undefined)
            return WorkStatus.Failed({ reason: `no pod for succeeded Job ${handle}` });
          const logRes = yield* client.get(`${podsUrl}/${podName}/log`, { headers });
          const logs = yield* logRes.text;
          const kind = job.metadata?.labels?.['tidepool/kind'] === 'review' ? 'review' : 'work';
          const outcome = yield* harvestOutcome({
            kind,
            logs,
            annotations: job.metadata?.annotations ?? {},
          });
          return WorkStatus.Succeeded({ outcome });
        }).pipe(Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }));

      // `cancel` is `Effect<void>` by the seam (a gone worker IS success), so it
      // cannot propagate a delete failure. Still, don't blanket-swallow: a real
      // failure (500 / network) means the Job keeps spending — log it loudly.
      // Only 404/2xx are silent success.
      const cancel: (handle: WorkHandle) => Effect.Effect<void> = (handle) =>
        deleteJob(handle).pipe(
          Effect.flatMap((res) =>
            isOk(res.status) || res.status === 404
              ? Effect.void
              : Effect.logError(`k8s cancel Job ${handle} → ${res.status} (not deleted)`),
          ),
          Effect.catchAll((e) => Effect.logError(`k8s cancel Job ${handle} transport error: ${e}`)),
        );

      const reap: () => Effect.Effect<{ readonly cancelled: readonly WorkHandle[] }> = () =>
        client
          .get(`${jobsUrl}?labelSelector=${encodeURIComponent(AGENT_SELECTOR)}`, { headers })
          // Listing proves reachability; actual deletion of finished Jobs (and
          // their owned Secrets) is handled by `ttlSecondsAfterFinished`. A list
          // failure is non-fatal to a sweep — log it rather than swallow silently.
          .pipe(
            Effect.asVoid,
            Effect.catchAll((e) => Effect.logError(`k8s reap list error: ${e}`)),
            Effect.as({ cancelled: [] as readonly WorkHandle[] }),
          );

      return { dispatch, poll, cancel, reap };
    }),
  );

/** The k8s worker wired to real randomness + the shared diff fetch. */
export const K8sAgentWorker: Layer.Layer<
  AgentWorker,
  never,
  HttpClient.HttpClient | CredentialBroker | K8sConfig
> = makeK8sAgentWorker();
