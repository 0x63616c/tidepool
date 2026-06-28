import { assert, describe, it } from '@effect/vitest';
import { Duration, Effect, Fiber, Layer, TestClock } from 'effect';
import { runProgram } from './cli.ts';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { fakeAgentRunner, fakeBoxMaker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { TicketStore, type TicketStoreApi } from './services.ts';

/**
 * `tp run` wiring (unit-level): the `--watch` flag selects the always-on
 * `reconcileForever` loop, while the default one-shot path seeds the slugify demo
 * and settles once. Proven against fakes — no live adapters, no infra.
 */

const testConfig: Config = defineConfig({
  targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cx23', locations: ['nbg1'] },
  retries: 2,
});

const env = (store: TicketStoreApi) =>
  Layer.mergeAll(
    Layer.succeed(TicketStore, store),
    Layer.succeed(AppConfig, testConfig),
    fakeForge({ ci: 'green' }),
    fakeAgentRunner({ verdict: 'approve' }),
    fakeBoxMaker(),
  );

describe('runProgram', () => {
  it.effect('one-shot (watch=false): seeds the slugify demo and settles to done', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      yield* runProgram(false).pipe(Effect.provide(env(store)));

      const tickets = yield* store.list();
      const slug = tickets.find((t) => t.title === 'add slugify');
      assert.isDefined(slug);
      assert.strictEqual(slug?.state, 'done');
    }),
  );

  it.effect(
    'watch=true: runs the reconcile loop (drives the backlog) and skips the demo seed',
    () =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryStore;
        // A real backlog ticket the daemon should drive — proves the loop reconciles.
        const seeded = yield* store.add({ title: 'real work', goal: 'do it', target: 't/repo' });

        const fiber = yield* runProgram(true).pipe(Effect.provide(env(store)), Effect.fork);
        // Let round 1 (t=0) run settle to a fixpoint, then stop the forever loop.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.interrupt(fiber);

        const tickets = yield* store.list();
        // The loop reconciled the real ticket to done…
        assert.strictEqual((yield* store.byId(seeded.id)).state, 'done');
        // …and watch mode never seeds the slugify demo ticket.
        assert.isUndefined(tickets.find((t) => t.title === 'add slugify'));
      }),
  );
});
