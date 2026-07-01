import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { NewTicket, Run, RunEvent, Ticket, TicketNotFound } from './domain.ts';
import { TicketId } from './ids.ts';
import { Page, TargetNotConfigured } from './queue-control.ts';

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

/** `events` narrows — ticket OR run scope, both optional (run-scoped has no ticket). */
const EventsParams = Schema.Struct({
  ticketId: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
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
  .add(HttpApiEndpoint.get('list', '/tickets').setUrlParams(ListParams).addSuccess(Page(Ticket)))
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
