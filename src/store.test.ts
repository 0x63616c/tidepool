import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reactivity } from '@effect/experimental';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect } from 'effect';
import { makeInMemoryStore } from './fakes.ts';
import { makeSqliteStore, openSqlite } from './sqlite-store.ts';
import { type StoreMedium, storeContract } from './store-contract.ts';

/**
 * The locked `TicketStore` contract, run against BOTH backings: the Ref fake and
 * the real sqlite store. Same behaviours, same assertions — the only difference
 * is durability, which the reopen test exercises directly.
 */

const inMemoryMedium = Effect.gen(function* () {
  const store = yield* makeInMemoryStore;
  return { open: Effect.succeed(store) } satisfies StoreMedium;
});

const sqliteMedium = Effect.sync(() => {
  const path = join(tmpdir(), `tp-store-${Math.random().toString(36).slice(2)}.sqlite`);
  return {
    open: makeSqliteStore(path),
    insertUndecodableTicketRow: Effect.gen(function* () {
      const sql = yield* openSqlite(path);
      const badId = 'tckt_reworkfb0';
      yield* sql`
        INSERT INTO tickets (id, title, body, target, state, attempts)
        VALUES (${badId}, 'Legacy bad id', 'body', 't/repo', 'backlog', 0)
      `.pipe(Effect.orDie);
      return badId;
    }),
    createLegacyRunsTable: Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename: path }).pipe(
        Effect.provide(Reactivity.layer),
      );
      yield* sql`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          box_id TEXT,
          box_provider TEXT,
          usage_model TEXT NOT NULL,
          usage_tokens_in INTEGER NOT NULL,
          usage_tokens_out INTEGER NOT NULL,
          usage_wall_time_sec REAL NOT NULL
        )
      `.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO runs (id, ticket_id, kind, box_id, box_provider, usage_model, usage_tokens_in, usage_tokens_out, usage_wall_time_sec)
        VALUES ('run_legacy', 'tckt_legacy', 'work', NULL, NULL, 'm', 1, 2, 3)
      `.pipe(Effect.orDie);
    }),
    createLegacyTicketsTable: Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename: path }).pipe(
        Effect.provide(Reactivity.layer),
      );
      yield* sql`
        CREATE TABLE tickets (
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
          worked_attempt INTEGER,
          reason TEXT,
          work_handle TEXT,
          dispatched_at INTEGER
        )
      `.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO tickets (id, title, body, target, state, pr_number, attempts)
        VALUES
          ('tckt_legacy0001', 'Legacy backlog', 'body', 't/repo', 'backlog', NULL, 0),
          ('tckt_legacy0002', 'Legacy running work', 'body', 't/repo', 'running', NULL, 0),
          ('tckt_legacy0003', 'Legacy running review', 'body', 't/repo', 'running', 7, 0),
          ('tckt_legacy0004', 'Legacy rate capped work', 'body', 't/repo', 'rate_capped', NULL, 0),
          ('tckt_legacy0005', 'Legacy rate capped review', 'body', 't/repo', 'rate_capped', 7, 0)
      `.pipe(Effect.orDie);
    }),
  } satisfies StoreMedium;
});

storeContract('InMemoryStore', inMemoryMedium);
storeContract('SqliteStore', sqliteMedium);
