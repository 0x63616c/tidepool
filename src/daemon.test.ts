import { assert, describe, it } from '@effect/vitest';
import { Duration, Effect, Fiber, Layer, TestClock } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { makeDaemon } from './daemon.ts';
import { fakeAgentWorker, fakeForge, makeInMemoryStore } from './fakes.ts';
import { TicketStore, type TicketStoreApi } from './services.ts';

/**
 * The daemon runs the reconcile loop against whatever stack it's given. Proven
 * against fakes under TestClock: a real backlog ticket is driven to `done`, then
 * the forever loop is interrupted. Mirrors the old `runProgram(watch)` proof,
 * now anchored on the daemon entrypoint that the pod actually launches.
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
    fakeAgentWorker({ verdict: 'approve' }),
  );

describe('makeDaemon', () => {
  it.effect('runs the reconcile loop and drives a backlog ticket to done', () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryStore;
      const seeded = yield* store.add({ title: 'real work', goal: 'do it', target: 't/repo' });

      const fiber = yield* makeDaemon().pipe(Effect.provide(env(store)), Effect.fork);
      // Let round 1 (t=0) settle to a fixpoint, then stop the forever loop.
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.interrupt(fiber);

      assert.strictEqual((yield* store.byId(seeded.id)).state, 'done');
    }),
  );
});
