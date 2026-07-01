import { Etag, FetchHttpClient, HttpApiBuilder, HttpPlatform } from '@effect/platform';
import { BunContext } from '@effect/platform-bun';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { AppConfig, type Config, defineConfig } from './config.ts';
import { InMemoryTicketStore } from './fakes.ts';
import { HttpQueueControl } from './http-queue-control.ts';
import { queueApi } from './queue-api.ts';
import { QueueApiLive } from './queue-api-server.ts';
import { LocalQueueControl, QueueControl } from './queue-control.ts';

/**
 * Contract test: the real HttpApi server (bound to a local in-memory
 * QueueControl) round-trips against the real HttpQueueControl client. The
 * transport is exercised via `toWebHandler` (no socket) by pointing the client's
 * fetch at the server handler. Proves add→list over HTTP plus both error mappings.
 */

const testConfig: Config = defineConfig({
  targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
  models: { work: 'm', review: 'm' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cx23', locations: ['nbg1'] },
  retries: 2,
});

const qcServer = LocalQueueControl.pipe(
  Layer.provide(Layer.mergeAll(InMemoryTicketStore, Layer.succeed(AppConfig, testConfig))),
);
const ApiLive = HttpApiBuilder.api(queueApi).pipe(
  Layer.provide(QueueApiLive),
  Layer.provide(qcServer),
);
// The default services HttpApiBuilder needs to render responses (platform + etag + fs).
const DefaultServices = Layer.mergeAll(HttpPlatform.layer, Etag.layer).pipe(
  Layer.provideMerge(BunContext.layer),
);
const { handler } = HttpApiBuilder.toWebHandler(Layer.merge(ApiLive, DefaultServices));

// Route the client's fetch at the in-process server handler (no socket).
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  handler(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;

const clientLayer = HttpQueueControl('http://tp.test').pipe(Layer.provide(FetchHttpClient.layer));
const withClient = <A, E>(eff: Effect.Effect<A, E, QueueControl>) =>
  eff.pipe(Effect.provide(clientLayer));

describe('queue HTTP contract', () => {
  it.effect('add → list round-trips over HTTP', () =>
    withClient(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        const created = yield* qc.add({ title: 'over the wire', goal: 'g', target: 't/repo' });
        expect(created.id).toMatch(/^tckt_/);
        const page = yield* qc.list({ limit: 50, cursor: null, target: null });
        expect(page.items.some((t) => t.id === created.id)).toBe(true);
      }),
    ),
  );

  it.effect('add to an unconfigured target maps to TargetNotConfigured', () =>
    withClient(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        const r = yield* Effect.either(qc.add({ title: 'no', goal: 'g', target: 'x/unknown' }));
        expect(r._tag).toBe('Left');
        if (r._tag === 'Left') expect(r.left._tag).toBe('TargetNotConfigured');
      }),
    ),
  );

  it('rejects a malformed events query param with a 4xx, not a 500', async () => {
    const res = await handler(new Request('http://tp.test/events?ticketId=not-a-valid-id'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it.effect('get of an unknown id maps to TicketNotFound', () =>
    withClient(
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        // valid id format, but no such ticket → server 404 → client TicketNotFound
        const r = yield* Effect.either(qc.get('tckt_zzzzzzzzzz' as never));
        expect(r._tag).toBe('Left');
        if (r._tag === 'Left') expect(r.left._tag).toBe('TicketNotFound');
      }),
    ),
  );
});
