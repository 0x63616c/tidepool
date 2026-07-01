#!/usr/bin/env bun
import { Etag, HttpApiBuilder, HttpPlatform } from '@effect/platform';
import { BunContext, BunHttpServer, BunRuntime } from '@effect/platform-bun';
import { Effect, Layer, Logger } from 'effect';
import type { AppConfig } from './config.ts';
import { queueApi } from './queue-api.ts';
import { QueueApiLive } from './queue-api-server.ts';
import { LocalQueueControl } from './queue-control.ts';
import { reconcileForever } from './reconciler.ts';
import { AppConfigLive, liveStack, ticketStoreLive } from './runtime.ts';
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

/**
 * The queue-control HTTP server (`QueueControl` over the durable store), served
 * on `TIDEPOOL_API_PORT` (default 8080). Reached only via `kubectl port-forward`
 * through the /32-firewalled apiserver — no public inbound, no app auth in v1
 * (tenet 9). The server's store connection is independent of the reconciler's;
 * both point at the same DSN (single source of truth is the store, not the pool).
 */
const apiServerLive = () => {
  const apiPort = Number(process.env.TIDEPOOL_API_PORT ?? '8080');
  const queueLocal = LocalQueueControl.pipe(
    Layer.provide(Layer.merge(ticketStoreLive(), AppConfigLive)),
  );
  const apiLayer = HttpApiBuilder.api(queueApi).pipe(
    Layer.provide(QueueApiLive),
    Layer.provide(queueLocal),
  );
  return HttpApiBuilder.serve().pipe(
    Layer.provide(apiLayer),
    Layer.provide(Layer.mergeAll(HttpPlatform.layer, Etag.layer)),
    Layer.provide(BunHttpServer.layer({ port: apiPort })),
  );
};

if (import.meta.main) {
  // Run the reconcile loop and the HTTP API concurrently over the live stack.
  const program = Effect.scoped(
    Effect.all([Layer.launch(apiServerLive()), makeDaemon().pipe(Effect.provide(liveStack()))], {
      concurrency: 'unbounded',
      discard: true,
    }),
  ).pipe(Effect.provide(BunContext.layer), Effect.provide(Logger.json));
  BunRuntime.runMain(program, { disablePrettyLogger: true });
}
