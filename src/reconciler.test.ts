import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Ref } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { fakeAgentRunner, fakeBoxMaker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { newPrId } from './ids.ts';
import { settle, step } from './reconciler.ts';
import { TicketStore, type TicketStoreApi } from './services.ts';

/**
 * Loop-logic validation (DESIGN §Validation, level 1): the reconciler driven to
 * a terminal state against `Fake*` adapters. Free, fast, no infra. Three proofs:
 * (a) backlog→…→done on green CI + approve, (b) red CI retries to cap then failed,
 * (c) an in_progress ticket with reattach handles is resumed, not restarted.
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

describe('reconciler', () => {
  it.effect('(a) happy path: backlog → … → done, exactly one work + one review run', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const live = yield* Ref.make(0);
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'green' }),
        fakeAgentRunner({ verdict: 'approve' }),
        fakeBoxMaker({ live }),
      );

      yield* settle().pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'done');
      assert.isNotNull(final.mergeSha);

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

      // Scope teardown (L3): every leased box was released — live count back to 0.
      assert.strictEqual(yield* Ref.get(live), 0);
    }),
  );

  it.effect('(b) red CI: retry to cap → failed, attempts === 2, exactly two work runs', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const ticket = yield* store.add(newTicket);

      const env = Layer.mergeAll(
        baseLayers(store),
        fakeForge({ ci: 'red' }),
        fakeAgentRunner({ verdict: 'approve' }),
        fakeBoxMaker(),
      );

      yield* settle().pipe(Effect.provide(env));

      const final = yield* store.byId(ticket.id);
      assert.strictEqual(final.state, 'failed');
      assert.strictEqual(final.attempts, 2);

      const work = (yield* store.runsFor(ticket.id)).filter((r) => r.kind === 'work');
      assert.strictEqual(work.length, 2);
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

        // Reconstruct the reconciler env with a FRESH agent runner — if work runs, it ran.
        const env = Layer.mergeAll(
          baseLayers(store),
          fakeForge({ ci: 'green' }),
          fakeAgentRunner({ verdict: 'approve' }),
          fakeBoxMaker(),
        );

        yield* step.pipe(Effect.provide(env));

        const final = yield* store.byId(ticket.id);
        assert.strictEqual(final.state, 'review');

        const work = (yield* store.runsFor(ticket.id)).filter((r) => r.kind === 'work');
        assert.strictEqual(work.length, 0);
      }),
  );
});
