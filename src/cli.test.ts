import { describe, expect, it } from '@effect/vitest';
import { Effect, Either, Layer, Option } from 'effect';
import { addAction, chooseBodySource, getAction, listAction } from './cli.ts';
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
        const created = yield* addAction({ title: 'do a thing', body: 'g', target: 't/repo' });
        expect(created).toContain('ticket: created tckt_');
        expect(created).toContain('  target: t/repo');
        const listed = yield* listAction({ target: null, limit: 50 });
        expect(listed).toContain('do a thing');
        expect(listed).toContain('t/repo');
      }),
    ),
  );

  it.effect('renders list columns as id, state, target, title', () =>
    run(
      Effect.gen(function* () {
        const qcApi = yield* QueueControl;
        const ticket = yield* qcApi.add({ title: 'scan me last', body: 'g', target: 't/repo' });
        const listed = yield* listAction({ target: null, limit: 50 });

        expect(listed.split('\n').slice(0, 2)).toEqual([
          'tickets[1]{id,state,target,title}:',
          `  ${ticket.id},${ticket.state},${ticket.target},${ticket.title}`,
        ]);
      }),
    ),
  );
});

describe('tp ticket get', () => {
  it.effect('renders the merged lifecycle + cost view for a ticket', () =>
    run(
      Effect.gen(function* () {
        const qcApi = yield* QueueControl;
        const t = yield* qcApi.add({ title: 'traced', body: 'g', target: 't/repo' });
        const view = yield* getAction(t.id);
        // trace section names the ticket; cost section reports (zero) usage.
        expect(view).toContain(t.id);
        expect(view.toLowerCase()).toContain('cost');
      }),
    ),
  );

  it.effect('still shows the full body + core fields for a ticket with zero runs', () =>
    run(
      Effect.gen(function* () {
        const qcApi = yield* QueueControl;
        const t = yield* qcApi.add({
          title: 'no runs yet',
          body: 'do the thing\nacross two lines',
          target: 't/repo',
        });
        const view = yield* getAction(t.id);
        expect(view).toContain('title: no runs yet');
        expect(view).toContain('do the thing');
        expect(view).toContain('across two lines');
        expect(view).toContain('target: t/repo');
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

describe('tp help hints', () => {
  it('names only invokable subcommands in copy-paste hints', async () => {
    const sources = await Promise.all(
      ['./cli.ts', './trace.ts'].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    );
    const hinted = sources.flatMap((source) =>
      [...source.matchAll(/Run \\?`(?<command>tp [^\\`]+)\\?`/g)].map(
        (match) => match.groups?.command ?? '',
      ),
    );
    const invokable = [
      'tp ticket add',
      'tp ticket list',
      'tp ticket get',
      'tp ticket logs',
      'tp ticket transcript',
      'tp context list',
      'tp context current',
      'tp context use',
      'tp context set',
      'tp context delete',
      'tp doctor',
    ];

    expect(hinted).not.toEqual([]);
    expect(
      hinted.filter((command) => !invokable.some((known) => command.startsWith(known))),
    ).toEqual([]);
  });
});

describe('chooseBodySource (AXI: --body xor --body-file, one required)', () => {
  const some = Option.some;
  const none = Option.none<string>();

  it('inline --body → inline source', () => {
    const r = chooseBodySource({ body: some('hello'), bodyFile: none });
    expect(Either.isRight(r) && r.right).toEqual({ kind: 'inline', value: 'hello' });
  });

  it('--body-file <path> → file source', () => {
    const r = chooseBodySource({ body: none, bodyFile: some('ticket.md') });
    expect(Either.isRight(r) && r.right).toEqual({ kind: 'file', path: 'ticket.md' });
  });

  it('--body-file - → stdin source', () => {
    const r = chooseBodySource({ body: none, bodyFile: some('-') });
    expect(Either.isRight(r) && r.right).toEqual({ kind: 'stdin' });
  });

  it('both → error (structured, not a prompt)', () => {
    const r = chooseBodySource({ body: some('x'), bodyFile: some('y') });
    expect(Either.isLeft(r)).toBe(true);
    expect(Either.isLeft(r) && r.left).toMatch(/not both/);
  });

  it('neither → error naming the required flags', () => {
    const r = chooseBodySource({ body: none, bodyFile: none });
    expect(Either.isLeft(r)).toBe(true);
    expect(Either.isLeft(r) && r.left).toMatch(/--body/);
  });
});
