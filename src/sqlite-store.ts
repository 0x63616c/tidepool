import { Reactivity } from '@effect/experimental';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, Schema, type Scope } from 'effect';
import { Run, Ticket, TicketNotFound } from './domain.ts';
import { newTicketId, type TicketId } from './ids.ts';
import type { TicketStoreApi } from './services.ts';

/**
 * sqlite-backed `TicketStore` — the durable single source of truth on the main
 * box (`.tidepool/tidepool.sqlite`). Same interface as the Ref fake; the only
 * difference is that state survives the process. Built via `@effect/sql` (the
 * one SQL layer, tenet 10). DB errors are defects (orDie), not domain failures —
 * the interface's error channel is reserved for `TicketNotFound`.
 */

const decodeTicket = Schema.decodeUnknownSync(Ticket);

const decodeRun = Schema.decodeUnknownSync(Run);

/** Columns aliased back to the domain field names so a row decodes as a Ticket. */
const TICKET_COLS =
  'id, title, goal, target, state, branch, pr_number AS "prNumber", pr_id AS "prId", merge_sha AS "mergeSha", attempts, worked_attempt AS "workedAttempt"';

interface RunRow {
  readonly id: string;
  readonly ticketId: string;
  readonly kind: string;
  readonly boxId: string | null;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly wallTimeSec: number;
}

/** Re-nest a flat run row into the `Run` shape, then validate it. */
const runFromRow = (r: RunRow): Run =>
  decodeRun({
    id: r.id,
    ticketId: r.ticketId,
    kind: r.kind,
    boxId: r.boxId,
    usage: {
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      wallTimeSec: r.wallTimeSec,
    },
  });

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

    yield* sql`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        box_id TEXT,
        usage_model TEXT NOT NULL,
        usage_tokens_in INTEGER NOT NULL,
        usage_tokens_out INTEGER NOT NULL,
        usage_wall_time_sec REAL NOT NULL
      )
    `.pipe(Effect.orDie);

    const insertTicket = (t: Ticket) =>
      sql`
        INSERT INTO tickets (id, title, goal, target, state, branch, pr_number, pr_id, merge_sha, attempts, worked_attempt)
        VALUES (${t.id}, ${t.title}, ${t.goal}, ${t.target}, ${t.state}, ${t.branch}, ${t.prNumber}, ${t.prId}, ${t.mergeSha}, ${t.attempts}, ${t.workedAttempt})
      `.pipe(Effect.orDie);

    const findById = (id: TicketId) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT ${sql.literal(TICKET_COLS)} FROM tickets WHERE id = ${id}`.pipe(
            Effect.orDie,
          );
        const row = rows[0];
        if (row === undefined) return yield* Effect.fail(new TicketNotFound({ id }));
        return decodeTicket(row);
      });

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
      byId: (id) => findById(id),
      list: () =>
        sql`SELECT ${sql.literal(TICKET_COLS)} FROM tickets ORDER BY rowid`.pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => decodeTicket(row))),
        ),
      patch: (id, patch) =>
        Effect.gen(function* () {
          const current = yield* findById(id);
          const updated: Ticket = { ...current, ...patch };
          yield* sql`
            UPDATE tickets SET
              state = ${updated.state},
              branch = ${updated.branch},
              pr_number = ${updated.prNumber},
              pr_id = ${updated.prId},
              merge_sha = ${updated.mergeSha},
              attempts = ${updated.attempts},
              worked_attempt = ${updated.workedAttempt}
            WHERE id = ${id}
          `.pipe(Effect.orDie);
          return updated;
        }),
      addRun: (run) =>
        sql`
          INSERT INTO runs (id, ticket_id, kind, box_id, usage_model, usage_tokens_in, usage_tokens_out, usage_wall_time_sec)
          VALUES (${run.id}, ${run.ticketId}, ${run.kind}, ${run.boxId}, ${run.usage.model}, ${run.usage.tokensIn}, ${run.usage.tokensOut}, ${run.usage.wallTimeSec})
        `.pipe(Effect.orDie, Effect.asVoid),
      runsFor: (id) =>
        sql<RunRow>`
          SELECT id, ticket_id AS "ticketId", kind, box_id AS "boxId",
                 usage_model AS "model", usage_tokens_in AS "tokensIn",
                 usage_tokens_out AS "tokensOut", usage_wall_time_sec AS "wallTimeSec"
          FROM runs WHERE ticket_id = ${id} ORDER BY rowid
        `.pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(runFromRow)),
        ),
    };

    return api;
  });
