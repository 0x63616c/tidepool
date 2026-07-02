import { HttpApiClient, type HttpClient } from '@effect/platform';
import { Effect, Layer } from 'effect';
import { queueApi } from './queue-api.ts';
import { QueueControl, type QueueControlApi } from './queue-control.ts';

/**
 * `HttpQueueControl` — the laptop adapter. Satisfies the same `QueueControl` tag
 * as the local adapter, but every call is an HTTP request to the daemon's queue
 * API. The CLI never knows the difference (deep module, tenet 4). Transport /
 * decode failures are unrecoverable for a one-shot CLI command, so they become
 * defects; only the declared domain errors stay in the typed channel.
 */

/** Keep the one expected domain error tag; any other failure is a defect (transport/decode). */
const domainOnly =
  <Tag extends string>(tag: Tag) =>
  <A, E extends { readonly _tag: string }, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Extract<E, { readonly _tag: Tag }>, R> =>
    eff.pipe(
      Effect.catchAll((e) =>
        e._tag === tag ? Effect.fail(e as Extract<E, { readonly _tag: Tag }>) : Effect.die(e),
      ),
    );

export const HttpQueueControl = (
  baseUrl: string,
): Layer.Layer<QueueControl, never, HttpClient.HttpClient> =>
  Layer.effect(
    QueueControl,
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(queueApi, { baseUrl });
      return {
        add: (input) =>
          client.tickets.add({ payload: input }).pipe(domainOnly('TargetNotConfigured')),
        list: (q) =>
          client.tickets
            .list({
              urlParams: {
                limit: q.limit,
                cursor: q.cursor ?? undefined,
                target: q.target ?? undefined,
              },
            })
            .pipe(Effect.orDie),
        breakers: () => client.tickets.breakers().pipe(Effect.orDie),
        get: (id) => client.tickets.get({ path: { id } }).pipe(domainOnly('TicketNotFound')),
        runsFor: (id) => client.tickets.runs({ path: { id } }).pipe(domainOnly('TicketNotFound')),
        events: (q) =>
          client.tickets
            .events({
              urlParams: {
                ticketId: q.ticketId ?? undefined,
                runId: q.runId ?? undefined,
                source: q.source ?? undefined,
                limit: q.limit,
                cursor: q.cursor ?? undefined,
              },
            })
            .pipe(domainOnly('TicketNotFound')),
      } satisfies QueueControlApi;
    }),
  );
