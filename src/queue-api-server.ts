import { HttpApiBuilder } from '@effect/platform';
import { Effect, Schema } from 'effect';
import { RunSource } from './domain.ts';
import { RunId, TicketId } from './ids.ts';
import { queueApi } from './queue-api.ts';
import { QueueControl } from './queue-control.ts';

/**
 * Server handlers: bind the queue HTTP API to the `QueueControl` service. Every
 * handler is a straight delegation — the API adds no logic, it only exposes the
 * seam over the wire. Runs inside the daemon, sharing its pg-backed store.
 *
 * TODO(tailscale): require a bearer token here when reach widens beyond the
 * apiserver port-forward (tenet 9 — today reachability itself is the auth).
 */

const decodeTicketId = Schema.decodeSync(TicketId);
const decodeRunId = Schema.decodeSync(RunId);
const decodeSource = Schema.decodeUnknownSync(RunSource);

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
    .handle('get', ({ path }) => Effect.flatMap(QueueControl, (qc) => qc.get(path.id)))
    .handle('runs', ({ path }) => Effect.flatMap(QueueControl, (qc) => qc.runsFor(path.id)))
    .handle('events', ({ urlParams }) =>
      Effect.flatMap(QueueControl, (qc) =>
        qc.events({
          ticketId: urlParams.ticketId === undefined ? null : decodeTicketId(urlParams.ticketId),
          runId: urlParams.runId === undefined ? null : decodeRunId(urlParams.runId),
          source: urlParams.source === undefined ? null : decodeSource(urlParams.source),
          limit: urlParams.limit ?? 1000,
          cursor: urlParams.cursor ?? null,
        }),
      ),
    ),
);
