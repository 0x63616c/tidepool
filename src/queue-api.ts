import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { NewTicket, Run, RunEvent, RunSource, Ticket, TicketNotFound } from './domain.ts';
import { RunId, TicketId } from './ids.ts';
import { Page, TargetNotConfigured, TicketPage } from './queue-control.ts';

/**
 * The queue-control HTTP surface — the wire form of `QueueControl`. Read +
 * enqueue only; the reconciler's mover methods are not here, so no client can
 * move ticket state over HTTP (tenet 3). Shared by the daemon (server) and the
 * `tp` CLI (client) so their shapes can never drift. One HTTP layer only —
 * `@effect/platform` (tenet 10).
 */

const IdPath = Schema.Struct({ id: TicketId });

/** `list` filters — all optional; numbers arrive as strings on the query string. */
const ListParams = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
});

/**
 * `events` narrows — ticket OR run scope, both optional (run-scoped has no
 * ticket). Branded id/source schemas so the platform decodes + rejects a
 * malformed param as a typed 4xx (matching the `get`/`runs` path params), rather
 * than the handler throwing on a bad value → 500.
 */
const EventsParams = Schema.Struct({
  ticketId: Schema.optional(TicketId),
  runId: Schema.optional(RunId),
  source: Schema.optional(RunSource),
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
});

const tickets = HttpApiGroup.make('tickets')
  .add(
    HttpApiEndpoint.post('add', '/tickets')
      .setPayload(NewTicket)
      .addSuccess(Ticket)
      .addError(TargetNotConfigured, { status: 422 }),
  )
  .add(HttpApiEndpoint.get('list', '/tickets').setUrlParams(ListParams).addSuccess(TicketPage))
  .add(
    HttpApiEndpoint.get('get', '/tickets/:id')
      .setPath(IdPath)
      .addSuccess(Ticket)
      .addError(TicketNotFound, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get('runs', '/tickets/:id/runs')
      .setPath(IdPath)
      .addSuccess(Schema.Array(Run))
      .addError(TicketNotFound, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get('events', '/events')
      .setUrlParams(EventsParams)
      .addSuccess(Page(RunEvent))
      .addError(TicketNotFound, { status: 404 }),
  );

export const queueApi = HttpApi.make('queue').add(tickets);
