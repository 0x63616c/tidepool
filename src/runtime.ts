import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FetchHttpClient } from '@effect/platform';
import { Effect, Layer, Redacted } from 'effect';
import { AppConfig, loadConfig } from './config.ts';
import { LocalCredentialBroker } from './credential-broker.ts';
import { GithubForgeLive } from './forge.ts';
import { K8sAgentWorker, K8sConfig, type K8sWorkerConfig } from './k8s-agent-worker.ts';
import { LocalAgentWorker } from './local-agent-worker.ts';
import { makePgTicketStore } from './pg-store.ts';
import { type AgentWorker, TicketStore } from './services.ts';
import { makeSqliteStore } from './sqlite-store.ts';

/**
 * Live wiring for the `tp` CLI + control-plane: the real adapters dropped in
 * behind the locked tags. The reconciler is unchanged — only the `Layer`s differ
 * from the fakes. Two runtime bindings are config-gated by env so the k8s/Postgres
 * flip is a deployment toggle, not a code change (and the default — no env set —
 * keeps local dev + `bun run check` on sqlite + the in-process worker, green
 * without a cluster):
 *
 *   TIDEPOOL_DB_DRIVER   = sqlite (default) | pg    → sqlite file vs CNPG Postgres
 *   TIDEPOOL_AGENT_WORKER = local (default) | k8s   → in-process vs agent-worker Jobs
 *
 * These are runtime *bindings* (they differ local vs pod), so they live in env
 * next to `TIDEPOOL_DB_PATH` — not in the git config, which holds declarative app
 * data (tenet 1). Runtime state itself still lives in exactly one store per
 * datum; this only chooses which durable backing.
 */

/** Default control-plane sqlite path for local dev (gitignored, never git). */
export const DEFAULT_DB_PATH = '.tidepool/tidepool.sqlite';

/**
 * Resolve the control-plane sqlite path. The seam: `TIDEPOOL_DB_PATH` lets the
 * management box point its db at a Hetzner Volume mount (e.g.
 * `/mnt/tidepool/tidepool.sqlite`) so runtime state survives a box rebuild,
 * while local dev keeps the unchanged default (tenet 7: design for N, run
 * minimal). An empty override is treated as unset, mirroring `hcloudToken`.
 */
export const dbPath = (): string => {
  const fromEnv = process.env.TIDEPOOL_DB_PATH;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_DB_PATH;
};

const envOr = (key: string, fallback: string): string => {
  const v = process.env[key];
  return v !== undefined && v.length > 0 ? v : fallback;
};

/** Which durable `TicketStore` backing to use (default sqlite). */
export type DbDriver = 'sqlite' | 'pg';
export const dbDriver = (): DbDriver => (process.env.TIDEPOOL_DB_DRIVER === 'pg' ? 'pg' : 'sqlite');

/** Which `AgentWorker` backing to use (default the in-process local worker). */
export type WorkerBackend = 'local' | 'k8s';
export const workerBackend = (): WorkerBackend =>
  process.env.TIDEPOOL_AGENT_WORKER === 'k8s' ? 'k8s' : 'local';

/** sqlite store, scoped so its connection closes (flushes) at the end of a run. */
export const SqliteTicketStore = Layer.scoped(
  TicketStore,
  Effect.flatMap(
    Effect.sync(dbPath).pipe(
      Effect.tap((path) => Effect.promise(() => mkdir(dirname(path), { recursive: true }))),
    ),
    (path) => makeSqliteStore(path),
  ),
);

/**
 * Postgres `TicketStore` (CNPG under k8s). The DSN comes from `TIDEPOOL_PG_URL`
 * at runtime (pod env / CredentialBroker) — never hardcoded, wrapped `Redacted`
 * so it never prints. Prod points it at `tidepool-pg-rw.tidepool.svc:5432`. A
 * missing DSN while `TIDEPOOL_DB_DRIVER=pg` is a fatal boot defect (die).
 */
export const PgTicketStore = Layer.unwrapScoped(
  Effect.gen(function* () {
    const url = process.env.TIDEPOOL_PG_URL;
    if (url === undefined || url.length === 0) {
      return yield* Effect.die(
        new Error('TIDEPOOL_DB_DRIVER=pg requires TIDEPOOL_PG_URL (the CNPG DSN)'),
      );
    }
    return makePgTicketStore({ url: Redacted.make(url) });
  }),
);

/** The durable store Layer selected by `TIDEPOOL_DB_DRIVER` (default sqlite). */
export const ticketStoreLive = (): Layer.Layer<TicketStore> =>
  dbDriver() === 'pg' ? PgTicketStore : SqliteTicketStore;

/**
 * In-cluster `K8sWorkerConfig`: the service-account bearer token + CA under
 * `/var/run/secrets/kubernetes.io/serviceaccount` and the apiserver from the
 * injected `KUBERNETES_SERVICE_*` env; namespace/image/resources/deadlines from
 * deployment env with the tenet-6 defaults (2 vCPU request / 2 Gi mem req=limit,
 * 30-min deadline). Only read when `TIDEPOOL_AGENT_WORKER=k8s`, so local/test
 * never touches the SA files.
 */
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const inClusterK8sConfig: Effect.Effect<K8sWorkerConfig> = Effect.gen(function* () {
  const token = yield* Effect.promise(() => readFile(`${SA_DIR}/token`, 'utf8'));
  const host = envOr('KUBERNETES_SERVICE_HOST', 'kubernetes.default.svc');
  const port = envOr('KUBERNETES_SERVICE_PORT', '443');
  const image = process.env.TIDEPOOL_AGENT_WORKER_IMAGE;
  if (image === undefined || image.length === 0) {
    return yield* Effect.die(
      new Error('TIDEPOOL_AGENT_WORKER=k8s requires TIDEPOOL_AGENT_WORKER_IMAGE'),
    );
  }
  return {
    apiBaseUrl: `https://${host}:${port}`,
    token: token.trim(),
    namespace: envOr('TIDEPOOL_WORKER_NAMESPACE', 'tidepool-workers'),
    image,
    // Absolute so it survives the Job's /work workingDir override (the image
    // ENTRYPOINT is relative to its own /app WORKDIR — see K8sWorkerConfig.command).
    command: ['bun', 'run', '/app/src/worker/agent-worker.ts'],
    cpuRequest: envOr('TIDEPOOL_WORKER_CPU_REQUEST', '2'),
    memRequest: envOr('TIDEPOOL_WORKER_MEM_REQUEST', '2Gi'),
    activeDeadlineSeconds: Number(envOr('TIDEPOOL_WORKER_DEADLINE_SEC', '1800')),
    ttlSecondsAfterFinished: Number(envOr('TIDEPOOL_WORKER_TTL_SEC', '600')),
  };
});

/** The local in-process worker, wired to its credential broker. */
export const LocalAgentWorkerLive = LocalAgentWorker.pipe(Layer.provide(LocalCredentialBroker));

/**
 * The k8s agent-worker: real Jobs via the apiserver. Creds from the same
 * passthrough broker (agent-workers never read sops, tenet 9); HTTP via the one
 * `@effect/platform` client (tenet 10); connection config from the SA in-cluster.
 * HELD until PR-5a/5b apply (needs a live cluster) — built only under the k8s gate.
 */
export const K8sAgentWorkerLive = K8sAgentWorker.pipe(
  Layer.provide(LocalCredentialBroker),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.effect(K8sConfig, inClusterK8sConfig)),
);

/** The `AgentWorker` Layer selected by `TIDEPOOL_AGENT_WORKER` (default local). */
export const agentWorkerLive = (): Layer.Layer<AgentWorker> =>
  workerBackend() === 'k8s' ? K8sAgentWorkerLive : LocalAgentWorkerLive;

/** Declarative config from `tidepool.config.ts` (git, PR-reviewed). */
export const AppConfigLive = Layer.effect(
  AppConfig,
  loadConfig(() => import('../tidepool.config.ts')),
);

/**
 * The full real stack, assembled from the config-gated store + worker selections.
 * Default (no env) = sqlite + local worker, exactly as before; the prod pod sets
 * `TIDEPOOL_DB_DRIVER=pg` + `TIDEPOOL_AGENT_WORKER=k8s` to flip to CNPG Postgres +
 * agent-worker Jobs with zero reconciler change.
 */
export const liveStack = () =>
  Layer.mergeAll(ticketStoreLive(), AppConfigLive, GithubForgeLive, agentWorkerLive());
