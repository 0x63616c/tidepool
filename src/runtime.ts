import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Effect, Layer } from 'effect';
import { AppConfig, loadConfig } from './config.ts';
import { GithubForgeLive } from './forge.ts';
import { LocalAgentWorker } from './local-agent-worker.ts';
import { TicketStore } from './services.ts';
import { makeSqliteStore } from './sqlite-store.ts';

/**
 * Live wiring for the `tp` CLI: the real adapters dropped in behind the locked
 * tags. The reconciler is unchanged — only the `Layer`s differ from the fakes.
 * Runtime state lives in `.tidepool/` (gitignored), never git (tenet 1).
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

/** Declarative config from `tidepool.config.ts` (git, PR-reviewed). */
export const AppConfigLive = Layer.effect(
  AppConfig,
  loadConfig(() => import('../tidepool.config.ts')),
);

/**
 * The full real stack: durable store + GitHub + the local opencode agent-worker.
 * Until k8s lands (PR-4/6) `LocalAgentWorker` runs work/review on this machine
 * behind the async `AgentWorker` seam; the `K8sAgentWorker` Layer swaps in later
 * with zero reconciler change.
 */
export const LiveStack = Layer.mergeAll(
  SqliteTicketStore,
  AppConfigLive,
  GithubForgeLive,
  LocalAgentWorker,
);
