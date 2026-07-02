import { BunRuntime } from '@effect/platform-bun';
import type { SqlClient } from '@effect/sql/SqlClient';
import { Data, Effect, Redacted, type Scope } from 'effect';
import type { Run, RunEvent, Ticket } from './domain.ts';
import { openPg, type PgStoreConfig } from './pg-store.ts';
import type { TicketStoreApi } from './services.ts';
import { openSqlite } from './sqlite-store.ts';
import { makeStoreApi } from './store-sql.ts';

/**
 * One-time sqlite → Postgres data move for the cutover (PR-6 only). A throwaway
 * typed Effect — NOT pgloader — that reads the sqlite repos through the SAME
 * domain types the app uses (so any sqlite-dynamic → pg-strict coercion is caught
 * at compile time, tenet 10) and writes them id-preserving into Postgres.
 *
 * Idempotent: tickets/runs upsert by primary-key id (`ON CONFLICT DO UPDATE`);
 * `run_events` has no natural key, so it is fully replaced (append-only, wholly
 * derivable from source — safe because the destination is empty at cutover). The
 * hard-fail row-count assertion (source vs destination, counted directly on each
 * client) is the tenet-8 safety net: the move never reports success on a partial
 * or doubled load. Runs once at cutover, then the Job is deleted.
 */

export interface MoveReport {
  readonly tickets: number;
  readonly runs: number;
  readonly events: number;
}

/** Hard failure when a destination table's row count ≠ the source's (tenet 8). */
export class RowCountMismatch extends Data.TaggedError('RowCountMismatch')<{
  readonly table: string;
  readonly source: number;
  readonly dest: number;
}> {}

const countRows = (sql: SqlClient, table: 'tickets' | 'runs' | 'run_events') =>
  sql`SELECT count(*) AS n FROM ${sql.literal(table)}`.pipe(
    Effect.orDie,
    Effect.map((rows) => Number((rows[0] as { n: unknown }).n)),
  );

const upsertTicket = (sql: SqlClient, t: Ticket) =>
  sql`
    INSERT INTO tickets (id, title, body, target, state, phase, conditions, branch, pr_number, pr_id, merge_sha, attempts, worked_attempt, reason, work_handle, dispatched_at)
    VALUES (${t.id}, ${t.title}, ${t.body}, ${t.target}, ${t.state}, ${t.phase}, ${JSON.stringify(t.conditions)}::jsonb, ${t.branch}, ${t.prNumber}, ${t.prId}, ${t.mergeSha}, ${t.attempts}, ${t.workedAttempt}, ${t.reason}, ${t.workHandle}, ${t.dispatchedAt})
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title, body = EXCLUDED.body, target = EXCLUDED.target,
      state = EXCLUDED.state, phase = EXCLUDED.phase, conditions = EXCLUDED.conditions,
      branch = EXCLUDED.branch, pr_number = EXCLUDED.pr_number,
      pr_id = EXCLUDED.pr_id, merge_sha = EXCLUDED.merge_sha, attempts = EXCLUDED.attempts,
      worked_attempt = EXCLUDED.worked_attempt, reason = EXCLUDED.reason,
      work_handle = EXCLUDED.work_handle, dispatched_at = EXCLUDED.dispatched_at
  `.pipe(Effect.orDie);

const upsertRun = (sql: SqlClient, r: Run) =>
  sql`
    INSERT INTO runs (id, ticket_id, kind, status, reason, dispatched_at, finished_at, box_id, box_provider, usage_model, usage_tokens_in, usage_tokens_out, usage_wall_time_sec)
    VALUES (${r.id}, ${r.ticketId}, ${r.kind}, ${r.status}, ${r.reason}, ${r.dispatchedAt}, ${r.finishedAt}, ${r.boxId}, ${r.boxProvider}, ${r.usage?.model ?? null}, ${r.usage?.tokensIn ?? null}, ${r.usage?.tokensOut ?? null}, ${r.usage?.wallTimeSec ?? null})
    ON CONFLICT (id) DO UPDATE SET
      ticket_id = EXCLUDED.ticket_id, kind = EXCLUDED.kind, status = EXCLUDED.status,
      reason = EXCLUDED.reason, dispatched_at = EXCLUDED.dispatched_at,
      finished_at = EXCLUDED.finished_at, box_id = EXCLUDED.box_id,
      box_provider = EXCLUDED.box_provider, usage_model = EXCLUDED.usage_model,
      usage_tokens_in = EXCLUDED.usage_tokens_in, usage_tokens_out = EXCLUDED.usage_tokens_out,
      usage_wall_time_sec = EXCLUDED.usage_wall_time_sec
  `.pipe(Effect.orDie);

const insertEvent = (sql: SqlClient, e: RunEvent) =>
  sql`
    INSERT INTO run_events (ticket_id, run_id, box_id, source, ts, level, line)
    VALUES (${e.ticketId}, ${e.runId}, ${e.boxId}, ${e.source}, ${e.ts}, ${e.level}, ${e.line})
  `.pipe(Effect.orDie);

const assertCount = (table: string, source: number, dest: number) =>
  source === dest ? Effect.void : Effect.fail(new RowCountMismatch({ table, source, dest }));

/**
 * Move all app-visible state from the sqlite file to the Postgres database
 * described by `pg`. Both stores are opened here (source read-only via the shared
 * query builder; destination migrated by `openPg`). Fails with `RowCountMismatch`
 * if any table's counts diverge — the caller MUST treat that as a blocked cutover.
 */
export const moveSqliteToPg = (opts: {
  readonly sqlitePath: string;
  readonly pg: PgStoreConfig;
}): Effect.Effect<MoveReport, RowCountMismatch, Scope.Scope> =>
  Effect.gen(function* () {
    const srcSql = yield* openSqlite(opts.sqlitePath);
    const src: TicketStoreApi = makeStoreApi(srcSql, { orderBy: 'rowid', conditionsAs: 'text' });
    const pg = yield* openPg(opts.pg);

    // run_events is append-only with no id → full-replace for idempotent re-runs.
    yield* pg`DELETE FROM run_events`.pipe(Effect.orDie);

    const tickets = yield* src.list();
    yield* Effect.forEach(
      tickets,
      (t) =>
        Effect.gen(function* () {
          yield* upsertTicket(pg, t);
          const runs = yield* src.runsFor(t.id);
          yield* Effect.forEach(runs, (r) => upsertRun(pg, r), { discard: true });
          const events = yield* src.eventsFor({ ticketId: t.id });
          yield* Effect.forEach(events, (e) => insertEvent(pg, e), { discard: true });
        }),
      { discard: true },
    );

    // tenet-8 gate: count each table directly on BOTH clients and hard-fail on
    // divergence, so success is proof of a faithful move — not an assertion.
    const srcTickets = yield* countRows(srcSql, 'tickets');
    const srcRuns = yield* countRows(srcSql, 'runs');
    const srcEvents = yield* countRows(srcSql, 'run_events');
    const destTickets = yield* countRows(pg, 'tickets');
    const destRuns = yield* countRows(pg, 'runs');
    const destEvents = yield* countRows(pg, 'run_events');

    yield* assertCount('tickets', srcTickets, destTickets);
    yield* assertCount('runs', srcRuns, destRuns);
    yield* assertCount('run_events', srcEvents, destEvents);

    return { tickets: destTickets, runs: destRuns, events: destEvents };
  });

/**
 * Cutover entrypoint (the throwaway k8s Job). Reads the sqlite path + Postgres
 * DSN from the environment — the DSN is injected at runtime (CredentialBroker /
 * pod env), never hardcoded or printed. A `RowCountMismatch` (or any defect)
 * exits non-zero → the Job fails → the cutover is blocked, not silently wrong.
 */
if (import.meta.main) {
  const program = Effect.gen(function* () {
    const sqlitePath = process.env.TIDEPOOL_SQLITE_PATH;
    const url = process.env.TIDEPOOL_PG_URL;
    if (sqlitePath === undefined || url === undefined) {
      return yield* Effect.die(
        new Error('data-move requires TIDEPOOL_SQLITE_PATH and TIDEPOOL_PG_URL'),
      );
    }
    const report = yield* moveSqliteToPg({ sqlitePath, pg: { url: Redacted.make(url) } });
    yield* Effect.log(
      `data-move complete: ${report.tickets} tickets, ${report.runs} runs, ${report.events} events`,
    );
  }).pipe(Effect.scoped);
  BunRuntime.runMain(program);
}
