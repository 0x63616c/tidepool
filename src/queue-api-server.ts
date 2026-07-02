import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { queueApi } from './queue-api.ts';
import { QueueControl } from './queue-control.ts';

/**
 * Server handlers: bind the queue HTTP API to the `QueueControl` service. Every
 * handler is a straight delegation — the API adds no logic, it only exposes the
 * seam over the wire. Query params are already decoded (and bad ones rejected as
 * a typed 4xx) by the branded schemas in `queue-api.ts`, so handlers never parse.
 * Runs inside the daemon, sharing its pg-backed store.
 *
 * TODO(tailscale): require a bearer token here when reach widens beyond the
 * apiserver port-forward (tenet 9 — today reachability itself is the auth).
 */

export const QueueApiLive = HttpApiBuilder.group(queueApi, 'tickets', (handlers) =>
  handlers
    .handle('add', ({ payload }) => Effect.flatMap(QueueControl, (qc) => qc.add(payload)))
    .handle('list', ({ urlParams }) =>
      Effect.flatMap(QueueControl, (qc) =>
        qc.list({
          limit: urlParams.limit ?? 50,
          cursor: urlParams.cursor ?? null,
          target: urlParams.target ?? null,
        }),
      ),
    )
    .handle('breakers', () => Effect.flatMap(QueueControl, (qc) => qc.breakers()))
    .handle('get', ({ path }) => Effect.flatMap(QueueControl, (qc) => qc.get(path.id)))
    .handle('runs', ({ path }) => Effect.flatMap(QueueControl, (qc) => qc.runsFor(path.id)))
    .handle('events', ({ urlParams }) =>
      Effect.flatMap(QueueControl, (qc) =>
        qc.events({
          ticketId: urlParams.ticketId ?? null,
          runId: urlParams.runId ?? null,
          source: urlParams.source ?? null,
          limit: urlParams.limit ?? 1000,
          cursor: urlParams.cursor ?? null,
        }),
      ),
    ),
);
