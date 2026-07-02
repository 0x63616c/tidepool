import { assert, describe, it } from '@effect/vitest';
import { Effect, Redacted } from 'effect';
import { makeWorkHandle } from './domain.ts';
import { makePgStore, openPg, type PgStoreConfig } from './pg-store.ts';
import { type StoreMedium, storeContract } from './store-contract.ts';

/**
 * The locked `TicketStore` contract, run against the Postgres backing too — the
 * whole point of the cutover. Gated on `TIDEPOOL_TEST_PG_URL` so the default
 * `bun run check` (laptop, no cluster) stays green; CI sets it via a `postgres`
 * service container so the pg path is mechanically gate-enforced (tenet 5).
 *
 * Each medium gets a fresh schema so tests are isolated the way the sqlite suite
 * gets a fresh file per test. Reopening the same schema models a process restart.
 */

const PG_URL = process.env.TIDEPOOL_TEST_PG_URL;

// Deterministic-enough unique schema per medium without Date.now/Math.random in
// the hot path — a module-level counter keyed off a base tag.
let schemaCounter = 0;
const freshSchema = (): string => {
  schemaCounter += 1;
  return `tp_test_${schemaCounter}_${process.pid}`;
};

const pgMediumFor = (url: string) =>
  Effect.sync(() => {
    const config: PgStoreConfig = { url: Redacted.make(url), schema: freshSchema() };
    return {
      open: makePgStore(config),
      insertUndecodableTicketRow: Effect.gen(function* () {
        const sql = yield* openPg(config);
        const badId = 'tckt_reworkfb0';
        yield* sql`
          INSERT INTO tickets (id, title, body, target, state, attempts)
          VALUES (${badId}, 'Legacy bad id', 'body', 't/repo', 'backlog', 0)
        `.pipe(Effect.orDie);
        return badId;
      }),
    } satisfies StoreMedium;
  });

if (PG_URL === undefined) {
  describe('PgStore', () => {
    it.skip('skipped — set TIDEPOOL_TEST_PG_URL to run the Postgres contract', () => {});
  });
} else {
  storeContract('PgStore', pgMediumFor(PG_URL));

  // Portability fix, proven directly: epoch-ms lives in a BIGINT column (sqlite
  // INTEGER → pg int4 would overflow ~1.75e12) and the driver returns BIGINT as a
  // string — the store must coerce it back to a JS number, and it must survive a
  // reopen alongside the `work_handle` column (PR-1's async dispatch state).
  it.effect(
    'dispatchedAt (epoch-ms BIGINT) + workHandle round-trip as typed values across a reopen',
    () =>
      Effect.gen(function* () {
        const medium = yield* pgMediumFor(PG_URL);
        const dispatchedAt = 1_750_000_000_000; // ~2025, far past int32 max
        const id = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            const t = yield* store.add({ title: 'x', body: 'g', target: 't/r' });
            const patched = yield* store.patch(t.id, {
              state: 'running',
              workHandle: makeWorkHandle('tp-work-tckt_x-1'),
              dispatchedAt,
            });
            assert.strictEqual(patched.dispatchedAt, dispatchedAt);
            assert.strictEqual(typeof patched.dispatchedAt, 'number');
            return t.id;
          }),
        );
        const reread = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            return yield* store.byId(id);
          }),
        );
        assert.strictEqual(reread.dispatchedAt, dispatchedAt);
        assert.strictEqual(typeof reread.dispatchedAt, 'number');
        assert.strictEqual(reread.workHandle, 'tp-work-tckt_x-1');
        assert.strictEqual(reread.state, 'running');
      }),
  );
}
