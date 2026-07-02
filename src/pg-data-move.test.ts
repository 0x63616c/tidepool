import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Redacted } from 'effect';
import { makeWorkHandle, type Run, type RunEvent } from './domain.ts';
import { newRunId } from './ids.ts';
import { moveSqliteToPg, RowCountMismatch } from './pg-data-move.ts';
import { makePgStore, openPg, type PgStoreConfig } from './pg-store.ts';
import { makeSqliteStore } from './sqlite-store.ts';

/**
 * The one-time cutover data-move, proven against a real Postgres (gated on
 * TIDEPOOL_TEST_PG_URL, same as the pg store contract). Seeds a sqlite db, moves,
 * and asserts the pg store reads back byte-identical domain objects — plus the
 * two invariants that make the move safe: idempotent re-runs and the tenet-8
 * row-count hard-fail.
 */

const PG_URL = process.env.TIDEPOOL_TEST_PG_URL;

let schemaCounter = 0;
const freshSchema = (): string => {
  schemaCounter += 1;
  return `tp_move_${schemaCounter}_${process.pid}`;
};
const freshSqlitePath = (): string =>
  join(tmpdir(), `tp-move-src-${schemaCounter}-${process.pid}.sqlite`);

const seedSqlite = (path: string) =>
  Effect.gen(function* () {
    const store = yield* makeSqliteStore(path);
    const a = yield* store.add({ title: 'Alpha', body: 'g-a', target: 't/repo' });
    const b = yield* store.add({ title: 'Beta', body: 'g-b', target: 't/repo' });
    // Exercise the pg-portability-sensitive columns: epoch-ms BIGINT + workHandle.
    yield* store.patch(a.id, {
      state: 'running',
      workHandle: makeWorkHandle('tp-work-tckt_a-1'),
      dispatchedAt: 1_750_000_000_123,
      attempts: 2,
      contentionCount: 4,
    });
    const run: Run = {
      id: newRunId(),
      ticketId: a.id,
      kind: 'work',
      status: 'succeeded',
      reason: null,
      dispatchedAt: 1_750_000_000_000,
      finishedAt: 1_750_000_000_001,
      boxId: null,
      boxProvider: null,
      usage: { model: 'gpt-5.4-mini', tokensIn: 190, tokensOut: 6, wallTimeSec: 8.3 },
    };
    yield* store.addRun(run);
    const events: ReadonlyArray<RunEvent> = [
      {
        ticketId: a.id,
        runId: run.id,
        boxId: null,
        source: 'runner',
        ts: 1_750_000_000_001,
        level: 'info',
        line: 'first',
      },
      {
        ticketId: a.id,
        runId: run.id,
        boxId: null,
        source: 'opencode',
        ts: 1_750_000_000_002,
        level: null,
        line: 'second',
      },
    ];
    yield* store.appendEvents(events);
    return { a, b, run, events };
  });

if (PG_URL === undefined) {
  describe('pg-data-move', () => {
    it.skip('skipped — set TIDEPOOL_TEST_PG_URL to run the data-move', () => {});
  });
} else {
  const pgConfig = (): PgStoreConfig => ({ url: Redacted.make(PG_URL), schema: freshSchema() });

  it.effect('moves every ticket/run/event faithfully and reports counts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlitePath = freshSqlitePath();
        const seeded = yield* seedSqlite(sqlitePath);
        const pg = pgConfig();

        const report = yield* moveSqliteToPg({ sqlitePath, pg });
        assert.deepStrictEqual(report, { tickets: 2, runs: 1, events: 2 });

        // Read back through the pg store: domain objects must match the source.
        const store = yield* makePgStore(pg);
        const movedA = yield* store.byId(seeded.a.id);
        assert.strictEqual(movedA.state, 'running');
        assert.strictEqual(movedA.workHandle, 'tp-work-tckt_a-1');
        assert.strictEqual(movedA.dispatchedAt, 1_750_000_000_123);
        assert.strictEqual(typeof movedA.dispatchedAt, 'number');
        assert.strictEqual(movedA.attempts, 2);
        assert.strictEqual(movedA.contentionCount, 4);

        const runs = yield* store.runsFor(seeded.a.id);
        assert.deepStrictEqual(runs, [seeded.run]);

        const events = yield* store.eventsFor({ ticketId: seeded.a.id });
        assert.deepStrictEqual(
          events.map((e) => e.line),
          ['first', 'second'],
        );
      }),
    ),
  );

  it.effect('is idempotent — a second move leaves counts unchanged (no doubling)', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlitePath = freshSqlitePath();
        yield* seedSqlite(sqlitePath);
        const pg = pgConfig();

        const first = yield* moveSqliteToPg({ sqlitePath, pg });
        const second = yield* moveSqliteToPg({ sqlitePath, pg });
        assert.deepStrictEqual(first, second);
        assert.deepStrictEqual(second, { tickets: 2, runs: 1, events: 2 });
      }),
    ),
  );

  it.effect('hard-fails RowCountMismatch when the destination already holds extra rows', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlitePath = freshSqlitePath();
        yield* seedSqlite(sqlitePath);
        const pg = pgConfig();

        // Pre-seed the destination with an interloper ticket the source lacks, so
        // the post-move tickets count (3) ≠ source (2) → the tenet-8 gate fires.
        const dest = yield* openPg(pg);
        yield* dest`
          INSERT INTO tickets (id, title, body, target, state, attempts)
          VALUES ('tckt_interloper', 'x', 'g', 't/r', 'backlog', 0)
        `.pipe(Effect.orDie);

        const result = yield* Effect.either(moveSqliteToPg({ sqlitePath, pg }));
        assert.isTrue(
          result._tag === 'Left' &&
            result.left instanceof RowCountMismatch &&
            result.left.table === 'tickets',
        );
      }),
    ),
  );
}
