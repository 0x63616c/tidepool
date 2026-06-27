import { mkdir } from 'node:fs/promises';
import { Effect, Layer } from 'effect';
import { OpencodeAgentRunnerLive } from './agent-runner.ts';
import { AppConfig, loadConfig } from './config.ts';
import { GithubForgeLive } from './forge.ts';
import { HetznerBoxMakerLive } from './hetzner-box.ts';
import { TicketStore } from './services.ts';
import { makeSqliteStore } from './sqlite-store.ts';

/**
 * Live wiring for the `tp` CLI: the real adapters dropped in behind the locked
 * tags. The reconciler is unchanged — only the `Layer`s differ from the fakes.
 * Runtime state lives in `.tidepool/` (gitignored), never git (tenet 1).
 */

export const DB_PATH = '.tidepool/tidepool.sqlite';

/** sqlite store, scoped so its connection closes (flushes) at the end of a run. */
export const SqliteTicketStore = Layer.scoped(
  TicketStore,
  Effect.flatMap(
    Effect.promise(() => mkdir('.tidepool', { recursive: true })),
    () => makeSqliteStore(DB_PATH),
  ),
);

/** Declarative config from `tidepool.config.ts` (git, PR-reviewed). */
export const AppConfigLive = Layer.effect(
  AppConfig,
  loadConfig(() => import('../tidepool.config.ts')),
);

/** The full real stack: durable store + GitHub + opencode + real Hetzner workers. */
export const LiveStack = Layer.mergeAll(
  SqliteTicketStore,
  AppConfigLive,
  GithubForgeLive,
  OpencodeAgentRunnerLive,
  HetznerBoxMakerLive,
);
