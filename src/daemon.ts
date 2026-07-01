#!/usr/bin/env bun
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Effect, Logger } from 'effect';
import type { AppConfig } from './config.ts';
import { reconcileForever } from './reconciler.ts';
import { liveStack } from './runtime.ts';
import type { AgentWorker, Forge, TicketStore } from './services.ts';

/**
 * The control-plane daemon — the pod's process. It runs the reconcile loop (the
 * ONLY mover, tenet 3) over the durable store in `liveStack()`. Split out of the
 * CLI so `tp` stays a pure queue-control client and the daemon is not a human
 * verb (no one types `tp run --watch` at a prompt — the image runs this file).
 *
 * `makeDaemon` returns the loop with its service requirements still open, so a
 * test can provide fakes and drive it under `TestClock`; the entrypoint below
 * provides the live stack. The QueueControl HTTP API is folded into this process
 * in a later step, sharing the same store.
 */
export const makeDaemon = (): Effect.Effect<
  void,
  never,
  TicketStore | Forge | AgentWorker | AppConfig
> => reconcileForever();

if (import.meta.main) {
  const program = Effect.scoped(makeDaemon().pipe(Effect.provide(liveStack()))).pipe(
    Effect.provide(BunContext.layer),
    Effect.provide(Logger.json),
  );
  BunRuntime.runMain(program, { disablePrettyLogger: true });
}
