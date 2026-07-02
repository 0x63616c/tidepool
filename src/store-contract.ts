import { assert, describe, it } from '@effect/vitest';
import { Effect, HashMap, Logger, type Scope } from 'effect';
import { derivePhaseConditions, type Run, type RunEvent, type Ticket } from './domain.ts';
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
  /** Test hook: insert a persisted ticket row that bypasses domain validation. */
  readonly insertUndecodableTicketRow?: Effect.Effect<string, never, Scope.Scope>;
  /** Test hook: create an old sqlite-style runs table before the store migrates it. */
  readonly createLegacyRunsTable?: Effect.Effect<void, never, Scope.Scope>;
  /** Test hook: create a pre-phase tickets table before the store migrates it. */
  readonly createLegacyTicketsTable?: Effect.Effect<void, never, Scope.Scope>;
  /** Test hook: create run_events before ticket-independent events were allowed. */
  readonly createLegacyRunEventsTable?: Effect.Effect<void, never, Scope.Scope>;
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
            contentionCount: 2,
          });
          assert.strictEqual(patched.state, 'review');
          assert.strictEqual(patched.branch, 'tp/x');
          assert.strictEqual(patched.prNumber, 7);
          assert.strictEqual(patched.contentionCount, 2);
          // The change is durable, not just returned.
          const reread = yield* store.byId(created.id);
          assert.deepStrictEqual(reread, patched);
        }),
      ),
    );

    it.effect('derives phase+conditions for every state on add/patch', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const created = yield* store.add(newTicket);
          assert.deepStrictEqual(
            { phase: created.phase, conditions: created.conditions },
            derivePhaseConditions(created),
          );

          const cases: ReadonlyArray<{
            readonly patch: Parameters<TicketStoreApi['patch']>[1];
            readonly expected: Pick<Ticket, 'phase' | 'conditions'>;
          }> = [
            {
              patch: { state: 'backlog', prNumber: null },
              expected: { phase: 'queued', conditions: [] },
            },
            {
              patch: { state: 'in_progress', prNumber: null },
              expected: { phase: 'working', conditions: [] },
            },
            {
              patch: { state: 'running', prNumber: null },
              expected: { phase: 'working', conditions: [] },
            },
            {
              patch: { state: 'running', prNumber: 7 },
              expected: { phase: 'reviewing', conditions: [] },
            },
            {
              patch: { state: 'review', prNumber: 7 },
              expected: { phase: 'reviewing', conditions: [] },
            },
            { patch: { state: 'done', prNumber: 7 }, expected: { phase: 'done', conditions: [] } },
            {
              patch: { state: 'failed', prNumber: 7 },
              expected: { phase: 'failed', conditions: [] },
            },
            {
              patch: { state: 'rate_capped', prNumber: null },
              expected: { phase: 'working', conditions: [{ type: 'rate_capped' }] },
            },
            {
              patch: { state: 'rate_capped', prNumber: 7 },
              expected: { phase: 'reviewing', conditions: [{ type: 'rate_capped' }] },
            },
          ];

          for (const c of cases) {
            const patched = yield* store.patch(created.id, c.patch);
            assert.deepStrictEqual(
              { phase: patched.phase, conditions: patched.conditions },
              c.expected,
            );
            const reread = yield* store.byId(created.id);
            assert.deepStrictEqual(
              { phase: reread.phase, conditions: reread.conditions },
              c.expected,
            );
          }
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

    it.effect('target breakers persist across reopen', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          yield* store.upsertBreaker({
            target: 't/repo',
            status: 'open',
            reason: 'abc123',
            since: 123,
          });

          const reopened = yield* medium.open;
          assert.deepStrictEqual(yield* reopened.listBreakers(), [
            { target: 't/repo', status: 'open', reason: 'abc123', since: 123 },
          ]);
        }),
      ),
    );

    it.effect('legacy event table accepts ticket-independent events after migration', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          if (medium.createLegacyRunEventsTable === undefined) return;
          yield* medium.createLegacyRunEventsTable;
          const store = yield* medium.open;

          yield* store.appendEvents([
            {
              ticketId: null,
              runId: null,
              boxId: null,
              source: 'control-plane',
              ts: 1,
              level: 'info',
              line: 'system event',
            },
          ]);

          assert.deepStrictEqual(yield* store.eventsFor({}), [
            {
              ticketId: null,
              runId: null,
              boxId: null,
              source: 'control-plane',
              ts: 1,
              level: 'info',
              line: 'system event',
            },
          ]);
        }),
      ),
    );

    it.effect('list quarantines undecodable rows and returns the valid tickets', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          if (medium.insertUndecodableTicketRow === undefined) return;
          const store = yield* medium.open;
          const a = yield* store.add(newTicket);
          const b = yield* store.add({ ...newTicket, title: 'Add chunk' });
          const badId = yield* medium.insertUndecodableTicketRow;
          const logs: Array<{ readonly level: string; readonly line: string }> = [];

          const all = yield* store.list().pipe(
            Effect.provide(
              Logger.replace(
                Logger.defaultLogger,
                Logger.make(({ logLevel, message, annotations }) => {
                  const ann = Array.from(
                    HashMap.entries(annotations),
                    ([k, v]) => `${k}=${String(v)}`,
                  ).join(' ');
                  logs.push({ level: logLevel.label, line: `${String(message)} ${ann}`.trim() });
                }),
              ),
            ),
          );

          assert.deepStrictEqual(
            all.map((t) => t.id),
            [a.id, b.id],
          );
          assert.isTrue(
            logs.some(
              (l) =>
                l.level === 'ERROR' &&
                l.line.includes('quarantined undecodable ticket row') &&
                l.line.includes(badId) &&
                /decode|ParseError|Expected/i.test(l.line),
            ),
            `expected an ERROR quarantine log with raw id and decode failure; got ${JSON.stringify(logs)}`,
          );
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

    it.effect('runsFor returns running, failed, reaped, and succeeded runs in ledger order', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const t = yield* store.add(newTicket);
          const base = {
            ticketId: t.id,
            boxId: null,
            boxProvider: null,
            usage: null,
          } as const;
          const dispatched = {
            ...base,
            id: newRunId(),
            kind: 'work',
            status: 'running',
            reason: null,
            dispatchedAt: 10,
            finishedAt: null,
          } satisfies Run;
          const failed = {
            ...base,
            id: newRunId(),
            kind: 'review',
            status: 'failed',
            reason: 'agent crashed',
            dispatchedAt: 20,
            finishedAt: 30,
          } satisfies Run;
          const reaped = {
            ...base,
            id: newRunId(),
            kind: 'work',
            status: 'reaped',
            reason: 'deadline-exceeded',
            dispatchedAt: 40,
            finishedAt: 50,
          } satisfies Run;
          yield* store.addRun(dispatched);
          yield* store.addRun(failed);
          yield* store.addRun(reaped);
          const finalized = yield* store.finalizeOpenRun(t.id, {
            status: 'succeeded',
            reason: null,
            finishedAt: 60,
            usage: { model: 'm', tokensIn: 1, tokensOut: 2, wallTimeSec: 3 },
          });
          assert.isNotNull(finalized);
          const got = yield* store.runsFor(t.id);
          assert.deepStrictEqual(
            got.map((r) => r.status),
            ['succeeded', 'failed', 'reaped'],
          );
          assert.deepStrictEqual(got[0]?.usage, {
            model: 'm',
            tokensIn: 1,
            tokensOut: 2,
            wallTimeSec: 3,
          });
        }),
      ),
    );

    it.effect('upgraded legacy sqlite runs table accepts dispatch rows with null usage', () =>
      Effect.gen(function* () {
        const medium = yield* makeMedium;
        if (medium.createLegacyRunsTable === undefined) return;
        yield* Effect.scoped(medium.createLegacyRunsTable);
        const runs = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            const t = yield* store.add(newTicket);
            const dispatchRun = {
              id: newRunId(),
              ticketId: t.id,
              kind: 'work',
              status: 'running',
              reason: null,
              dispatchedAt: 100,
              finishedAt: null,
              boxId: null,
              boxProvider: null,
              usage: null,
            } satisfies Run;
            yield* store.addRun(dispatchRun);
            return yield* store.runsFor(t.id);
          }),
        );
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0]?.status, 'running');
        assert.isNull(runs[0]?.usage ?? null);
      }),
    );

    it.effect('upgraded legacy ticket rows are backfilled with derived phase+conditions', () =>
      Effect.gen(function* () {
        const medium = yield* makeMedium;
        if (medium.createLegacyTicketsTable === undefined) return;
        yield* Effect.scoped(medium.createLegacyTicketsTable);
        const tickets = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* medium.open;
            return yield* store.list();
          }),
        );
        const byTitle = new Map(tickets.map((t) => [t.title, t]));
        assert.deepStrictEqual(byTitle.get('Legacy backlog')?.phase, 'queued');
        assert.deepStrictEqual(byTitle.get('Legacy running work')?.phase, 'working');
        assert.deepStrictEqual(byTitle.get('Legacy running review')?.phase, 'reviewing');
        assert.deepStrictEqual(byTitle.get('Legacy rate capped work')?.conditions, [
          { type: 'rate_capped' },
        ]);
        assert.deepStrictEqual(byTitle.get('Legacy rate capped review')?.phase, 'reviewing');
      }),
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
