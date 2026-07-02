import { Reactivity } from '@effect/experimental';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, type Scope } from 'effect';
import type { TicketStoreApi } from './services.ts';
import { makeStoreApi } from './store-sql.ts';

/**
 * sqlite-backed `TicketStore` — the durable single source of truth on the main
 * box (`.tidepool/tidepool.sqlite`). Same interface as the Ref fake; the only
 * difference is that state survives the process. Built via `@effect/sql` (the
 * one SQL layer, tenet 10): this owns connecting + inline schema DDL, then hands
 * the client to the shared `makeStoreApi` for every query (rowid-ordered here;
 * the Postgres store shares the exact same query builder, `seq`-ordered).
 */

/**
 * Connect to the sqlite file and ensure the schema exists, returning the raw
 * client. The one-time sqlite→pg data-move opens the source this way to read via
 * the shared query builder AND count rows on the same connection; `makeSqliteStore`
 * layers the store api on top.
 */
export const openSqlite = (
  filename: string,
): Effect.Effect<SqliteClient.SqliteClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.make({ filename }).pipe(Effect.provide(Reactivity.layer));

    yield* sql`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
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
        status TEXT NOT NULL,
        reason TEXT,
        dispatched_at INTEGER NOT NULL,
        finished_at INTEGER,
        box_id TEXT,
        box_provider TEXT,
        usage_model TEXT NOT NULL,
        usage_tokens_in INTEGER NOT NULL,
        usage_tokens_out INTEGER NOT NULL,
        usage_wall_time_sec REAL NOT NULL
      )
    `.pipe(Effect.orDie);

    // Migration: add box_provider column to existing databases (no-op if already present).
    yield* sql`ALTER TABLE runs ADD COLUMN box_provider TEXT`.pipe(Effect.ignore);

    // Migration: run ledger columns. These ALTERs are additive and idempotent;
    // existing success-only rows are backfilled as already-succeeded dispatches.
    yield* sql`ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded'`.pipe(
      Effect.ignore,
    );
    yield* sql`ALTER TABLE runs ADD COLUMN reason TEXT`.pipe(Effect.ignore);
    yield* sql`ALTER TABLE runs ADD COLUMN dispatched_at INTEGER NOT NULL DEFAULT 0`.pipe(
      Effect.ignore,
    );
    yield* sql`ALTER TABLE runs ADD COLUMN finished_at INTEGER`.pipe(Effect.ignore);

    // Migration: add reason column to existing ticket tables (no-op if already present).
    yield* sql`ALTER TABLE tickets ADD COLUMN reason TEXT`.pipe(Effect.ignore);

    // Migration: the single intent field `goal` became the structured markdown
    // `body`. On a fresh DB the CREATE TABLE above already spells it `body`, so
    // this RENAME no-ops (no `goal` column); on an existing DB it carries the old
    // content over in place. `Effect.ignore` makes both orders idempotent. The
    // Postgres backing does the same rename as migration `0002_rename_goal_to_body`.
    yield* sql`ALTER TABLE tickets RENAME COLUMN goal TO body`.pipe(Effect.ignore);

    // Migration: async dispatch+poll columns (no-op if already present). The
    // Postgres backing re-authors these in `PgMigrator` DDL (TEXT→text, and
    // INTEGER→bigint for the epoch-ms `dispatched_at`, which overflows pg int4).
    yield* sql`ALTER TABLE tickets ADD COLUMN work_handle TEXT`.pipe(Effect.ignore);
    yield* sql`ALTER TABLE tickets ADD COLUMN dispatched_at INTEGER`.pipe(Effect.ignore);

    yield* sql`
      CREATE TABLE IF NOT EXISTS run_events (
        ticket_id TEXT NOT NULL,
        run_id TEXT,
        box_id TEXT,
        source TEXT NOT NULL,
        ts INTEGER NOT NULL,
        level TEXT,
        line TEXT NOT NULL
      )
    `.pipe(Effect.orDie);
    yield* sql`CREATE INDEX IF NOT EXISTS run_events_ticket ON run_events (ticket_id)`.pipe(
      Effect.orDie,
    );
    yield* sql`CREATE INDEX IF NOT EXISTS run_events_run ON run_events (run_id)`.pipe(Effect.orDie);

    return sql;
  });

/** sqlite-backed `TicketStore`: `openSqlite` + the shared query builder. */
export const makeSqliteStore = (
  filename: string,
): Effect.Effect<TicketStoreApi, never, Scope.Scope> =>
  Effect.map(openSqlite(filename), (sql) => makeStoreApi(sql, { orderBy: 'rowid' }));
