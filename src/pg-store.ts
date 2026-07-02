import { Reactivity } from '@effect/experimental';
import { BunContext } from '@effect/platform-bun';
import { Migrator } from '@effect/sql';
import * as SqlClient from '@effect/sql/SqlClient';
import { PgClient, PgMigrator } from '@effect/sql-pg';
import { Effect, Layer, type Redacted, type Scope } from 'effect';
import type { TicketStoreApi } from './services.ts';
import { TicketStore } from './services.ts';
import { makeStoreApi } from './store-sql.ts';

/**
 * Postgres-backed `TicketStore` (CNPG datastore under k8s). Same query builder
 * as the sqlite store (tenet 10, one SQL layer) — the ONLY differences are the
 * driver (`@effect/sql-pg`), the schema expressed as `PgMigrator` versioned
 * migrations instead of inline `CREATE TABLE IF NOT EXISTS`, and `seq`-ordering
 * (Postgres has no implicit `rowid`).
 *
 * `PgMigrator` runs on store open: on control-plane boot the store Layer builds,
 * connects to CNPG, applies pending migrations (self-locking, fail-fast → the
 * pod CrashLoopBackOffs rather than serving on a half-applied schema), THEN the
 * reconciler loop starts. `replicas:1 Recreate` ⇒ exactly one migrator ever runs.
 */

/**
 * Versioned schema as typed migration Effects (tenet 10: migration history IS the
 * schema, one source of truth — no second schema generator). Keyed `NNNN_name`
 * per `Migrator.fromRecord`.
 *
 * Postgres-portability fixes vs the sqlite inline DDL (PR-1 authored it against
 * sqlite): epoch-ms columns `dispatched_at` + `ts` are `BIGINT` (sqlite `INTEGER`
 * would be pg `int4` and overflow ~1.75e12); an explicit `seq` IDENTITY column
 * replaces sqlite's implicit `rowid` for insertion-order reads.
 */
const migration0001Init = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE tickets (
      seq BIGINT GENERATED ALWAYS AS IDENTITY,
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
      worked_attempt INTEGER,
      reason TEXT,
      work_handle TEXT,
      dispatched_at BIGINT
    )
  `;
  yield* sql`
    CREATE TABLE runs (
      seq BIGINT GENERATED ALWAYS AS IDENTITY,
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      box_id TEXT,
      box_provider TEXT,
      usage_model TEXT NOT NULL,
      usage_tokens_in INTEGER NOT NULL,
      usage_tokens_out INTEGER NOT NULL,
      usage_wall_time_sec DOUBLE PRECISION NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE run_events (
      seq BIGINT GENERATED ALWAYS AS IDENTITY,
      ticket_id TEXT NOT NULL,
      run_id TEXT,
      box_id TEXT,
      source TEXT NOT NULL,
      ts BIGINT NOT NULL,
      level TEXT,
      line TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX run_events_ticket ON run_events (ticket_id)`;
  yield* sql`CREATE INDEX run_events_run ON run_events (run_id)`;
});

/**
 * The single intent field `goal` became the structured markdown `body` (same
 * NOT NULL constraint, carried in place). A NEW migration — never edit an
 * already-applied one — so existing prod rows keep their content under the new
 * name. The sqlite backing does the same via a guarded `ALTER … RENAME COLUMN`.
 */
const migration0002RenameGoalToBody = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE tickets RENAME COLUMN goal TO body`;
});

/** The migration set, shared by the on-boot migrator and the store open path. */
export const pgMigrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  '0001_init': migration0001Init,
  '0002_rename_goal_to_body': migration0002RenameGoalToBody,
};

/**
 * Apply pending migrations against the ambient `SqlClient`/`PgClient`. Fail-fast:
 * a bad migration surfaces `MigrationError | SqlError`, which `makePgStore` turns
 * into a defect (CrashLoopBackOff on boot, never a half-applied schema).
 */
export const runPgMigrations = PgMigrator.run({ loader: Migrator.fromRecord(pgMigrations) });

export interface PgStoreConfig {
  /** Postgres DSN (`postgresql://…`). Wrapped `Redacted` so it never prints. */
  readonly url: Redacted.Redacted<string>;
  /**
   * Optional isolated schema — set only by tests/CI so each run gets a fresh
   * namespace. Production leaves it undefined and uses the DSN's default schema
   * (`public`) on the CNPG database.
   */
  readonly schema?: string;
}

/**
 * Connect to Postgres, (test-only) isolate a schema, and apply migrations on
 * boot — returning the raw client. Schema/migration failures are defects
 * (`orDie`): fail-fast → CrashLoopBackOff, never a half-applied schema. The
 * data-move Job uses this directly for id-preserving upserts; `makePgStore`
 * layers the shared query builder on top.
 */
export const openPg = (
  config: PgStoreConfig,
): Effect.Effect<PgClient.PgClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    // maxConnections:1 in the schema-isolated (test) path keeps the pooled
    // `SET search_path` sticky across queries; production pools normally.
    const sql = yield* PgClient.make({
      url: config.url,
      maxConnections: config.schema ? 1 : undefined,
    }).pipe(Effect.provide(Reactivity.layer), Effect.orDie);

    if (config.schema !== undefined) {
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql.literal(config.schema)}`.pipe(Effect.orDie);
      yield* sql`SET search_path TO ${sql.literal(config.schema)}`.pipe(Effect.orDie);
    }

    yield* runPgMigrations.pipe(
      Effect.provideService(PgClient.PgClient, sql),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(BunContext.layer),
      Effect.orDie,
    );

    return sql;
  });

/** Open a Postgres `TicketStore`: `openPg` + the shared query builder. */
export const makePgStore = (
  config: PgStoreConfig,
): Effect.Effect<TicketStoreApi, never, Scope.Scope> =>
  Effect.map(openPg(config), (sql) => makeStoreApi(sql, { orderBy: 'seq' }));

/** `TicketStore` Layer over Postgres, for the config-gated live wiring. */
export const makePgTicketStore = (config: PgStoreConfig): Layer.Layer<TicketStore> =>
  Layer.scoped(TicketStore, makePgStore(config));
