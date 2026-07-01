import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { addAction, getAction, listAction } from './cli.ts';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { InMemoryTicketStore } from './fakes.ts';
import { LocalQueueControl, QueueControl } from './queue-control.ts';

/**
 * `tp ticket` command actions (unit-level): each verb is a thin Effect over the
 * `QueueControl` seam, so we exercise them against the in-process local adapter —
 * no CLI runtime, no live store. Proves the client-side wiring + rendering.
 */

const testConfig: Config = defineConfig({
  targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cx23', locations: ['nbg1'] },
  retries: 2,
});

const qc = LocalQueueControl.pipe(
  Layer.provide(Layer.mergeAll(InMemoryTicketStore, Layer.succeed(AppConfig, testConfig))),
);
const run = <A, E>(eff: Effect.Effect<A, E, QueueControl>) => eff.pipe(Effect.provide(qc));

describe('tp ticket add / list', () => {
  it.effect('add enqueues a ticket that list then shows', () =>
    run(
      Effect.gen(function* () {
        const created = yield* addAction({ title: 'do a thing', goal: 'g', target: 't/repo' });
        expect(created).toContain('ticket: created tckt_');
        expect(created).toContain('  target: t/repo');
        const listed = yield* listAction({ target: null, limit: 50 });
        expect(listed).toContain('do a thing');
        expect(listed).toContain('t/repo');
      }),
    ),
  );
});

describe('tp ticket get', () => {
  it.effect('renders the merged lifecycle + cost view for a ticket', () =>
    run(
      Effect.gen(function* () {
        const qcApi = yield* QueueControl;
        const t = yield* qcApi.add({ title: 'traced', goal: 'g', target: 't/repo' });
        const view = yield* getAction(t.id);
        // trace section names the ticket; cost section reports (zero) usage.
        expect(view).toContain(t.id);
        expect(view.toLowerCase()).toContain('cost');
      }),
    ),
  );

  it.effect('fails TicketNotFound for an unknown ticket id', () =>
    run(
      Effect.gen(function* () {
        const decoded = yield* Effect.either(getAction('tckt_nope' as never));
        expect(decoded._tag).toBe('Left');
      }),
    ),
  );
});
