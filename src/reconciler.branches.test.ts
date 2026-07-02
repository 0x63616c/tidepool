import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { ForgeError } from './domain.ts';
import { fakeAgentWorker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { newPrId } from './ids.ts';
import { settle, step } from './reconciler.ts';
import { Forge, TicketStore, type TicketStoreApi } from './services.ts';

/**
 * The reconciler's failure branches, each driven through the public `step`/`settle`
 * entrypoints against the fakes and asserted on ticket STATE only (behavior, not
 * internals): rate-cap, merge conflict, review rejection to cap, transient forge error.
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

/** Patch a freshly-added ticket into an approved-PR `review` state (PR already open). */
const reviewReady = (store: TicketStoreApi, id: Parameters<TicketStoreApi['patch']>[0]) =>
  store.patch(id, {
    state: 'review',
    branch: 'tp/x',
    prNumber: 7,
    prId: newPrId(),
    workedAttempt: 0,
    attempts: 0,
  });

describe('reconciler failure branches', () => {
  it.effect('rate-cap during work → ticket ends rate_capped', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ failWork: 'rate' }),
      );

      // Exactly 2 steps (backlog → in_progress → dispatch-fails-rate → rate_capped),
      // not `settle()` — `rate_capped` is immediately re-picked (Decision 2b, see
      // below), so a settle() loop would keep cycling it and never reach a stable
      // fixpoint; this test only cares about the single rate-cap transition.
      yield* Effect.forEach([0, 1], () => step, { discard: true }).pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'rate_capped');
    }),
  );

  it.effect(
    '(Decision 2b) a rate_capped ticket with no PR is re-picked into in_progress on the next step',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        yield* store.patch(ticket.id, { state: 'rate_capped', reason: 'rate-capped' });

        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({ verdict: 'approve' }),
        );

        yield* step.pipe(Effect.provide(env));

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'in_progress');
      }),
  );

  it.effect(
    '(Decision 2b) a rate_capped ticket with an open PR is re-picked into review on the next step',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const ticket = yield* store.add(newTicket);
        yield* store.patch(ticket.id, {
          state: 'rate_capped',
          reason: 'rate-capped',
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

        yield* step.pipe(Effect.provide(env));

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'review');
      }),
  );

  it.effect(
    '(Decision 2b) a rate_capped ticket still holds its workers.max slot — a fresh backlog ticket is blocked',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        const rateCappedTicket = yield* store.add(newTicket);
        yield* store.patch(rateCappedTicket.id, { state: 'rate_capped', reason: 'rate-capped' });
        const backlogTicket = yield* store.add({ ...newTicket, title: 'Add foo' });

        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentWorker({ verdict: 'approve' }),
        );

        yield* step.pipe(Effect.provide(env));

        const finalBacklog = yield* store.byId(backlogTicket.id);
        assert.strictEqual(
          finalBacklog.state,
          'backlog',
          'blocked while the rate_capped ticket holds the slot',
        );
      }),
  );

  it.effect('merge conflict on an approved+green PR → maps back to in_progress', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      yield* reviewReady(store, ticket.id);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green', failMerge: true }),
        fakeAgentWorker({ verdict: 'approve' }),
      );

      // step 1: review → dispatch review → running. step 2: poll approve → merge → conflict.
      // One built env so the fake worker's dispatched outcome survives across ticks.
      yield* Effect.forEach([0, 1], () => step, { discard: true }).pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'in_progress');
      assert.isNull(final.mergeSha);
      assert.isNull(final.workHandle);
    }),
  );

  it.effect('review request_changes + green CI → retries to cap → failed', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentWorker({ verdict: 'request_changes' }),
      );

      yield* settle().pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'failed');
      assert.strictEqual(final.attempts, 2);
    }),
  );

  it.effect('transient ForgeError on checks → ticket unchanged that tick', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);
      const ready = yield* reviewReady(store, ticket.id);

      // A one-off Forge double whose checks call fails transiently. This is the
      // public Forge seam (no src interface changed); FakeForge can't script a
      // failing checks call, so the failure is injected through a test-local layer.
      const flakyForge = Layer.succeed(Forge, {
        openPR: () => Effect.die('unused'),
        prState: () => Effect.succeed({ state: 'open', mergeSha: null }),
        checks: () => Effect.fail(new ForgeError({ op: 'checks', reason: 'github 503' })),
        merge: () => Effect.die('unused'),
      });

      const env = Layer.mergeAll(
        baseLayers(store),
        flakyForge,
        fakeAgentWorker({ verdict: 'approve' }),
      );

      yield* step.pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.deepStrictEqual(final, ready);
    }),
  );
});
