import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { InMemoryTicketStore } from './fakes.ts';
import { LocalQueueControl, QueueControl } from './queue-control.ts';

const testConfig: Config = defineConfig({
  targets: [
    { repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } },
    { repo: 'owner/one', base: 'main', models: { work: 'm', review: 'm' } },
    { repo: 'owner/two', base: 'main', models: { work: 'm', review: 'm' } },
  ],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cx23', locations: ['nbg1'] },
  retries: 2,
});

// Local adapter over an in-memory store + a controlled config, for every case.
const withQC = <A, E>(eff: Effect.Effect<A, E, QueueControl>) =>
  eff.pipe(
    Effect.provide(LocalQueueControl),
    Effect.provide(Layer.mergeAll(InMemoryTicketStore, Layer.succeed(AppConfig, testConfig))),
  );

describe('QueueControl.list', () => {
  it.effect('returns a {items,nextCursor} page, newest-first, honoring limit', () =>
    withQC(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        for (const n of ['a', 'b', 'c']) {
          yield* qc.add({ title: n, goal: `g-${n}`, target: 't/repo' });
        }
        const page = yield* qc.list({ limit: 2, cursor: null, target: null });
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).not.toBeNull();
        // newest-first: 'c' then 'b'
        expect(page.items[0]?.title).toBe('c');
        const rest = yield* qc.list({ limit: 2, cursor: page.nextCursor, target: null });
        expect(rest.items).toHaveLength(1);
        expect(rest.items[0]?.title).toBe('a');
        expect(rest.nextCursor).toBeNull();
      }),
    ),
  );

  it.effect('filters by target repo', () =>
    withQC(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        yield* qc.add({ title: 'x', goal: 'g', target: 'owner/one' });
        yield* qc.add({ title: 'y', goal: 'g', target: 'owner/two' });
        const page = yield* qc.list({ limit: 50, cursor: null, target: 'owner/two' });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.target).toBe('owner/two');
      }),
    ),
  );
});

describe('QueueControl.get / events', () => {
  it.effect('get returns the ticket; events returns a page envelope', () =>
    withQC(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        const t = yield* qc.add({ title: 'x', goal: 'gx', target: 't/repo' });
        const got = yield* qc.get(t.id);
        expect(got.id).toBe(t.id);
        const evs = yield* qc.events({
          ticketId: t.id,
          runId: null,
          source: null,
          limit: 10,
          cursor: null,
        });
        expect(Array.isArray(evs.items)).toBe(true);
        expect(evs).toHaveProperty('nextCursor');
      }),
    ),
  );
});

describe('QueueControl.add validation', () => {
  it.effect('rejects an unconfigured target with TargetNotConfigured', () =>
    withQC(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        const r = yield* Effect.either(
          qc.add({ title: 'oops', goal: 'g', target: '0x63616c/tidepol' }),
        );
        expect(r._tag).toBe('Left');
        if (r._tag === 'Left') expect(r.left._tag).toBe('TargetNotConfigured');
      }),
    ),
  );

  it.effect('accepts a configured target', () =>
    withQC(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        const t = yield* qc.add({ title: 'ok', goal: 'g', target: 't/repo' });
        expect(t.target).toBe('t/repo');
      }),
    ),
  );
});
