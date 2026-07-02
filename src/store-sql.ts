import type { SqlClient } from '@effect/sql/SqlClient';
import { Effect, Either, Schema } from 'effect';
import { projectTicket, Run, RunEvent, Ticket, TicketNotFound } from './domain.ts';
import { newTicketId, type TicketId } from './ids.ts';
import type { TicketStoreApi } from './services.ts';

/**
 * Dialect-neutral `TicketStore` query builder — the single source of query truth
 * shared by the sqlite and Postgres backings (tenet 10, one SQL layer). Every
 * query goes through the `@effect/sql` `SqlClient` seam, so swapping the driver
 * (`@effect/sql-sqlite-bun` → `@effect/sql-pg`) never touches this code. The two
 * stores differ only in schema setup (inline `CREATE TABLE` vs `PgMigrator`) and
 * the ONE dialect knob threaded through here: the insertion-order column
 * (`opts.orderBy` — sqlite's implicit `rowid`, Postgres's explicit `seq`).
 *
 * DB errors are defects (orDie), not domain failures — the error channel is
 * reserved for `TicketNotFound`.
 */

const decodeTicket = Schema.decodeUnknownSync(Ticket);

const decodeTicketEither = Schema.decodeUnknownEither(Ticket);

const decodeRun = Schema.decodeUnknownSync(Run);

const decodeRunEvent = Schema.decodeUnknownSync(RunEvent);

/** Columns aliased back to the domain field names so a row decodes as a Ticket. */
const TICKET_COLS =
  'id, title, body, target, state, phase, conditions, branch, pr_number AS "prNumber", pr_id AS "prId", merge_sha AS "mergeSha", attempts, contention_count AS "contentionCount", worked_attempt AS "workedAttempt", reason, work_handle AS "workHandle", dispatched_at AS "dispatchedAt"';

interface EventRow {
  readonly ticketId: string;
  readonly runId: string | null;
  readonly boxId: string | null;
  readonly source: string;
  readonly ts: number;
  readonly level: string | null;
  readonly line: string;
}

interface RunRow {
  readonly id: string;
  readonly ticketId: string;
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly dispatchedAt: number;
  readonly finishedAt: number | null;
  readonly boxId: string | null;
  readonly boxProvider: string | null;
  readonly model: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly wallTimeSec: number | null;
}

/**
 * Coerce a driver-native numeric back to a JS `number` (null-preserving). sqlite
 * returns integers/reals as numbers already; the Postgres driver returns `BIGINT`
 * (int8) columns as *strings* to avoid precision loss (`dispatched_at`, `ts` hold
 * epoch-ms — far past int32). `Number()` is idempotent for numbers, so a single
 * coercion keeps both dialects honest. Guarded so `null` never becomes `0`.
 */
const num = (v: unknown): number | null => (v == null ? null : Number(v));

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

/** Re-nest + validate a flat run row (coercing driver-native numerics). */
const runFromRow = (r: RunRow): Run =>
  decodeRun({
    id: r.id,
    ticketId: r.ticketId,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    dispatchedAt: Number(r.dispatchedAt),
    finishedAt: num(r.finishedAt),
    boxId: r.boxId,
    boxProvider: r.boxProvider,
    usage:
      r.model === null || r.tokensIn === null || r.tokensOut === null || r.wallTimeSec === null
        ? null
        : {
            model: r.model,
            tokensIn: Number(r.tokensIn),
            tokensOut: Number(r.tokensOut),
            wallTimeSec: Number(r.wallTimeSec),
          },
  });

/** Decode a ticket row, coercing the numeric columns off the raw driver row. */
const ticketFromRow = (row: unknown): Ticket => {
  const r = row as Record<string, unknown>;
  return decodeTicket({
    ...r,
    conditions: json(r.conditions),
    prNumber: num(r.prNumber),
    attempts: num(r.attempts),
    contentionCount: num(r.contentionCount),
    workedAttempt: num(r.workedAttempt),
    dispatchedAt: num(r.dispatchedAt),
  });
};

/** Decode for list(): one corrupt historical row must not take down the store. */
const ticketFromRowEither = (row: unknown) => {
  const r = row as Record<string, unknown>;
  let conditions: unknown;
  try {
    conditions = json(r.conditions);
  } catch (e) {
    return Either.left(e);
  }
  return decodeTicketEither({
    ...r,
    conditions,
    prNumber: num(r.prNumber),
    attempts: num(r.attempts),
    contentionCount: num(r.contentionCount),
    workedAttempt: num(r.workedAttempt),
    dispatchedAt: num(r.dispatchedAt),
  });
};

/** Options threading the one portable-DDL difference between backings. */
export interface StoreSqlOptions {
  /** Insertion-order column for deterministic list/history reads. */
  readonly orderBy: 'rowid' | 'seq';
  /** sqlite stores JSON as TEXT; Postgres stores it as JSONB. */
  readonly conditionsAs: 'text' | 'jsonb';
}

/**
 * Build the `TicketStoreApi` over an already-connected `SqlClient` whose schema
 * is present. The caller (sqlite or pg store) owns connecting + migrating; this
 * owns every query.
 */
export const makeStoreApi = (sql: SqlClient, opts: StoreSqlOptions): TicketStoreApi => {
  const order = sql.literal(opts.orderBy);

  const encodeConditions = (t: Pick<Ticket, 'conditions'>): string => JSON.stringify(t.conditions);

  const insertTicket = (t: Ticket) => {
    const conditions = encodeConditions(t);
    return opts.conditionsAs === 'jsonb'
      ? sql`
          INSERT INTO tickets (id, title, body, target, state, phase, conditions, branch, pr_number, pr_id, merge_sha, attempts, contention_count, worked_attempt, reason, work_handle, dispatched_at)
          VALUES (${t.id}, ${t.title}, ${t.body}, ${t.target}, ${t.state}, ${t.phase}, ${conditions}::jsonb, ${t.branch}, ${t.prNumber}, ${t.prId}, ${t.mergeSha}, ${t.attempts}, ${t.contentionCount}, ${t.workedAttempt}, ${t.reason}, ${t.workHandle}, ${t.dispatchedAt})
        `.pipe(Effect.orDie)
      : sql`
          INSERT INTO tickets (id, title, body, target, state, phase, conditions, branch, pr_number, pr_id, merge_sha, attempts, contention_count, worked_attempt, reason, work_handle, dispatched_at)
          VALUES (${t.id}, ${t.title}, ${t.body}, ${t.target}, ${t.state}, ${t.phase}, ${conditions}, ${t.branch}, ${t.prNumber}, ${t.prId}, ${t.mergeSha}, ${t.attempts}, ${t.contentionCount}, ${t.workedAttempt}, ${t.reason}, ${t.workHandle}, ${t.dispatchedAt})
        `.pipe(Effect.orDie);
  };

  const findById = (id: TicketId) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT ${sql.literal(TICKET_COLS)} FROM tickets WHERE id = ${id}`.pipe(
          Effect.orDie,
        );
      const row = rows[0];
      if (row === undefined) return yield* Effect.fail(new TicketNotFound({ id }));
      return ticketFromRow(row);
    });

  return {
    add: (input) =>
      Effect.gen(function* () {
        const base = {
          id: newTicketId(),
          title: input.title,
          body: input.body,
          target: input.target,
          state: 'backlog',
          phase: 'queued',
          conditions: [],
          branch: null,
          prNumber: null,
          prId: null,
          mergeSha: null,
          attempts: 0,
          contentionCount: 0,
          workedAttempt: null,
          reason: null,
          workHandle: null,
          dispatchedAt: null,
        } satisfies Ticket;
        const ticket = decodeTicket(base);
        yield* insertTicket(ticket);
        return ticket;
      }),
    byId: (id) => findById(id),
    list: () =>
      sql`SELECT ${sql.literal(TICKET_COLS)} FROM tickets ORDER BY ${order}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.gen(function* () {
            const tickets: Ticket[] = [];
            for (const row of rows) {
              const decoded = ticketFromRowEither(row);
              if (Either.isRight(decoded)) {
                tickets.push(decoded.right);
                continue;
              }
              yield* Effect.logError('quarantined undecodable ticket row').pipe(
                Effect.annotateLogs({
                  rowId: String((row as Record<string, unknown>).id),
                  decodeFailure: String(decoded.left),
                }),
              );
            }
            return tickets;
          }),
        ),
      ),
    patch: (id, patch) =>
      Effect.gen(function* () {
        const current = yield* findById(id);
        const patched = { ...current, ...patch };
        const updated: Ticket = projectTicket(patched, patch);
        const conditions = encodeConditions(updated);
        yield* (
          opts.conditionsAs === 'jsonb'
            ? sql`
              UPDATE tickets SET
                state = ${updated.state},
                phase = ${updated.phase},
                conditions = ${conditions}::jsonb,
                branch = ${updated.branch},
                pr_number = ${updated.prNumber},
                pr_id = ${updated.prId},
                merge_sha = ${updated.mergeSha},
                attempts = ${updated.attempts},
                contention_count = ${updated.contentionCount},
                worked_attempt = ${updated.workedAttempt},
                reason = ${updated.reason},
                work_handle = ${updated.workHandle},
                dispatched_at = ${updated.dispatchedAt}
              WHERE id = ${id}
            `
            : sql`
              UPDATE tickets SET
                state = ${updated.state},
                phase = ${updated.phase},
                conditions = ${conditions},
                branch = ${updated.branch},
                pr_number = ${updated.prNumber},
                pr_id = ${updated.prId},
                merge_sha = ${updated.mergeSha},
                attempts = ${updated.attempts},
                contention_count = ${updated.contentionCount},
                worked_attempt = ${updated.workedAttempt},
                reason = ${updated.reason},
                work_handle = ${updated.workHandle},
                dispatched_at = ${updated.dispatchedAt}
              WHERE id = ${id}
            `
        ).pipe(Effect.orDie);
        return updated;
      }),
    addRun: (run) =>
      sql`
        INSERT INTO runs (id, ticket_id, kind, status, reason, dispatched_at, finished_at, box_id, box_provider, usage_model, usage_tokens_in, usage_tokens_out, usage_wall_time_sec)
        VALUES (${run.id}, ${run.ticketId}, ${run.kind}, ${run.status}, ${run.reason}, ${run.dispatchedAt}, ${run.finishedAt}, ${run.boxId}, ${run.boxProvider}, ${run.usage?.model ?? null}, ${run.usage?.tokensIn ?? null}, ${run.usage?.tokensOut ?? null}, ${run.usage?.wallTimeSec ?? null})
      `.pipe(Effect.orDie, Effect.asVoid),
    finalizeOpenRun: (ticketId, patch) =>
      Effect.gen(function* () {
        const rows = yield* sql<RunRow>`
          UPDATE runs SET
            status = ${patch.status},
            reason = ${patch.reason},
            finished_at = ${patch.finishedAt},
            usage_model = ${patch.usage?.model ?? null},
            usage_tokens_in = ${patch.usage?.tokensIn ?? null},
            usage_tokens_out = ${patch.usage?.tokensOut ?? null},
            usage_wall_time_sec = ${patch.usage?.wallTimeSec ?? null}
          WHERE id = (
            SELECT id FROM runs
            WHERE ticket_id = ${ticketId} AND status = 'running'
            ORDER BY ${order} DESC
            LIMIT 1
          )
          RETURNING id, ticket_id AS "ticketId", kind, status, reason,
                    dispatched_at AS "dispatchedAt", finished_at AS "finishedAt",
                    box_id AS "boxId", box_provider AS "boxProvider",
                    usage_model AS "model", usage_tokens_in AS "tokensIn",
                    usage_tokens_out AS "tokensOut", usage_wall_time_sec AS "wallTimeSec"
        `.pipe(Effect.orDie);
        const row = rows[0];
        return row === undefined ? null : runFromRow(row);
      }),
    runsFor: (id) =>
      sql<RunRow>`
        SELECT id, ticket_id AS "ticketId", kind, status, reason,
               dispatched_at AS "dispatchedAt", finished_at AS "finishedAt",
               box_id AS "boxId",
               box_provider AS "boxProvider",
               usage_model AS "model", usage_tokens_in AS "tokensIn",
               usage_tokens_out AS "tokensOut", usage_wall_time_sec AS "wallTimeSec"
        FROM runs WHERE ticket_id = ${id} ORDER BY ${order}
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(runFromRow)),
      ),
    appendEvents: (events) =>
      Effect.forEach(
        events,
        (e) =>
          sql`
            INSERT INTO run_events (ticket_id, run_id, box_id, source, ts, level, line)
            VALUES (${e.ticketId}, ${e.runId}, ${e.boxId}, ${e.source}, ${e.ts}, ${e.level}, ${e.line})
          `.pipe(Effect.orDie),
        { discard: true },
      ).pipe(Effect.asVoid),
    eventsFor: (q) =>
      Effect.gen(function* () {
        const conds = [
          ...(q.ticketId === undefined ? [] : [sql`ticket_id = ${q.ticketId}`]),
          ...(q.runId === undefined ? [] : [sql`run_id = ${q.runId}`]),
          ...(q.source === undefined ? [] : [sql`source = ${q.source}`]),
        ];
        const where = conds.length === 0 ? sql`` : sql`WHERE ${sql.and(conds)}`;
        const rows = yield* sql<EventRow>`
          SELECT ticket_id AS "ticketId", run_id AS "runId", box_id AS "boxId",
                 source, ts, level, line
          FROM run_events ${where} ORDER BY ${order}
        `.pipe(Effect.orDie);
        return rows.map((r) => decodeRunEvent({ ...r, ts: Number(r.ts) }));
      }),
  };
};
