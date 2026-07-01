import { Context, Data, Effect, Layer, Schema } from 'effect';
import { AppConfig, configuredRepos } from './config.ts';
import type { NewTicket, Run, Ticket, TicketNotFound } from './domain.ts';
import { type RunEvent, RunSource } from './domain.ts';
import { RunId, TicketId } from './ids.ts';
import { TicketStore } from './services.ts';

/**
 * QueueControl — the narrow driver seam the `tp` CLI (and a future web UI) speaks.
 *
 * It exposes ONLY read + enqueue: `add`, `list`, `get`, `runsFor`, `events`. The
 * reconciler's state-mutating methods are deliberately absent so a remote client
 * cannot move ticket state — the reconciler stays the only mover (tenet 3).
 * Two adapters satisfy the tag: `LocalQueueControl` (this file, wraps the
 * in-process `TicketStore` for dev/tests) and `HttpQueueControl` (the laptop
 * client, added later). Commands never know which is behind the tag.
 */

/** Uniform collection envelope — every list-y response is this shape, never a bare array. */
export const Page = <A, I>(item: Schema.Schema<A, I>) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) });
export type Page<A> = { readonly items: ReadonlyArray<A>; readonly nextCursor: string | null };

/** `list` query — `limit` bounded, opaque `cursor`, optional `target` repo filter. */
export const ListTicketsQuery = Schema.Struct({
  limit: Schema.Int.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(200)),
  cursor: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
});
export type ListTicketsQuery = typeof ListTicketsQuery.Type;

/**
 * `events` query — narrowed by ticket / run / source, paginated by the same
 * envelope. All three narrows are nullable (mirrors the store's `EventQuery`):
 * `tp ticket logs --run` / `transcript` scope by run with no ticket, while
 * `get` / `logs <ticket>` scope by ticket.
 */
export const EventsQuery = Schema.Struct({
  ticketId: Schema.NullOr(TicketId),
  runId: Schema.NullOr(RunId),
  source: Schema.NullOr(RunSource),
  limit: Schema.Int.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1000)),
  cursor: Schema.NullOr(Schema.String),
});
export type EventsQuery = typeof EventsQuery.Type;

/** `add` rejected — the target repo is not declared in `tidepool.config.ts`. */
export class TargetNotConfigured extends Data.TaggedError('TargetNotConfigured')<{
  readonly repo: string;
  readonly configured: ReadonlyArray<string>;
}> {}

export interface QueueControlApi {
  readonly add: (input: NewTicket) => Effect.Effect<Ticket, TargetNotConfigured>;
  readonly list: (q: ListTicketsQuery) => Effect.Effect<Page<Ticket>>;
  readonly get: (id: TicketId) => Effect.Effect<Ticket, TicketNotFound>;
  readonly runsFor: (id: TicketId) => Effect.Effect<ReadonlyArray<Run>, TicketNotFound>;
  readonly events: (q: EventsQuery) => Effect.Effect<Page<RunEvent>, TicketNotFound>;
}
export class QueueControl extends Context.Tag('QueueControl')<QueueControl, QueueControlApi>() {}

/** Opaque-cursor slice over an id-bearing list: cursor = last item's id, newest-first. */
const paginateById = <A extends { readonly id: string }>(
  all: ReadonlyArray<A>,
  limit: number,
  cursor: string | null,
): Page<A> => {
  const start = cursor === null ? 0 : all.findIndex((x) => x.id === cursor) + 1;
  const items = all.slice(start, start + limit);
  const last = items.at(-1);
  const nextCursor = start + limit < all.length && last !== undefined ? last.id : null;
  return { items, nextCursor };
};

/**
 * Local adapter: `QueueControl` over the in-process `TicketStore`. Dev + tests
 * use this (no server). Paging is an in-memory newest-first slice — fine at
 * personal scale (tenet 7); swap for a store-native keyset query only if the
 * backlog ever demands it. Target validation lands in a later step (add stays a
 * straight passthrough until then).
 */
export const LocalQueueControl = Layer.effect(
  QueueControl,
  Effect.gen(function* () {
    const store = yield* TicketStore;
    const config = yield* AppConfig;
    const repos = configuredRepos(config);
    return {
      add: (input) =>
        repos.includes(input.target)
          ? store.add(input)
          : Effect.fail(new TargetNotConfigured({ repo: input.target, configured: repos })),
      list: (q) =>
        store.list().pipe(
          Effect.map((ts) => {
            const filtered = q.target === null ? ts : ts.filter((t) => t.target === q.target);
            return paginateById([...filtered].reverse(), q.limit, q.cursor);
          }),
        ),
      get: (id) => store.byId(id),
      runsFor: (id) => store.byId(id).pipe(Effect.flatMap(() => store.runsFor(id))),
      events: (q) => {
        const paginate = (evs: ReadonlyArray<RunEvent>): Page<RunEvent> => {
          // Events carry no id; the append-only stream is stable, so cursor = index.
          const start = q.cursor === null ? 0 : Number(q.cursor);
          const items = evs.slice(start, start + q.limit);
          const next = start + q.limit;
          return { items, nextCursor: next < evs.length ? String(next) : null };
        };
        const read = store
          .eventsFor({
            ticketId: q.ticketId ?? undefined,
            runId: q.runId ?? undefined,
            source: q.source ?? undefined,
          })
          .pipe(Effect.map(paginate));
        // Verify the ticket exists (TicketNotFound) only when scoping by ticket.
        return q.ticketId === null ? read : store.byId(q.ticketId).pipe(Effect.flatMap(() => read));
      },
    } satisfies QueueControlApi;
  }),
);
