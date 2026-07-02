import { assert, describe, it } from '@effect/vitest';
import { Duration, Effect, Fiber, HashMap, Layer, Logger, Ref, TestClock } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { makeWorkHandle } from './domain.ts';
import { fakeAgentWorker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { newPrId } from './ids.ts';
import {
  clearCiPending,
  diffDeferred,
  formatCapFull,
  observeCiPending,
  reconcileForever,
  settle,
  step,
} from './reconciler.ts';
import {
  type AgentWorker,
  type DispatchInput,
  Forge,
  TicketStore,
  type TicketStoreApi,
} from './services.ts';

/**
 * Loop-logic validation (DESIGN §Validation, level 1): the reconciler driven to
 * a terminal state against `Fake*` adapters. Free, fast, no infra. Proofs:
 * (a) backlog→…→done via dispatch+poll on green CI + approve, (b) red CI retries
 * to cap then failed, (c) an in_progress ticket with reattach handles is resumed,
 * (d) a review rejection re-works the PR branch (not re-review), plus the async
 * `running` branches: worker-side `Failed` retries and the deadline reaper.
 */

const testConfig: Config = defineConfig({
  targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cpx11', locations: ['nbg1'] },
  retries: 2,
});

const newTicket = { title: 'Add slugify', body: 'add slugify(s)', target: 't/repo' };

const baseLayers = (store: TicketStoreApi) =>
  Layer.merge(Layer.succeed(TicketStore, store), Layer.succeed(AppConfig, testConfig));

/**
 * Run `n` reconciler ticks against ONE built env. The `AgentWorker` fake keeps
 * its dispatched-outcome state in the layer, so a dispatch in one tick and its
 * poll in the next must share the same build (exactly as `settle`/the real loop
 * provide the layer once around the whole loop).
 */
const runSteps = (n: number, env: Layer.Layer<TicketStore | Forge | AgentWorker | AppConfig>) =>
  Effect.forEach(Array.from({ length: n }), () => step, { discard: true }).pipe(
    Effect.provide(env),
  );

describe('reconciler', () => {
  it.effect('(a) happy path: backlog → … → done, exactly one work + one review run', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      yield* settle().pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'done');
      assert.strictEqual(final.phase, 'done');
      assert.deepStrictEqual(final.conditions, []);
      assert.isNotNull(final.mergeSha);
      // The dispatch handle is cleared once the ticket leaves `running`.
      assert.isNull(final.workHandle);
      assert.isNull(final.dispatchedAt);

      const runs = yield* store.runsFor(ticket.id);
      const work = runs.filter((r) => r.kind === 'work');
      const review = runs.filter((r) => r.kind === 'review');
      assert.strictEqual(work.length, 1);
      assert.strictEqual(review.length, 1);
      // Non-zero tokens prove a real run happened (no indexing — avoids non-null assertion).
      const tokensIn = work.reduce((n, r) => n + (r.usage?.tokensIn ?? 0), 0);
      const tokensOut = work.reduce((n, r) => n + (r.usage?.tokensOut ?? 0), 0);
      assert.isTrue(tokensIn > 0);
      assert.isTrue(tokensOut > 0);
      assert.isTrue(runs.every((r) => r.status === 'succeeded' && r.finishedAt !== null));
    }),
  );

  it.effect('(b) red CI: retry to cap → failed, attempts === 2, work runs ONCE (FIX 3)', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'red' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      yield* settle().pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'failed');
      assert.strictEqual(final.phase, 'failed');
      assert.deepStrictEqual(final.conditions, []);
      assert.strictEqual(final.attempts, 2);

      // Red CI is a REVIEW-phase failure: it re-enters review (re-checks CI), it
      // never re-dispatches work against the already-pushed branch. Work ran once.
      const work = (yield* store.runsFor(ticket.id)).filter((r) => r.kind === 'work');
      assert.strictEqual(work.length, 1);
    }),
  );

  it.effect(
    '(c) resume not restart: in_progress with handles advances to review, agent untouched',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);

        // Model a deploy mid-task: this attempt's work already produced the open PR.
        yield* store.patch(ticket.id, {
          state: 'in_progress',
          branch: 'tp/x',
          prNumber: 7,
          prId: newPrId(),
          workedAttempt: 0,
          attempts: 0,
        });

        // Reconstruct the reconciler env with a FRESH agent worker — if it dispatches, work ran.
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({ verdict: 'approve' }),
        );

        yield* step.pipe(Effect.provide(env));

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'review');
        assert.strictEqual(final.phase, 'reviewing');
        assert.deepStrictEqual(final.conditions, []);

        const work = (yield* store.runsFor(ticket.id)).filter((r) => r.kind === 'work');
        assert.strictEqual(work.length, 0);
      }),
  );

  it.effect(
    '(d) FIX 3: a review failure under the cap re-reviews the existing PR — work never re-runs',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);

        // A PR is already open and under review (work succeeded on attempt 0).
        yield* store.patch(ticket.id, {
          state: 'review',
          branch: 'tp/x',
          prNumber: 7,
          prId: newPrId(),
          workedAttempt: 0,
          attempts: 0,
        });

        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({
            verdict: 'request_changes',
            reviewReason: 'Missing verification proof.\nVERDICT: REQUEST_CHANGES',
          }),
        );

        // step 1: review → dispatch review agent → running. step 2: poll the rejection.
        yield* runSteps(2, env);

        const final = yield* store.byId(ticket.id);
        // Re-WORKS from in_progress to address the feedback (not re-review the same
        // unchanged diff), keeping the existing PR/branch; consumes an attempt.
        assert.strictEqual(final.state, 'in_progress');
        assert.strictEqual(final.phase, 'working');
        assert.deepStrictEqual(final.conditions, []);
        assert.strictEqual(final.prNumber, 7);
        assert.strictEqual(final.attempts, 1);
        assert.strictEqual(final.reason, 'Missing verification proof.\nVERDICT: REQUEST_CHANGES');
        assert.isNull(final.workHandle);
        // The next step re-dispatches WORK against the existing branch (the worker
        // force-pushes so the PR updates), rather than re-grading the same diff.
        yield* runSteps(1, env);
        const reworking = yield* store.byId(ticket.id);
        assert.strictEqual(reworking.state, 'running');
        assert.strictEqual(reworking.phase, 'reviewing');
        assert.deepStrictEqual(reworking.conditions, []);
        assert.isNotNull(reworking.workHandle);
      }),
  );

  it.effect('merge conflict bounce re-dispatches work without spending an attempt', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        state: 'review',
        branch: 'tp/x',
        prNumber: 7,
        prId: newPrId(),
        workedAttempt: 0,
        attempts: 0,
      });

      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green', failMerge: true }),
        fakeAgentWorker({ verdict: 'approve', onDispatch: (input) => dispatches.push(input) }),
      );

      // review → dispatch review; poll approve → merge conflict bounce; next tick must re-work.
      yield* runSteps(3, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'running');
      assert.strictEqual(final.attempts, 0, 'merge contention must not spend a work attempt');
      assert.strictEqual(final.prNumber, 7, 'the existing PR is reused by the worker force-push');
      assert.deepStrictEqual(
        dispatches.map((d) => d.kind),
        ['review', 'work'],
      );
      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.strictEqual(events.filter((e) => /MergeConflict/.test(e.line)).length, 1);
    }),
  );

  it.effect('(e) deadline reaper: a worker past maxTtlSec is cancelled and retried', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      // `stuckRunning` → poll never advances, so the ticket sits in `running`
      // until the deadline reaper fires.
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ stuckRunning: true }),
      );

      // backlog → in_progress → dispatch → running (dispatchedAt = t0).
      yield* runSteps(2, env);
      const running = yield* store.byId(ticket.id);
      assert.strictEqual(running.state, 'running');
      assert.isNotNull(running.workHandle);

      // Advance past the 3600s deadline, then step: reaper cancels + retries.
      yield* TestClock.adjust(Duration.seconds(3601));
      yield* runSteps(1, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'in_progress'); // pre-PR failure → re-work
      assert.strictEqual(final.attempts, 1);
      assert.match(final.reason ?? '', /deadline/);
      assert.isNull(final.workHandle);
      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.isAtLeast(events.filter((e) => /deadline/.test(e.line)).length, 1);
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, 'reaped');
      assert.strictEqual(runs[0]?.reason, 'deadline-exceeded');
    }),
  );

  it.effect('(f) in_progress dispatches: stores workHandle + dispatchedAt, moves to running', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, { state: 'in_progress' });

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      yield* runSteps(1, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'running');
      assert.strictEqual(final.phase, 'working');
      assert.deepStrictEqual(final.conditions, []);
      assert.isNotNull(final.workHandle); // reattach handle persisted
      assert.isNotNull(final.dispatchedAt); // deadline clock persisted
      assert.isNotNull(final.branch); // branch fixed at dispatch
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.kind, 'work');
      assert.strictEqual(runs[0]?.status, 'running');
      assert.strictEqual(runs[0]?.dispatchedAt, final.dispatchedAt);
      assert.isNull(runs[0]?.usage ?? null);
      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.isTrue(
        events.some((e) => e.runId === runs[0]?.id && /run dispatched: work/.test(e.line)),
      );
    }),
  );

  it.effect('(h) admission gate: workers.max=1 with 3 ready tickets dispatches exactly one', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const t1 = yield* store.add(newTicket);
      const t2 = yield* store.add({ ...newTicket, title: 'Add foo' });
      const t3 = yield* store.add({ ...newTicket, title: 'Add bar' });

      const dispatches: DispatchInput[] = [];
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve', onDispatch: (input) => dispatches.push(input) }),
      );

      // round 1: the gate now sits AT the backlog exit — only the oldest ticket
      // (t1) is admitted into `in_progress`; t2/t3 stay `backlog` (no free slot).
      // round 2: t1 (in_progress) dispatches — no second gate needed, it already
      // holds the one slot it was admitted with.
      yield* runSteps(2, env);

      assert.strictEqual(dispatches.length, 1, 'exactly one dispatch under workers.max=1');

      const finals = yield* Effect.forEach([t1, t2, t3], (t) => store.byId(t.id));
      const running = finals.filter((t) => t.state === 'running');
      // Blocked tickets never leave `backlog` — the whole-pipeline cap (Decision 1)
      // gates admission itself, not just the dispatch that used to follow it.
      const stillWaiting = finals.filter((t) => t.state === 'backlog');
      assert.strictEqual(running.length, 1);
      assert.strictEqual(stillWaiting.length, 2);
    }),
  );

  it.effect(
    '(i) admission gate: workers.max=1 with one ticket already running blocks a backlog ticket',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const runningTicket = yield* store.add(newTicket);
        yield* store.patch(runningTicket.id, {
          state: 'running',
          workHandle: makeWorkHandle('wh_seed'),
          dispatchedAt: 0,
        });
        const backlogTicket = yield* store.add({ ...newTicket, title: 'Add foo' });

        const dispatches: DispatchInput[] = [];
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({ stuckRunning: true, onDispatch: (input) => dispatches.push(input) }),
        );

        // The backlog ticket never even leaves `backlog` — the gate blocks it at
        // the door, before it would consume the (already-occupied) one slot.
        yield* runSteps(2, env);

        assert.strictEqual(dispatches.length, 0, 'no dispatch while the one slot is occupied');
        const finalBacklog = yield* store.byId(backlogTicket.id);
        assert.strictEqual(finalBacklog.state, 'backlog');
        assert.strictEqual(finalBacklog.phase, 'queued');
        assert.deepStrictEqual(finalBacklog.conditions, []);
      }),
  );

  it.effect(
    '(j) whole-pipeline cap: a ticket in `review` (no live Job yet) still blocks a backlog ticket',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        // A ticket at the review stage — CI-checked, PR open, but no agent-worker
        // dispatched yet. Under the OLD `running`-only cap this wouldn't count;
        // Decision 1 makes the whole pipeline (backlog..review) count.
        const reviewTicket = yield* store.add(newTicket);
        yield* store.patch(reviewTicket.id, {
          state: 'review',
          branch: 'tp/x',
          prNumber: 7,
          prId: newPrId(),
          workedAttempt: 0,
          attempts: 0,
        });
        const backlogTicket = yield* store.add({ ...newTicket, title: 'Add foo' });

        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'pending' }), // review ticket parked mid-CI-check, no dispatch
          fakeAgentWorker({ verdict: 'approve' }),
        );

        yield* runSteps(1, env);

        const finalBacklog = yield* store.byId(backlogTicket.id);
        assert.strictEqual(finalBacklog.state, 'backlog', 'review-stage ticket holds the slot');
      }),
  );

  it.effect(
    '(k) mixed work+review at cap (max=2): both occupy slots, review still dispatches, a 3rd is blocked',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const workTicket = yield* store.add(newTicket); // occupies via `running` (work in flight)
        yield* store.patch(workTicket.id, {
          state: 'running',
          workHandle: makeWorkHandle('wh_work'),
          dispatchedAt: 0,
        });
        const reviewTicket = yield* store.add({ ...newTicket, title: 'Add foo' }); // occupies via `review`
        yield* store.patch(reviewTicket.id, {
          state: 'review',
          branch: 'tp/y',
          prNumber: 9,
          prId: newPrId(),
          workedAttempt: 0,
          attempts: 0,
        });
        const backlogTicket = yield* store.add({ ...newTicket, title: 'Add baz' }); // 3rd, over cap

        const dispatches: DispatchInput[] = [];
        const maxTwo: Config = { ...testConfig, workers: { ...testConfig.workers, max: 2 } };
        const env = Layer.mergeAll(
          Layer.merge(Layer.succeed(TicketStore, store), Layer.succeed(AppConfig, maxTwo)),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({
            stuckRunning: true,
            onDispatch: (input) => dispatches.push(input),
          }),
        );

        yield* runSteps(1, env);

        // The review ticket already held its slot (whole-pipeline cap, Decision 1)
        // — it is NOT re-gated at its own dispatch site; it dispatches normally.
        assert.strictEqual(dispatches.length, 1);
        assert.strictEqual(dispatches[0]?.kind, 'review');
        const finalReview = yield* store.byId(reviewTicket.id);
        assert.strictEqual(finalReview.state, 'running');

        // 2 slots occupied (workTicket running, reviewTicket now running too) —
        // the 3rd ticket stays blocked in backlog.
        const finalBacklog = yield* store.byId(backlogTicket.id);
        assert.strictEqual(finalBacklog.state, 'backlog');
      }),
  );

  it.effect(
    '(l) a failure frees the slot for the OLDEST deferred ticket (FIFO), which then dispatches',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const t1 = yield* store.add(newTicket); // already running, about to fail permanently
        yield* store.patch(t1.id, {
          state: 'running',
          workHandle: makeWorkHandle('wh_t1'),
          dispatchedAt: 0,
        });
        const t2 = yield* store.add({ ...newTicket, title: 'Add foo' }); // older waiter
        const t3 = yield* store.add({ ...newTicket, title: 'Add bar' }); // newer waiter

        const oneRetry: Config = { ...testConfig, retries: 1 };
        const env = Layer.mergeAll(
          Layer.merge(Layer.succeed(TicketStore, store), Layer.succeed(AppConfig, oneRetry)),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({ verdict: 'approve', pollFails: 'worker crashed' }),
        );

        // step 1: t1's poll fails and (retries=1) immediately fails the ticket,
        // freeing its slot within the SAME round; t2 (oldest waiter) is admitted
        // into `in_progress`; t3 stays `backlog` (still no free slot).
        yield* runSteps(1, env);
        const afterFail = yield* Effect.forEach([t1, t2, t3], (t) => store.byId(t.id));
        assert.strictEqual(afterFail[0]?.state, 'failed');
        assert.strictEqual(afterFail[1]?.state, 'in_progress', 't2 (oldest waiter) admitted');
        assert.strictEqual(afterFail[2]?.state, 'backlog', 't3 (newer waiter) still blocked');

        // step 2: t2 actually dispatches (reaches `running`); t3 is still blocked.
        yield* runSteps(1, env);
        const afterDispatch = yield* Effect.forEach([t2, t3], (t) => store.byId(t.id));
        assert.strictEqual(afterDispatch[0]?.state, 'running', 't2 dispatches once admitted');
        assert.strictEqual(afterDispatch[1]?.state, 'backlog');
      }),
  );

  it.effect('(g) running + poll Running: waits, no transition, no run recorded', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ stuckRunning: true }),
      );

      // in_progress → running, then two more ticks that only observe `Running`.
      yield* runSteps(4, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'running'); // stayed put — poll said Running
      assert.isNotNull(final.workHandle);
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, 'running');
    }),
  );
});

/**
 * Closed-loop PR-state reconciliation (tri-state). Before this fix, a ticket
 * only reached `done` as a side-effect of the reconciler's OWN successful
 * `forge.merge()` call — the reconciler never asked GitHub "is this PR merged?"
 * So an external merge, a crash between `forge.merge` succeeding and the
 * `done` patch landing, or a merge call that succeeded remotely but errored
 * client-side all left the ticket non-terminal, and the next tick re-dispatched
 * it — opening a DUPLICATE PR and permanently holding a whole-pipeline cap slot.
 *
 * The fix: for any ticket with a PR, `forge.prState` (ground truth) is read
 * FIRST — before any CI check, review dispatch, or merge attempt — and branches
 * tri-state: merged → `done`, closed-unmerged → `failed` (no retry), open →
 * proceed exactly as before.
 */
describe('reconciler: closed-loop PR-state reconciliation (tri-state)', () => {
  /** Patch a freshly-added ticket into a `review` state (PR already open). */
  const reviewReady = (store: TicketStoreApi, id: Parameters<TicketStoreApi['patch']>[0]) =>
    store.patch(id, {
      state: 'review',
      branch: 'tp/x',
      prNumber: 7,
      prId: newPrId(),
      workedAttempt: 0,
      attempts: 0,
    });

  it.effect(
    'PR merged externally while ticket sits in review → done (with merge_sha), no CI check, no dispatch',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        yield* reviewReady(store, ticket.id);

        const dispatches: DispatchInput[] = [];
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ prLifecycle: 'merged', mergeSha: 'deadbeef' }),
          fakeAgentWorker({ verdict: 'approve', onDispatch: (input) => dispatches.push(input) }),
        );

        yield* runSteps(1, env);

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'done');
        assert.strictEqual(final.mergeSha, 'deadbeef');
        assert.isNull(final.workHandle);
        assert.strictEqual(
          dispatches.length,
          0,
          'no review agent dispatched once ground truth already says merged',
        );
      }),
  );

  it.effect(
    'PR closed without merge while ticket sits in review → failed, no retry, no dispatch',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        yield* reviewReady(store, ticket.id);

        const dispatches: DispatchInput[] = [];
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ prLifecycle: 'closed' }),
          fakeAgentWorker({ verdict: 'approve', onDispatch: (input) => dispatches.push(input) }),
        );

        yield* runSteps(1, env);

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'failed');
        assert.isNotNull(final.reason);
        assert.strictEqual(
          dispatches.length,
          0,
          'a deliberately-closed PR must not loop into a retry',
        );
      }),
  );

  it.effect(
    'PR still open + CI green → dispatches review exactly as before (unchanged behavior)',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        yield* reviewReady(store, ticket.id);

        const dispatches: DispatchInput[] = [];
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ prLifecycle: 'open', ci: 'green' }),
          fakeAgentWorker({ verdict: 'approve', onDispatch: (input) => dispatches.push(input) }),
        );

        yield* runSteps(1, env);

        assert.strictEqual(dispatches.length, 1);
        assert.strictEqual(dispatches[0]?.kind, 'review');
        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'running');
        const runs = yield* store.runsFor(ticket.id);
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0]?.kind, 'review');
        assert.strictEqual(runs[0]?.status, 'running');
      }),
  );

  it.effect(
    'idempotent merge: a crash between forge.merge succeeding and the done-patch landing settles ' +
      'from ground truth next tick, WITHOUT a duplicate merge call',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        yield* reviewReady(store, ticket.id);

        const mergeCalls: number[] = [];
        const prStateCalls = yield* Ref.make(0);
        // A one-off Forge double: `prState` reports 'open' on its first call (the
        // review step's own tri-state check) then 'merged' from the second call
        // onward — simulating a merge that succeeded on GitHub moments before a
        // control-plane crash wiped out the in-flight `done` patch.
        const forgeApi = {
          openPR: () => Effect.die('should not open a duplicate PR'),
          prState: () =>
            Effect.map(
              Ref.updateAndGet(prStateCalls, (n) => n + 1),
              (n) =>
                n === 1
                  ? { state: 'open' as const, mergeSha: null }
                  : { state: 'merged' as const, mergeSha: 'deadbeef' },
            ),
          checks: () => Effect.succeed('green' as const),
          merge: (input: { readonly repo: string; readonly prNumber: number }) => {
            mergeCalls.push(input.prNumber);
            return Effect.succeed({ sha: 'should-not-be-used' });
          },
        };
        const crashProneForge = Layer.succeed(Forge, forgeApi);

        const env = Layer.mergeAll(
          baseLayers(store),
          crashProneForge,
          fakeAgentWorker({ verdict: 'approve' }),
        );

        // step 1: review → prState 'open' (call #1) → CI green → dispatch review → running.
        // step 2: poll Succeeded/Review(approve) → prState 'merged' (call #2, the
        // post-crash re-observation) → settle done WITHOUT calling forge.merge.
        yield* runSteps(2, env);

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'done');
        assert.strictEqual(final.mergeSha, 'deadbeef');
        assert.strictEqual(
          mergeCalls.length,
          0,
          'idempotent: no duplicate merge once ground truth already shows merged',
        );

        // A further tick is a no-op: the ticket is terminal.
        yield* runSteps(1, env);
        const again = yield* store.byId(ticket.id);
        assert.strictEqual(again.state, 'done');
        assert.strictEqual(mergeCalls.length, 0);
      }),
  );
});

/**
 * `reconcileForever` is the always-on loop behind `tp run --watch`: it just
 * re-invokes `settle` on a cadence. The invariant under test is resilience — a
 * round that *dies* (defect) must not crash the loop; the next tick re-reads the
 * durable store and resumes. `settle` stays the only mover.
 */
describe('reconcileForever', () => {
  /** A store whose first `list()` dies (defect), then behaves like the real one. */
  const flakyOnceStore = Effect.gen(function* () {
    const real = yield* makeInMemoryStore;
    const calls = yield* Ref.make(0);
    const store: TicketStoreApi = {
      ...real,
      list: () =>
        Effect.flatMap(
          Ref.updateAndGet(calls, (n) => n + 1),
          (n) => (n === 1 ? Effect.die(new Error('boom: round 1 store read failed')) : real.list()),
        ),
    };
    return { store, calls };
  });

  it.effect('survives a thrown round and re-reads the store next tick', () =>
    Effect.gen(function* () {
      const { calls, store } = yield* flakyOnceStore;
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      // Fork the forever-loop; round 1 (t=0) dies and is swallowed, then it
      // sleeps for the interval. Advancing the test clock wakes the next round.
      const fiber = yield* reconcileForever(30).pipe(Effect.provide(env), Effect.fork);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Fiber.interrupt(fiber);

      // >1 read proves: the first read threw AND a later tick re-read the store —
      // the loop neither crashed nor got stuck on the failed round.
      assert.isAtLeast(yield* Ref.get(calls), 2);
    }),
  );

  /** Counts `settle` rounds via `list()` (one read per round) to assert cadence. */
  const countingStore = Effect.gen(function* () {
    const real = yield* makeInMemoryStore;
    const calls = yield* Ref.make(0);
    const store: TicketStoreApi = {
      ...real,
      list: () =>
        Effect.zipRight(
          Ref.update(calls, (n) => n + 1),
          real.list(),
        ),
    };
    return { store, calls };
  });

  it.effect('defaults to a 5s cadence when no interval is passed', () =>
    Effect.gen(function* () {
      const { calls, store } = yield* countingStore;
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      // Round 1 runs at t=0, then the loop sleeps for the default interval.
      // Advancing only 5s wakes a second round iff the default cadence is 5s
      // (at the old 30s default the loop is still asleep → only one read).
      const fiber = yield* reconcileForever().pipe(Effect.provide(env), Effect.fork);
      yield* TestClock.adjust(Duration.seconds(20));
      yield* Fiber.interrupt(fiber);

      // Over a 20s window: at the old 30s default only round 1 (t=0) has run; at
      // 5s the rounds at t=0,5,10,15,20 have all run — many more store reads. The
      // threshold sits well above one round's reads and well below five rounds'.
      const n = yield* Ref.get(calls);
      yield* Effect.logInfo(`cadence rounds proxy: ${n} list() calls in 20s`);
      assert.isAtLeast(n, 5);
    }),
  );
});

/**
 * Observability: every typed failure must leave a durable trace — a `reason` on
 * the ticket, control-plane/error events, and finalized run ledger rows — and a successful run
 * must persist whatever the worker captured, linked to that run's id.
 */
describe('reconciler observability', () => {
  /** Put a freshly-added ticket into in_progress so the next `step` dispatches work. */
  const inProgress = (store: TicketStoreApi, attempts: number) =>
    Effect.gen(function* () {
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, { state: 'in_progress', attempts });
      return ticket;
    });

  it.effect('dispatch AgentFailed under the cap → in_progress + reason + attempts bumped', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* inProgress(store, 0);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ failWork: 'agent' }),
      );

      yield* step.pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'in_progress');
      assert.strictEqual(final.attempts, 1);
      assert.isNotNull(final.reason);

      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.isTrue(events.some((e) => e.source === 'control-plane' && e.level === 'error'));
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, 'failed');
    }),
  );

  it.effect('dispatch AgentFailed at the cap → failed + reason', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* inProgress(store, 1); // retries === 2, so the next bump fails it
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ failWork: 'agent' }),
      );

      yield* step.pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'failed');
      assert.strictEqual(final.attempts, 2);
      assert.isNotNull(final.reason);
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, 'failed');
    }),
  );

  it.effect('worker-side poll Failed → retried + control-plane/error event', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* inProgress(store, 0);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ pollFails: 'worker exited non-zero' }),
      );

      // step 1: dispatch → running. step 2: poll reports Failed → classify → retry.
      yield* runSteps(2, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'in_progress');
      assert.strictEqual(final.attempts, 1);
      assert.isNotNull(final.reason);
      assert.isNull(final.workHandle);
      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.isTrue(events.some((e) => e.source === 'control-plane' && e.level === 'error'));
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, 'failed');
      assert.strictEqual(runs[0]?.reason, 'worker exited non-zero');
    }),
  );

  it.effect('worker-side poll Failed retries after 2 failures and fails on the 3rd', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* inProgress(store, 1);
      const threeRetryConfig: Config = { ...testConfig, retries: 3 };
      const env = Layer.mergeAll(
        Layer.merge(Layer.succeed(TicketStore, store), Layer.succeed(AppConfig, threeRetryConfig)),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ pollFails: 'worker exited non-zero' }),
      );

      yield* runSteps(2, env);

      const afterSecondFailure = yield* store.byId(ticket.id);
      assert.strictEqual(afterSecondFailure.state, 'in_progress');
      assert.strictEqual(afterSecondFailure.attempts, 2);

      yield* runSteps(2, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'failed');
      assert.strictEqual(final.attempts, 3);
    }),
  );

  it.effect("dispatch RateCapped → rate_capped + reason 'rate-capped' + event", () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* inProgress(store, 0);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ failWork: 'rate' }),
      );

      yield* step.pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'rate_capped');
      assert.strictEqual(final.reason, 'rate-capped');
      const events = yield* store.eventsFor({ ticketId: ticket.id });
      assert.isTrue(events.some((e) => e.source === 'control-plane'));
      const runs = yield* store.runsFor(ticket.id);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, 'failed');
      assert.strictEqual(runs[0]?.reason, 'rate-capped');
    }),
  );

  it.effect('worker-side poll Failed with a rate-limit reason → rate_capped (not a retry)', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* inProgress(store, 0);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ pollFails: 'HTTP 429 rate limit exceeded' }),
      );

      yield* runSteps(2, env);

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'rate_capped');
      assert.strictEqual(final.reason, 'rate-capped');
    }),
  );

  it.effect(
    'successful work → one opencode + one runner + one cloud-init event on the run id',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({
            verdict: 'approve',
            transcript: [{ type: 'message', text: 'hi' }],
            workerStderr: 'worker boot ok',
            cloudInitLog: 'cloud-init done',
          }),
        );

        yield* settle().pipe(Effect.provide(env));

        const workRun = (yield* store.runsFor(ticket.id)).find((r) => r.kind === 'work');
        assert.isDefined(workRun);
        const events = yield* store.eventsFor({ ticketId: ticket.id });
        const first = (s: string) => events.find((e) => e.source === s);
        const count = (s: string) => events.filter((e) => e.source === s).length;
        assert.strictEqual(count('opencode'), 1);
        assert.strictEqual(count('runner'), 1);
        assert.strictEqual(count('cloud-init'), 1);
        // All three captures are linked to the work run.
        const runId = workRun?.id ?? null;
        const opencode = first('opencode');
        const runner = first('runner');
        const cloudInit = first('cloud-init');
        assert.isDefined(opencode);
        assert.isDefined(runner);
        assert.isDefined(cloudInit);
        assert.strictEqual(opencode.runId, runId);
        assert.strictEqual(runner.runId, runId);
        assert.strictEqual(cloudInit.runId, runId);
        // The opencode line is the serialized transcript (what `tp transcript` parses).
        assert.deepStrictEqual(JSON.parse(opencode.line), [{ type: 'message', text: 'hi' }]);
      }),
  );
});

describe('reconciler logging (stdout observability)', () => {
  // Fold message + annotations into one string so tests can assert on structured
  // fields the default (kubectl-visible) logger renders inline.
  const captureInto = (sink: string[]) =>
    Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, annotations }) => {
        const ann = Array.from(HashMap.entries(annotations), ([k, v]) => `${k}=${String(v)}`).join(
          ' ',
        );
        sink.push(`${String(message)} ${ann}`.trim());
      }),
    );

  it.effect('emits a dispatch log carrying the ticket id + target (the silent-failure path)', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      // backlog → in_progress → dispatch work.
      yield* runSteps(2, env).pipe(Effect.provide(captureInto(logs)));

      assert.isTrue(
        logs.some((l) => /dispatch/i.test(l) && l.includes(ticket.id) && l.includes('t/repo')),
        `expected a dispatch log with the ticket id + target; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('logs a boot banner naming the loaded targets when the loop starts', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      const fiber = yield* reconcileForever(30).pipe(
        Effect.provide(env),
        Effect.provide(captureInto(logs)),
        Effect.fork,
      );
      yield* TestClock.adjust(Duration.millis(1)); // let the banner emit before the first spaced tick
      yield* Fiber.interrupt(fiber);

      assert.isTrue(
        logs.some((l) => /reconciler loop started/i.test(l) && l.includes('t/repo')),
        `expected a boot banner naming the targets; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('stamps the short git sha onto the boot banner (and every reconciler log line)', () =>
    Effect.gen(function* () {
      const original = process.env.TIDEPOOL_GIT_SHA;
      process.env.TIDEPOOL_GIT_SHA = 'abc1234def5678';
      const store = yield* makeInMemoryStore;
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      const fiber = yield* reconcileForever(30).pipe(
        Effect.provide(env),
        Effect.provide(captureInto(logs)),
        Effect.fork,
      );
      yield* TestClock.adjust(Duration.millis(1)); // let the banner emit before the first spaced tick
      yield* Fiber.interrupt(fiber);
      if (original === undefined) delete process.env.TIDEPOOL_GIT_SHA;
      else process.env.TIDEPOOL_GIT_SHA = original;

      assert.isTrue(
        logs.some((l) => /reconciler loop started/i.test(l) && l.includes('sha=abc1234')),
        `expected the boot banner to carry the short git sha; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('renders a rocket on the "reconciler loop started" boot banner', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      const fiber = yield* reconcileForever(30).pipe(
        Effect.provide(env),
        Effect.provide(captureInto(logs)),
        Effect.fork,
      );
      yield* TestClock.adjust(Duration.millis(1));
      yield* Fiber.interrupt(fiber);

      assert.isTrue(
        logs.some((l) => l.includes('🚀') && /reconciler loop started/i.test(l)),
        `expected the boot banner to include a rocket; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('logs CI-pending ONCE per streak, not on every tick (quiets the poll)', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        state: 'review',
        branch: 'tp/x',
        prNumber: 1,
        prId: newPrId(),
      });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'pending' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      // Three ticks, CI pending throughout — the reconciler should only log
      // the pending-observed line ONCE, not every tick (the noise this PR quiets).
      yield* runSteps(3, env).pipe(Effect.provide(captureInto(logs)));

      const pendingLogs = logs.filter((l) => /CI pending/i.test(l));
      assert.strictEqual(
        pendingLogs.length,
        1,
        `expected exactly one CI-pending log across 3 ticks; got: ${JSON.stringify(logs)}`,
      );
      assert.isTrue(pendingLogs[0]?.includes('pr=1'));
    }),
  );

  it.effect('logs review verdict + reason once the review agent finishes', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        state: 'review',
        branch: 'tp/x',
        prNumber: 1,
        prId: newPrId(),
      });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({
          verdict: 'request_changes',
          reviewReason: 'missing tests for edge case',
        }),
      );
      const logs: string[] = [];
      // review → dispatch review agent → running; next tick harvests the verdict.
      yield* runSteps(2, env).pipe(Effect.provide(captureInto(logs)));

      assert.isTrue(
        logs.some(
          (l) =>
            /review verdict/i.test(l) &&
            l.includes('verdict=request_changes') &&
            l.includes('missing tests for edge case'),
        ),
        `expected a verdict+reason log; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('logs a clear transition when a backlog ticket is admitted to in_progress', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      yield* runSteps(1, env).pipe(Effect.provide(captureInto(logs)));

      assert.isTrue(
        logs.some(
          (l) =>
            l.includes(ticket.id) && l.includes('from=backlog') && l.includes('to=in_progress'),
        ),
        `expected an admit transition log; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('logs a clear transition when a rate_capped ticket is re-picked', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, { state: 'rate_capped' });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      yield* runSteps(1, env).pipe(Effect.provide(captureInto(logs)));

      assert.isTrue(
        logs.some(
          (l) =>
            l.includes(ticket.id) && l.includes('from=rate_capped') && l.includes('to=in_progress'),
        ),
        `expected a rate_capped re-pick transition log; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect(
    'aggregates workers.max backlog pressure into ONE log line per change, not per tick/ticket',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const running = yield* store.add(newTicket); // occupies the single slot
        yield* store.patch(running.id, { state: 'running', workHandle: makeWorkHandle('wh_r') });
        yield* store.add({ ...newTicket, title: 'Add foo' });
        yield* store.add({ ...newTicket, title: 'Add bar' });
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({ stuckRunning: true }),
        );
        const logs: string[] = [];
        // 3 ticks with the SAME two tickets waiting the whole time (max=1, one
        // running the whole time) — the old per-ticket-per-tick log would emit
        // 2 lines EVERY tick (6 total); the aggregate line should emit ONCE.
        yield* runSteps(3, env).pipe(Effect.provide(captureInto(logs)));

        const capLogs = logs.filter((l) => /workers\.max.*full/i.test(l));
        assert.strictEqual(
          capLogs.length,
          1,
          `expected exactly one aggregate cap-full log across 3 ticks; got: ${JSON.stringify(logs)}`,
        );
        assert.isTrue(capLogs[0]?.includes('2 ticket(s) waiting'));
      }),
  );

  it.effect('logs the retry/fail outcome exactly once from the shared retryOrFail path', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const oneRetry: Config = { ...testConfig, retries: 1 };
      const env = Layer.mergeAll(
        Layer.merge(Layer.succeed(TicketStore, store), Layer.succeed(AppConfig, oneRetry)),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve', pollFails: 'worker crashed' }),
      );
      const logs: string[] = [];
      // backlog → in_progress → dispatch → poll fails → retries=1 exhausted → failed.
      yield* runSteps(3, env).pipe(Effect.provide(captureInto(logs)));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'failed');
      assert.isTrue(
        logs.some((l) => l.includes(ticket.id) && l.includes('to=failed') && /fail/i.test(l)),
        `expected a retryOrFail outcome log; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('threads the dispatch handle as a runId annotation on the work dispatch log', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      yield* runSteps(2, env).pipe(Effect.provide(captureInto(logs)));

      const after = yield* store.byId(ticket.id);
      assert.isTrue(
        logs.some(
          (l) => /dispatched work agent/i.test(l) && l.includes(`runId=${after.workHandle}`),
        ),
        `expected a dispatched-work log carrying runId=<handle>; got: ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect('threads the dispatch handle as a runId annotation on the review dispatch log', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* store.patch(ticket.id, {
        state: 'review',
        branch: 'tp/x',
        prNumber: 1,
        prId: newPrId(),
      });
      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'approve' }),
      );
      const logs: string[] = [];
      yield* runSteps(1, env).pipe(Effect.provide(captureInto(logs)));

      const after = yield* store.byId(ticket.id);
      assert.isTrue(
        logs.some(
          (l) => /dispatched review agent/i.test(l) && l.includes(`runId=${after.workHandle}`),
        ),
        `expected a dispatched-review log carrying runId=<handle>; got: ${JSON.stringify(logs)}`,
      );
    }),
  );
});

describe('observeCiPending / clearCiPending (pure)', () => {
  // The CI-`pending` poll fires every 5s tick forever while a PR sits in CI —
  // logging on EVERY poll would be the exact per-tick spam the assignment asks
  // to quiet. These pure, DI-free helpers (mirroring `fifoSelector`) decide
  // whether a tick is the START of a pending streak (log once) or a
  // continuation (stay silent), given explicit state in/out — no module
  // mutation, so they're trivially unit-testable.
  const t1 = 'tckt_a1' as never;
  const t2 = 'tckt_b2' as never;

  it('logs (shouldLog=true, elapsedMs=0) the first time a ticket is observed pending', () => {
    const obs = observeCiPending(new Map(), t1, 1_000);
    assert.isTrue(obs.shouldLog);
    assert.strictEqual(obs.elapsedMs, 0);
    assert.strictEqual(obs.state.get(t1), 1_000);
  });

  it('stays silent on a later tick of the SAME pending streak, reporting elapsed time', () => {
    const first = observeCiPending(new Map(), t1, 1_000);
    const second = observeCiPending(first.state, t1, 6_000);
    assert.isFalse(second.shouldLog);
    assert.strictEqual(second.elapsedMs, 5_000);
  });

  it('tracks multiple tickets independently', () => {
    const afterT1 = observeCiPending(new Map(), t1, 1_000);
    const afterT2 = observeCiPending(afterT1.state, t2, 2_000);
    assert.isTrue(afterT2.shouldLog);
    assert.strictEqual(afterT2.elapsedMs, 0);
    assert.strictEqual(afterT2.state.get(t1), 1_000);
    assert.strictEqual(afterT2.state.get(t2), 2_000);
  });

  it('clearCiPending forgets the streak, so a LATER pending re-observation logs again', () => {
    const pending = observeCiPending(new Map(), t1, 1_000).state;
    const cleared = clearCiPending(pending, t1);
    assert.isFalse(cleared.has(t1));
    const reobserved = observeCiPending(cleared, t1, 9_000);
    assert.isTrue(reobserved.shouldLog);
    assert.strictEqual(reobserved.elapsedMs, 0);
  });

  it('clearCiPending is a no-op (same reference) when the ticket has no streak', () => {
    const empty = new Map();
    assert.strictEqual(clearCiPending(empty, t1), empty);
  });
});

describe('diffDeferred / formatCapFull (pure)', () => {
  // Powers the reconciler's aggregate "cap full" log line: ONE line when the
  // deferred SET changes, not an identical per-ticket INFO every 5s forever.
  const t1 = 'tckt_a1' as never;
  const t2 = 'tckt_b2' as never;

  it('reports changed=true the first time anything is deferred', () => {
    const diff = diffDeferred(new Set(), [t1]);
    assert.isTrue(diff.changed);
    assert.isTrue(diff.next.has(t1));
  });

  it('reports changed=false when the deferred set is identical to the last tick', () => {
    const first = diffDeferred(new Set(), [t1, t2]);
    const second = diffDeferred(first.next, [t1, t2]);
    assert.isFalse(second.changed);
  });

  it('reports changed=true when the deferred set grows', () => {
    const first = diffDeferred(new Set(), [t1]);
    const second = diffDeferred(first.next, [t1, t2]);
    assert.isTrue(second.changed);
  });

  it('reports changed=true when the deferred set shrinks back to empty (pressure cleared)', () => {
    const first = diffDeferred(new Set(), [t1]);
    const second = diffDeferred(first.next, []);
    assert.isTrue(second.changed);
    assert.strictEqual(second.next.size, 0);
  });

  it('formatCapFull summarizes the cap + waiting count in one line', () => {
    assert.strictEqual(
      formatCapFull([t1, t2], 1),
      'workers.max (1) full; 2 ticket(s) waiting in backlog',
    );
  });
});
