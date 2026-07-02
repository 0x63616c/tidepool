import { assert, describe, it } from '@effect/vitest';
import { Effect, type Scope } from 'effect';
import type { Run, RunEvent } from './domain.ts';
import { newBoxId, newRunId, newTicketId } from './ids.ts';
import type { TicketStoreApi } from './services.ts';

/**
 * Shared `TicketStore` contract. Any backing (Ref fake, sqlite) must satisfy the
 * SAME behaviours, so the suite is parameterised over a `StoreMedium` — a durable
 * medium that can be `open`ed repeatedly. Reopening models a process restart:
 * for the Ref fake `open` returns the one live store; for sqlite it reconnects to
 * the same file. Either way, data written before a reopen must survive it.
 */

export interface StoreMedium {
  /** Open a store over this medium. Repeated opens share the same durable state. */
  readonly open: Effect.Effect<TicketStoreApi, never, Scope.Scope>;
}

const newTicket = { title: 'Add slugify', body: 'add slugify(s)', target: 't/repo' };
const MISSING_ID = newTicketId();

export const storeContract = (name: string, makeMedium: Effect.Effect<StoreMedium>): void => {
  describe(name, () => {
    it.effect('add → byId returns the stored ticket', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const created = yield* store.add(newTicket);
          const fetched = yield* store.byId(created.id);
          assert.deepStrictEqual(fetched, created);
        }),
      ),
    );

    it.effect('patch persists the changed fields', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const created = yield* store.add(newTicket);
          const patched = yield* store.patch(created.id, {
            state: 'review',
            branch: 'tp/x',
            prNumber: 7,
            attempts: 1,
          });
          assert.strictEqual(patched.state, 'review');
          assert.strictEqual(patched.branch, 'tp/x');
          assert.strictEqual(patched.prNumber, 7);
          // The change is durable, not just returned.
          const reread = yield* store.byId(created.id);
          assert.deepStrictEqual(reread, patched);
        }),
      ),
    );

    it.effect('patch of a missing ticket fails with TicketNotFound', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const result = yield* Effect.either(store.patch(MISSING_ID, { state: 'done' }));
          assert.isTrue(result._tag === 'Left' && result.left._tag === 'TicketNotFound');
        }),
      ),
    );

    it.effect('list returns every added ticket', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const a = yield* store.add(newTicket);
          const b = yield* store.add({ ...newTicket, title: 'Add chunk' });
          const all = yield* store.list();
          const ids = all.map((t) => t.id);
          assert.strictEqual(all.length, 2);
          assert.isTrue(ids.includes(a.id) && ids.includes(b.id));
        }),
      ),
    );

    it.effect('addRun → runsFor returns only that ticket’s runs', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const a = yield* store.add(newTicket);
          const b = yield* store.add({ ...newTicket, title: 'Add chunk' });
          const run = {
            id: newRunId(),
            ticketId: a.id,
            kind: 'work',
            status: 'succeeded',
            reason: null,
            dispatchedAt: 100,
            finishedAt: 200,
            boxId: newBoxId(),
            boxProvider: 'hetzner',
            usage: { model: 'm', tokensIn: 100, tokensOut: 50, wallTimeSec: 1 },
          } satisfies Run;
          yield* store.addRun(run);
          const aRuns = yield* store.runsFor(a.id);
          const bRuns = yield* store.runsFor(b.id);
          assert.deepStrictEqual(aRuns, [run]);
          assert.deepStrictEqual(bRuns, []);
        }),
      ),
    );

    it.effect('runsFor returns the full run ledger including failed and reaped runs', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const ticket = yield* store.add(newTicket);
          const mkRun = (kind: Run['kind'], dispatchedAt: number): Run => ({
            id: newRunId(),
            ticketId: ticket.id,
            kind,
            status: 'dispatched',
            reason: null,
            dispatchedAt,
            finishedAt: null,
            boxId: null,
            boxProvider: null,
            usage: { model: 'm', tokensIn: 0, tokensOut: 0, wallTimeSec: 0 },
          });
          const succeeded = mkRun('work', 100);
          const failed = mkRun('review', 200);
          const reaped = mkRun('work', 300);
          yield* store.addRun(succeeded);
          yield* store.addRun(failed);
          yield* store.addRun(reaped);
          yield* store.finalizeRun(succeeded.id, {
            status: 'succeeded',
            reason: null,
            finishedAt: 150,
            usage: { model: 'm', tokensIn: 10, tokensOut: 5, wallTimeSec: 1 },
          });
          yield* store.finalizeRun(failed.id, {
            status: 'failed',
            reason: 'agent boom',
            finishedAt: 250,
          });
          yield* store.finalizeRun(reaped.id, {
            status: 'reaped',
            reason: 'deadline-exceeded',
            finishedAt: 350,
          });

          const runs = yield* store.runsFor(ticket.id);
          assert.deepStrictEqual(
            runs.map((r) => [r.id, r.kind, r.status, r.reason, r.dispatchedAt, r.finishedAt]),
            [
              [succeeded.id, 'work', 'succeeded', null, 100, 150],
              [failed.id, 'review', 'failed', 'agent boom', 200, 250],
              [reaped.id, 'work', 'reaped', 'deadline-exceeded', 300, 350],
            ],
          );
          assert.deepStrictEqual(runs[0]?.usage, {
            model: 'm',
            tokensIn: 10,
            tokensOut: 5,
            wallTimeSec: 1,
          });
          assert.deepStrictEqual(runs[1]?.usage, failed.usage);
          assert.deepStrictEqual(runs[2]?.usage, reaped.usage);
        }),
      ),
    );

    it.effect('appendEvents → eventsFor returns events oldest-first', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const t = yield* store.add(newTicket);
          const runId = newRunId();
          const e1: RunEvent = {
            ticketId: t.id,
            runId,
            boxId: newBoxId(),
            source: 'runner',
            ts: 100,
            level: 'info',
            line: 'first',
          };
          const e2: RunEvent = { ...e1, source: 'opencode', ts: 200, line: 'second' };
          // Append in two batches; read order must be insertion order, not ts.
          yield* store.appendEvents([e1]);
          yield* store.appendEvents([e2]);
          const got = yield* store.eventsFor({ ticketId: t.id });
          assert.deepStrictEqual(
            got.map((e) => e.line),
            ['first', 'second'],
          );
        }),
      ),
    );

    it.effect('eventsFor filters by runId', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const t = yield* store.add(newTicket);
          const runA = newRunId();
          const runB = newRunId();
          const base = { ticketId: t.id, boxId: null, source: 'runner', level: null } as const;
          yield* store.appendEvents([
            { ...base, runId: runA, ts: 1, line: 'a' },
            { ...base, runId: runB, ts: 2, line: 'b' },
          ]);
          const got = yield* store.eventsFor({ runId: runA });
          assert.deepStrictEqual(
            got.map((e) => e.line),
            ['a'],
          );
        }),
      ),
    );

    it.effect('eventsFor filters by source', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const t = yield* store.add(newTicket);
          const base = { ticketId: t.id, runId: null, boxId: null, level: null } as const;
          yield* store.appendEvents([
            { ...base, source: 'opencode', ts: 1, line: 'transcript' },
            { ...base, source: 'control-plane', ts: 2, line: 'failed' },
          ]);
          const got = yield* store.eventsFor({ ticketId: t.id, source: 'control-plane' });
          assert.deepStrictEqual(
            got.map((e) => e.line),
            ['failed'],
          );
        }),
      ),
    );

    it.effect('events written before a reopen survive it', () =>
      Effect.gen(function* () {
        const medium = yield* makeMedium;
        const ticketId = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            const t = yield* store.add(newTicket);
            yield* store.appendEvents([
              {
                ticketId: t.id,
                runId: null,
                boxId: null,
                source: 'control-plane',
                ts: 1,
                level: 'error',
                line: 'boom',
              },
            ]);
            return t.id;
          }),
        );
        const got = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            return yield* store.eventsFor({ ticketId });
          }),
        );
        assert.deepStrictEqual(
          got.map((e) => e.line),
          ['boom'],
        );
      }),
    );

    it.effect('patch reason persists and survives a reopen', () =>
      Effect.gen(function* () {
        const medium = yield* makeMedium;
        const id = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            const t = yield* store.add(newTicket);
            const patched = yield* store.patch(t.id, { state: 'failed', reason: 'rate-capped' });
            assert.strictEqual(patched.reason, 'rate-capped');
            return t.id;
          }),
        );
        const reread = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            return yield* store.byId(id);
          }),
        );
        assert.strictEqual(reread.reason, 'rate-capped');
      }),
    );

    it.effect('data written before a reopen survives it', () =>
      Effect.gen(function* () {
        const medium = yield* makeMedium;
        // First "process": write a ticket, then let its store/connection close.
        const created = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            return yield* store.add(newTicket);
          }),
        );
        // Second "process": reopen the same medium and read it back.
        const fetched = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            return yield* store.byId(created.id);
          }),
        );
        assert.deepStrictEqual(fetched, created);
      }),
    );
  });
};
