import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { fakeAgentWorker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { newPrId } from './ids.ts';
import { step } from './reconciler.ts';
import {
  type AgentWorker,
  type DispatchInput,
  type Forge,
  TicketStore,
  type TicketStoreApi,
} from './services.ts';

/**
 * The transition-table spec — the phase+conditions state machine's DEFINITION
 * (docs/superpowers/plans/2026-07-02-phase-conditions-state-machine.md).
 *
 * Each test is one row: given (phase, conditions, world) → expect
 * (phase′, conditions′, dispatch?). `phase`+`conditions` are authoritative;
 * `state` is a derived legacy projection (asserted only as projection).
 * Wave-3 rows (up-to-date gate, verifying, breaker, contention budget) and
 * wave-4 rows (blocked_by) are added red-first by their own tickets — this
 * file is the table they extend.
 */

const testConfig: Config = defineConfig({
  targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cpx11', locations: ['nbg1'] },
  retries: 3,
});

const newTicket = { title: 'Add slugify', body: 'add slugify(s)', target: 't/repo' };

const baseLayers = (store: TicketStoreApi, config: Config = testConfig) =>
  Layer.merge(Layer.succeed(TicketStore, store), Layer.succeed(AppConfig, config));

const runSteps = (n: number, env: Layer.Layer<TicketStore | Forge | AgentWorker | AppConfig>) =>
  Effect.forEach(Array.from({ length: n }), () => step, { discard: true }).pipe(
    Effect.provide(env),
  );

describe('transition table: queued', () => {
  it.effect('row 1: no gates + capacity free → phase working (no dispatch yet this tick)', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({}),
      );

      yield* runSteps(1, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'working');
      assert.deepStrictEqual(t.conditions, []);
    }),
  );

  it.effect('row 3: capacity full → stays queued, no dispatch', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const occupant = yield* store.add(newTicket);
      yield* store.patch(occupant.id, { phase: 'working' });
      const ticket = yield* store.add({ ...newTicket, title: 'Second' });
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(1, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'queued');
      assert.strictEqual(dispatches.filter((d) => d.ticket.id === ticket.id).length, 0);
    }),
  );
});

describe('transition table: working', () => {
  it.effect('rows 1+4+5: dispatch work (ledger row), poll running, succeed → reviewing', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      // tick 1: queued→working; tick 2: dispatch work; tick 3: harvest success → reviewing
      yield* runSteps(3, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'reviewing');
      assert.isNotNull(t.prNumber);
      const work = (yield* store.runsFor(ticket.id)).filter((r) => r.kind === 'work');
      assert.strictEqual(work.length, 1);
      assert.strictEqual(work[0]?.status, 'succeeded');
    }),
  );

  it.effect('row 7: rate-cap sets rate_capped condition, clears next tick, no attempt', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ pollFails: 'HTTP 429: too many requests' }),
      );

      // tick 1: queued→working; tick 2: dispatch; tick 3: poll fails w/ rate-cap
      yield* runSteps(3, env);
      const capped = yield* store.byId(ticket.id);
      assert.deepStrictEqual(capped.conditions, [{ type: 'rate_capped' }]);
      assert.strictEqual(capped.attempts, 0, 'a rate-cap never spends an attempt');

      // gate clears on next pick — condition removed, ticket progresses again
      yield* runSteps(1, env);
      const cleared = yield* store.byId(ticket.id);
      assert.deepStrictEqual(cleared.conditions, []);
    }),
  );

  it.effect('gate rule: NO dispatch happens while any condition is set', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      yield* store.add(newTicket);
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({
          pollFails: 'HTTP 429: too many requests',
          onDispatch: (d) => dispatches.push(d),
        }),
      );

      yield* runSteps(3, env); // ends rate_capped
      const before = dispatches.length;
      yield* runSteps(1, env); // this tick ONLY clears the gate — no dispatch
      assert.strictEqual(dispatches.length, before);
    }),
  );
});

describe('transition table: reviewing', () => {
  it.effect('row 17: request_changes → phase working, attempt spent, work redispatches', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'reviewing',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'request_changes', onDispatch: (d) => dispatches.push(d) }),
      );

      // tick 1: dispatch review; tick 2: harvest rejection → working; tick 3: rework dispatch
      yield* runSteps(3, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'working');
      assert.strictEqual(t.attempts, 1);
      assert.deepStrictEqual(
        dispatches.map((d) => d.kind),
        ['review', 'work'],
      );
    }),
  );

  it.effect('rows 19-20: external merge settles → done; external close → failed', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const merged = yield* store.add(newTicket);
      yield* store.patch(merged.id, { phase: 'reviewing', prNumber: 1, prId: newPrId() });
      const closed = yield* store.add({ ...newTicket, title: 'Closed one' });
      yield* store.patch(closed.id, { phase: 'reviewing', prNumber: 2, prId: newPrId() });

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green', prState: { 1: 'merged', 2: 'closed' } }),
        fakeAgentWorker({}),
      );
      yield* runSteps(1, env);

      assert.strictEqual((yield* store.byId(merged.id)).phase, 'done');
      const failedT = yield* store.byId(closed.id);
      assert.strictEqual(failedT.phase, 'failed');
      assert.strictEqual(failedT.reason, 'pr-closed-unmerged');
    }),
  );
});

describe('transition table: merging (resumable, idempotent)', () => {
  it.effect('row 16→25: approve harvest lands in phase merging, then merges → done', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'reviewing',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      // tick 1: dispatch review; tick 2: harvest approve → phase merging (merge NOT yet attempted)
      yield* runSteps(2, env);
      const mid = yield* store.byId(ticket.id);
      assert.strictEqual(mid.phase, 'merging');

      // tick 3: merging phase merges idempotently → done
      yield* runSteps(1, env);
      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'done');
      assert.isNotNull(t.mergeSha);
    }),
  );

  it.effect('row 25a: branch behind main → update branch, return to reviewing, no merge', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'merging',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const updates: number[] = [];
      const merges: number[] = [];
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({
          ci: 'green',
          branchUpToDate: false,
          onUpdateBranch: ({ prNumber }) => updates.push(prNumber),
          onMerge: ({ prNumber }) => merges.push(prNumber),
        }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(1, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'reviewing');
      assert.strictEqual(t.attempts, 0, 'freshness update must not spend an attempt');
      assert.strictEqual(t.contentionCount, 1, 'freshness update spends contention budget');
      assert.deepStrictEqual(updates, [7]);
      assert.deepStrictEqual(merges, []);
      assert.strictEqual(dispatches.length, 0);
      const events = yield* store.eventsFor({ ticketId: ticket.id, source: 'control-plane' });
      assert.includeMembers(
        events.map((e) => e.line),
        [
          'merge gate: branch behind main',
          'merge gate: branch updated',
          'phase: merging -> reviewing',
        ],
      );
    }),
  );

  it.effect('row 25b: branch up to date + green + approved → merge proceeds', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'merging',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const updates: number[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({
          branchUpToDate: true,
          onUpdateBranch: ({ prNumber }) => updates.push(prNumber),
        }),
        fakeAgentWorker({}),
      );

      yield* runSteps(1, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'done');
      assert.isNotNull(t.mergeSha);
      assert.deepStrictEqual(updates, []);
      const events = yield* store.eventsFor({ ticketId: ticket.id, source: 'control-plane' });
      assert.include(
        events.map((e) => e.line),
        'merge gate: branch up to date',
      );
    }),
  );

  it.effect('row 25c: update-branch conflict → working rework, no attempt spent, PR reused', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'merging',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ branchUpToDate: false, failUpdateBranch: true }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(2, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'working');
      assert.strictEqual(t.attempts, 0);
      assert.strictEqual(t.contentionCount, 1);
      assert.strictEqual(t.branch, 'tp/x');
      assert.strictEqual(t.prNumber, 7);
      assert.isNull(t.workedAttempt);
      assert.deepStrictEqual(
        dispatches.map((d) => (d.kind === 'work' ? [d.kind, d.branch] : [d.kind, d.prNumber])),
        [['work', 'tp/x']],
      );
      const events = yield* store.eventsFor({ ticketId: ticket.id, source: 'control-plane' });
      assert.includeMembers(
        events.map((e) => e.line),
        [
          'merge gate: branch behind main',
          'merge gate: update conflict',
          'phase: merging -> working',
        ],
      );

      yield* runSteps(1, env);
      const reviewed = yield* store.byId(ticket.id);
      assert.strictEqual(reviewed.phase, 'reviewing');
      assert.strictEqual(reviewed.branch, 'tp/x');
      assert.strictEqual(reviewed.prNumber, 7);
    }),
  );

  it.effect('crash-resume: ticket found in merging with open PR merges WITHOUT any dispatch', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      // Simulate a reconciler that crashed after approve-harvest, before merge.
      yield* store.patch(ticket.id, {
        phase: 'merging',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(1, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'done');
      assert.isNotNull(t.mergeSha);
      assert.strictEqual(t.attempts, 0, 'crash-resume must not burn an attempt');
      assert.strictEqual(dispatches.length, 0, 'idempotent merge needs no agent');
    }),
  );

  it.effect('row 26: merge conflict → phase working, workedAttempt cleared, no attempt spent', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'merging',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
      });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green', failMerge: true }),
        fakeAgentWorker({}),
      );

      yield* runSteps(1, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'working');
      assert.isNull(t.workedAttempt);
      assert.strictEqual(t.attempts, 0);
      assert.strictEqual(t.contentionCount, 1, 'merge 405/409 bounce spends contention budget');
    }),
  );

  it.effect('row 27: successful work resets the contention counter', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'working',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: null,
        contentionCount: 2,
      });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({}),
      );

      yield* runSteps(2, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'reviewing');
      assert.strictEqual(t.contentionCount, 0);
      const events = yield* store.eventsFor({ ticketId: ticket.id, source: 'control-plane' });
      assert.include(
        events.map((e) => e.line),
        'contention count: 2 -> 0 (successful work)',
      );
    }),
  );

  it.effect('row 28: contention cap exhaustion sets needs_human and blocks progress', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'merging',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
        contentionCount: 1,
      });
      const dispatches: DispatchInput[] = [];
      const config = defineConfig({ ...testConfig, contentionRetries: 1 });
      const env = Layer.mergeAll(
        baseLayers(store, config),
        fakeForge({ branchUpToDate: false }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(1, env);

      const capped = yield* store.byId(ticket.id);
      assert.strictEqual(capped.phase, 'merging');
      assert.strictEqual(capped.attempts, 0, 'contention never spends a work attempt');
      assert.strictEqual(capped.contentionCount, 2);
      assert.deepStrictEqual(capped.conditions, [
        {
          type: 'needs_human',
          reason: 'merge contention exceeded budget (2/1): merge gate: branch updated',
        },
      ]);

      yield* runSteps(3, env);
      const blocked = yield* store.byId(ticket.id);
      assert.strictEqual(blocked.phase, 'merging', 'needs_human gate stops progression');
      assert.strictEqual(blocked.attempts, 0, 'needs_human is never auto-failed');
      assert.strictEqual(dispatches.length, 0, 'needs_human never dispatches');
      const events = yield* store.eventsFor({ ticketId: ticket.id, source: 'control-plane' });
      assert.includeMembers(
        events.map((e) => e.line),
        [
          'contention count: 1 -> 2 (merge gate: branch updated)',
          'condition set: needs_human (merge contention exceeded budget (2/1): merge gate: branch updated)',
        ],
      );
    }),
  );
});

describe('transition table: global invariants', () => {
  it.effect('row 36: done and failed are absorbing', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const done = yield* store.add(newTicket);
      yield* store.patch(done.id, { phase: 'done' });
      const failed = yield* store.add({ ...newTicket, title: 'F' });
      yield* store.patch(failed.id, { phase: 'failed' });
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(3, env);

      assert.strictEqual((yield* store.byId(done.id)).phase, 'done');
      assert.strictEqual((yield* store.byId(failed.id)).phase, 'failed');
      assert.strictEqual(dispatches.length, 0);
    }),
  );

  it.effect('row 38 + projection: state is the derived legacy view of phase+conditions', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      yield* runSteps(1, env); // queued → working
      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'working');
      assert.strictEqual(t.state, 'in_progress', 'legacy projection tracks phase');

      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.isTrue(events.length > 0, 'every transition appends a ticket event');
    }),
  );

  it.effect('row 39: needs_human is never auto-failed and never dispatches', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        phase: 'working',
        attempts: 99,
        conditions: [{ type: 'needs_human', reason: 'merge contention exhausted' }],
      });
      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ onDispatch: (d) => dispatches.push(d) }),
      );

      yield* runSteps(3, env);

      const t = yield* store.byId(ticket.id);
      assert.strictEqual(t.phase, 'working');
      assert.strictEqual(t.attempts, 99);
      assert.deepStrictEqual(t.conditions, [
        { type: 'needs_human', reason: 'merge contention exhausted' },
      ]);
      assert.strictEqual(dispatches.length, 0);
    }),
  );
});
