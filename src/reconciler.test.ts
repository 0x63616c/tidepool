import { assert, describe, it } from '@effect/vitest';
import { Duration, Effect, Fiber, HashMap, Layer, Logger, Ref, TestClock } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { fakeAgentWorker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { newPrId } from './ids.ts';
import { reconcileForever, settle, step } from './reconciler.ts';
import { type AgentWorker, type Forge, TicketStore, type TicketStoreApi } from './services.ts';

/**
 * Loop-logic validation (DESIGN §Validation, level 1): the reconciler driven to
 * a terminal state against `Fake*` adapters. Free, fast, no infra. Proofs:
 * (a) backlog→…→done via dispatch+poll on green CI + approve, (b) red CI retries
 * to cap then failed, (c) an in_progress ticket with reattach handles is resumed,
 * (d) a review rejection re-reviews (never re-works) the PR, plus the async
 * `running` branches: worker-side `Failed` retries and the deadline reaper.
 */

const testConfig: Config = defineConfig({
  targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cpx11', locations: ['nbg1'] },
  retries: 2,
});

const newTicket = { title: 'Add slugify', goal: 'add slugify(s)', target: 't/repo' };

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
      const tokensIn = work.reduce((n, r) => n + r.usage.tokensIn, 0);
      const tokensOut = work.reduce((n, r) => n + r.usage.tokensOut, 0);
      assert.isTrue(tokensIn > 0);
      assert.isTrue(tokensOut > 0);
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
          fakeAgentWorker({ verdict: 'request_changes' }),
        );

        // step 1: review → dispatch review agent → running. step 2: poll the rejection.
        yield* runSteps(2, env);

        const final = yield* store.byId(ticket.id);
        // Re-enters REVIEW (not in_progress), keeps the existing PR, consumes an attempt.
        assert.strictEqual(final.state, 'review');
        assert.strictEqual(final.prNumber, 7);
        assert.strictEqual(final.attempts, 1);
        assert.isNull(final.workHandle);
        // Crucially, work never re-ran against the already-pushed branch.
        const work = (yield* store.runsFor(ticket.id)).filter((r) => r.kind === 'work');
        assert.strictEqual(work.length, 0);
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
      assert.strictEqual(events.filter((e) => /deadline/.test(e.line)).length, 1);
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
      assert.isNotNull(final.workHandle); // reattach handle persisted
      assert.isNotNull(final.dispatchedAt); // deadline clock persisted
      assert.isNotNull(final.branch); // branch fixed at dispatch
      // Nothing harvested yet — the run is recorded only when poll succeeds.
      assert.strictEqual((yield* store.runsFor(ticket.id)).length, 0);
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
      assert.strictEqual((yield* store.runsFor(ticket.id)).length, 0);
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
});

/**
 * Observability: every typed failure must leave a durable trace — a `reason` on
 * the ticket and exactly one control-plane/error event — and a successful run
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
      assert.strictEqual(events.length, 1);
      const [event] = events;
      assert.isDefined(event);
      assert.strictEqual(event.source, 'control-plane');
      assert.strictEqual(event.level, 'error');
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
      assert.strictEqual((yield* store.eventsFor({ ticketId: ticket.id })).length, 1);
    }),
  );

  it.effect('worker-side poll Failed → retried + exactly one control-plane/error event', () =>
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
      assert.strictEqual(events.length, 1);
      const [event] = events;
      assert.isDefined(event);
      assert.strictEqual(event.source, 'control-plane');
      assert.strictEqual(event.level, 'error');
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
      assert.strictEqual(events.length, 1);
      const [event] = events;
      assert.isDefined(event);
      assert.strictEqual(event.source, 'control-plane');
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
});
