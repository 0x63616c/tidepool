import { Reactivity } from '@effect/experimental';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, Schema, type Scope } from 'effect';
import { Ticket, TicketNotFound } from './domain.ts';
import { newTicketId } from './ids.ts';
import type { TicketStoreApi } from './services.ts';

/**
 * sqlite-backed `TicketStore` — the durable single source of truth on the main
 * box (`.tidepool/tidepool.sqlite`). Same interface as the Ref fake; the only
 * difference is that state survives the process. Built via `@effect/sql` (the
 * one SQL layer, tenet 10). DB errors are defects (orDie), not domain failures —
 * the interface's error channel is reserved for `TicketNotFound`.
 */

const decodeTicket = Schema.decodeUnknownSync(Ticket);

/** Columns aliased back to the domain field names so a row decodes as a Ticket. */
const TICKET_COLS =
  'id, title, goal, target, state, branch, pr_number AS "prNumber", pr_id AS "prId", merge_sha AS "mergeSha", attempts, worked_attempt AS "workedAttempt"';

export const makeSqliteStore = (
  filename: string,
): Effect.Effect<TicketStoreApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.make({ filename }).pipe(Effect.provide(Reactivity.layer));

    yield* sql`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        target TEXT NOT NULL,
        state TEXT NOT NULL,
        branch TEXT,
        pr_number INTEGER,
        pr_id TEXT,
        merge_sha TEXT,
        attempts INTEGER NOT NULL,
        worked_attempt INTEGER
      )
    `.pipe(Effect.orDie);

    const notImpl = Effect.dieMessage(`sqlite-store(${filename}): not implemented`);

    const insertTicket = (t: Ticket) =>
      sql`
        INSERT INTO tickets (id, title, goal, target, state, branch, pr_number, pr_id, merge_sha, attempts, worked_attempt)
        VALUES (${t.id}, ${t.title}, ${t.goal}, ${t.target}, ${t.state}, ${t.branch}, ${t.prNumber}, ${t.prId}, ${t.mergeSha}, ${t.attempts}, ${t.workedAttempt})
      `.pipe(Effect.orDie);

    const api: TicketStoreApi = {
      add: (input) =>
        Effect.gen(function* () {
          const ticket = decodeTicket({
            id: newTicketId(),
            title: input.title,
            goal: input.goal,
            target: input.target,
            state: 'backlog',
            branch: null,
            prNumber: null,
            prId: null,
            mergeSha: null,
            attempts: 0,
            workedAttempt: null,
          });
          yield* insertTicket(ticket);
          return ticket;
        }),
      byId: (id) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT ${sql.literal(TICKET_COLS)} FROM tickets WHERE id = ${id}`.pipe(
              Effect.orDie,
            );
          const row = rows[0];
          if (row === undefined) return yield* Effect.fail(new TicketNotFound({ id }));
          return decodeTicket(row);
        }),
      list: () => notImpl,
      patch: () => notImpl,
      addRun: () => notImpl,
      runsFor: () => notImpl,
    };

    return api;
  });
