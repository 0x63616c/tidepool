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
 * carrying the broker's creds) into the `tidepool-workers` namespace and returns
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
  /** PEM CA bundle to trust for the API server. Optional (plain-http proxies). */
  readonly caCert?: string;
  /** Namespace the worker Jobs live in. */
  readonly namespace: string;
  /** agent-worker container image (registry ref + tag), by config. */
  readonly image: string;
  /** CPU request; NO cpu limit is set (bursty agents, tenet-6 blast control). */
  readonly cpuRequest: string;
  /** Memory request == limit (hard OOM cap). */
  readonly memRequest: string;
  /** Job `activeDeadlineSeconds` — hard wall-clock kill. */
  readonly activeDeadlineSeconds: number;
  /** Job `ttlSecondsAfterFinished` — auto-reap finished Jobs (+ owned Secrets). */
  readonly ttlSecondsAfterFinished: number;
}

/** DI tag for the k8s connection/shape config. */
export class K8sConfig extends Context.Tag('K8sWorkerConfig')<K8sConfig, K8sWorkerConfig>() {}

/** Provide a concrete `K8sWorkerConfig` (tests, kind CI, PR-6 in-cluster boot). */
export const k8sWorkerConfigLayer = (config: K8sWorkerConfig): Layer.Layer<K8sConfig> =>
  Layer.succeed(K8sConfig, config);

// ── Naming ───────────────────────────────────────────────────────────────────

const PART_OF = 'app.kubernetes.io/part-of';
const WORKDIR = '/work';

/** Coerce an arbitrary id into a DNS-1123 label fragment (`_`→`-`, lowercased). */
export const k8sName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The Job name AND `WorkHandle`: `tp-<kind>-<ticket>-<suffix>`. The ticket id's
 * sops-style `_` is not DNS-1123-legal, so it is sanitized; the raw id is still
 * carried verbatim on the `tidepool/ticket` label (where `_` is allowed).
 */
export const workHandleFor = (kind: 'work' | 'review', ticketId: string, suffix: string): string =>
  `tp-${kind}-${k8sName(ticketId)}-${k8sName(suffix)}`.slice(0, 63).replace(/-+$/g, '');

const jobLabels = (kind: 'work' | 'review', ticketId: string): Record<string, string> => ({
  [PART_OF]: 'tidepool',
  'tidepool/role': 'agent-worker',
  'tidepool/kind': kind,
  'tidepool/ticket': ticketId,
});

/** Label selector matching every agent-worker Job (for `reap`). */
export const WORKER_SELECTOR = `${PART_OF}=tidepool,tidepool/role=agent-worker`;

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
        dir: `${WORKDIR}/tp-work-${input.ticket.id}`,
        model: input.model,
        prompt: workPrompt(input.ticket),
        commitMsg: commitMessage(input.ticket),
      }
    : {
        kind: 'review',
        dir: `${WORKDIR}/tp-review-${input.ticket.id}`,
        model: input.model,
        prompt: reviewPrompt(input.ticket, diff),
      };

/** Title/body annotations so `poll` can rebuild `WorkResult` after a restart. */
const workAnnotations = (input: DispatchInput): Record<string, string> =>
  input.kind === 'work'
    ? { 'tidepool/pr-title': workTitle(input.ticket), 'tidepool/pr-body': workBody(input.ticket) }
    : {};

/** The namespaced `batch/v1` Job manifest. */
export const buildJobManifest = (args: {
  readonly handle: string;
  readonly config: K8sWorkerConfig;
  readonly input: DispatchInput;
  readonly annotations?: Record<string, string>;
}): unknown => {
  const { handle, config, input } = args;
  const labels = jobLabels(input.kind, input.ticket.id);
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
              name: 'agent-worker',
              image: config.image,
              workingDir: WORKDIR,
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
}): unknown => ({
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

interface JobStatus {
  readonly active?: number;
  readonly succeeded?: number;
  readonly failed?: number;
  readonly conditions?: ReadonlyArray<{
    readonly type?: string;
    readonly status?: string;
    readonly reason?: string;
    readonly message?: string;
  }>;
}

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

const lastJsonLine = (logs: string): string | undefined =>
  logs
    .split('\n')
    .map((l) => l.trim())
    .findLast((l) => l.startsWith('{'));

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
    const line = lastJsonLine(args.logs);
    if (line === undefined)
      return yield* Effect.fail(
        new AgentFailed({
          reason: `no result line in worker logs. tail: ${args.logs.slice(-300)}`,
        }),
      );
    const decodeFail = (e: unknown) => new AgentFailed({ reason: `decode worker result: ${e}` });
    if (args.kind === 'work') {
      const { commitSha, usage } = yield* Schema.decode(Schema.parseJson(RunnerResult))(line).pipe(
        Effect.mapError(decodeFail),
      );
      return DispatchOutcome.Work({
        result: {
          title: args.annotations['tidepool/pr-title'] ?? '',
          body: args.annotations['tidepool/pr-body'] ?? '',
          commitSha,
          usage,
        },
      });
    }
    const { text, usage } = yield* Schema.decode(Schema.parseJson(ReviewRunnerResult))(line).pipe(
      Effect.mapError(decodeFail),
    );
    return DispatchOutcome.Review({ result: { verdict: parseVerdict(text), usage } });
  });

// ── HTTP layer ───────────────────────────────────────────────────────────────

const k8sHeaders = (token: string): Record<string, string> => ({
  Accept: 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Fold a transport/decode failure into `AgentFailed` (rate-cap aware). */
const httpFail = (e: HttpClientError.HttpClientError): Effect.Effect<never, AgentFailed> =>
  Effect.fail(new AgentFailed({ reason: String(e) }));

const defaultSuffix = (): string => Math.random().toString(36).slice(2, 8);

/**
 * `K8sAgentWorker` factory. `genSuffix`/`fetchDiff` are injected (defaulting to a
 * random suffix and the shared REST diff fetch) so the wire behavior is drivable
 * from the kind e2e without real randomness or GitHub.
 */
export const makeK8sAgentWorker = (
  opts: {
    readonly genSuffix?: () => string;
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
      const headers = k8sHeaders(cfg.token);
      const post = (url: string, body: unknown) =>
        client.post(url, {
          headers,
          body: HttpBody.raw(JSON.stringify(body), { contentType: 'application/json' }),
        });

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
          const handle = workHandleFor(input.kind, input.ticket.id, genSuffix());
          const configJson = JSON.stringify(buildAgentWorkerConfig(input, creds, diff));

          const jobRes = yield* post(
            jobsUrl,
            buildJobManifest({ handle, config: cfg, input, annotations: workAnnotations(input) }),
          );
          const jobBody = (yield* jobRes.json) as {
            readonly metadata?: { readonly uid?: string };
            readonly message?: string;
          };
          if (!isOk(jobRes.status)) {
            return yield* jobRes.status === 429
              ? Effect.fail(new RateCapped({}))
              : Effect.fail(
                  new AgentFailed({
                    reason: `k8s create Job ${jobRes.status}: ${jobBody.message ?? 'unknown'}`,
                  }),
                );
          }

          const secretRes = yield* post(
            secretsUrl,
            buildSecretManifest({
              handle,
              namespace: cfg.namespace,
              jobUid: jobBody.metadata?.uid ?? '',
              configJson,
              opencodeAuth: creds.opencodeAuth,
              labels: jobLabels(input.kind, input.ticket.id),
            }),
          );
          if (!isOk(secretRes.status)) {
            const body = (yield* secretRes.json) as { readonly message?: string };
            return yield* Effect.fail(
              new AgentFailed({
                reason: `k8s create Secret ${secretRes.status}: ${body.message ?? 'unknown'}`,
              }),
            );
          }
          return makeWorkHandle(handle);
        }).pipe(Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }));

      const poll: (handle: WorkHandle) => Effect.Effect<WorkStatus, AgentFailed> = (handle) =>
        Effect.gen(function* () {
          const jobRes = yield* client.get(`${jobsUrl}/${handle}`, { headers });
          const job = (yield* jobRes.json) as {
            readonly status?: JobStatus;
            readonly metadata?: {
              readonly labels?: Record<string, string>;
              readonly annotations?: Record<string, string>;
            };
          };
          if (!isOk(jobRes.status))
            return yield* Effect.fail(new AgentFailed({ reason: `k8s get Job ${jobRes.status}` }));

          const { phase, reason } = classifyJobStatus(job.status ?? {});
          if (phase === 'running') return WorkStatus.Running();
          if (phase === 'failed') return WorkStatus.Failed({ reason });

          // Succeeded: find the (single) pod for this Job and harvest its stdout.
          const podRes = yield* client.get(
            `${podsUrl}?labelSelector=${encodeURIComponent(`job-name=${handle}`)}`,
            { headers },
          );
          const pods = (yield* podRes.json) as {
            readonly items?: ReadonlyArray<{ readonly metadata?: { readonly name?: string } }>;
          };
          const podName = pods.items?.[0]?.metadata?.name;
          if (podName === undefined)
            return WorkStatus.Failed({ reason: `no pod for succeeded Job ${handle}` });
          const logRes = yield* client.get(`${podsUrl}/${podName}/log`, { headers });
          const logs = yield* logRes.text;
          const kind = (job.metadata?.labels?.['tidepool/kind'] ?? 'work') as 'work' | 'review';
          const outcome = yield* harvestOutcome({
            kind,
            logs,
            annotations: job.metadata?.annotations ?? {},
          });
          return WorkStatus.Succeeded({ outcome });
        }).pipe(Effect.catchTags({ RequestError: httpFail, ResponseError: httpFail }));

      const cancel: (handle: WorkHandle) => Effect.Effect<void> = (handle) =>
        client
          .del(`${jobsUrl}/${handle}?propagationPolicy=Background`, { headers })
          // Cancel is idempotent: a gone Job (404) or any transport hiccup is fine.
          .pipe(Effect.asVoid, Effect.ignore);

      const reap: () => Effect.Effect<{ readonly cancelled: readonly WorkHandle[] }> = () =>
        client
          .get(`${jobsUrl}?labelSelector=${encodeURIComponent(WORKER_SELECTOR)}`, { headers })
          // Listing proves reachability; actual deletion of finished Jobs (and
          // their owned Secrets) is handled by `ttlSecondsAfterFinished`.
          .pipe(
            Effect.asVoid,
            Effect.ignore,
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
