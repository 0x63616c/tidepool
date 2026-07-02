import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import type { Run, RunEvent, Ticket, TicketNotFound } from './domain.ts';
import { InMemoryTicketStore } from './fakes.ts';
import { newBoxId, newPrId, newRunId, newTicketId, type RunId, type TicketId } from './ids.ts';
import { TicketStore, type TicketStoreApi } from './services.ts';
import { costReport, renderTicketHeader, traceReport } from './trace.ts';

/**
 * `tp trace` / `tp cost` read the durable data the reconciler persists (runs +
 * run_events). These specs seed an in-memory store and assert on the rendered
 * report, exercising the same seam the CLI uses. Behaviour, not layout: ts
 * ordering, token aggregation, and definitive empty states.
 */

const seed = (
  f: (ctx: {
    readonly ticketId: TicketId;
    readonly workRun: RunId;
    readonly reviewRun: RunId;
    readonly store: TicketStoreApi;
  }) => Effect.Effect<void, TicketNotFound, TicketStore>,
) =>
  Effect.gen(function* () {
    const store = yield* TicketStore;
    const ticket = yield* store.add({ title: 'Add slugify', goal: 'g', target: 't/repo' });
    yield* f({ ticketId: ticket.id, workRun: newRunId(), reviewRun: newRunId(), store });
  }).pipe(Effect.provide(InMemoryTicketStore));

const run = (over: Partial<Run> & Pick<Run, 'id' | 'ticketId' | 'kind'>): Run => ({
  boxId: null,
  boxProvider: null,
  usage: { model: 'sonnet', tokensIn: 100, tokensOut: 50, wallTimeSec: 1 },
  ...over,
});

const event = (
  over: Partial<RunEvent> & Pick<RunEvent, 'ticketId' | 'source' | 'ts' | 'line'>,
): RunEvent => ({ runId: null, boxId: null, level: null, ...over });

const ticket = (over: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket => ({
  title: 't',
  goal: 'g',
  target: 't/repo',
  state: 'backlog',
  branch: null,
  prNumber: null,
  prId: null,
  mergeSha: null,
  attempts: 0,
  workedAttempt: null,
  reason: null,
  workHandle: null,
  dispatchedAt: null,
  ...over,
});

describe('renderTicketHeader', () => {
  it('prints every ticket field, including the full multi-line goal', () => {
    const prId = newPrId();
    const t = ticket({
      id: newTicketId(),
      title: 'Add slugify',
      goal: 'line one\nline two',
      target: 't/repo',
      state: 'failed',
      branch: 'tp/tckt_abc-add-slugify',
      prNumber: 42,
      prId,
      mergeSha: 'deadbeef',
      attempts: 2,
      workedAttempt: 1,
      reason: 'AgentFailed: boom',
      dispatchedAt: 1700000000000,
    });
    const out = renderTicketHeader(t);
    assert.include(out, t.id);
    assert.include(out, 'Add slugify');
    assert.include(out, 'line one');
    assert.include(out, 'line two');
    assert.include(out, 't/repo');
    assert.include(out, 'failed');
    assert.include(out, 'tp/tckt_abc-add-slugify');
    assert.include(out, '42');
    assert.include(out, prId);
    assert.include(out, 'deadbeef');
    assert.include(out, 'attempts: 2');
    assert.include(out, 'worked-attempt: 1');
    assert.include(out, 'AgentFailed: boom');
  });

  it('renders every nullable field as "-", never "null"/"undefined"', () => {
    const out = renderTicketHeader(ticket({ id: newTicketId() }));
    assert.notInclude(out, 'null');
    assert.notInclude(out, 'undefined');
    assert.include(out, '  branch: -');
    assert.include(out, 'worked-attempt: -');
    assert.include(out, '  reason: -');
    assert.include(out, '  dispatched: -');
  });
});

describe('traceReport', () => {
  it.effect('orders the timeline by ts regardless of insertion order', () =>
    seed(({ store, ticketId, workRun }) =>
      Effect.gen(function* () {
        yield* store.addRun(
          run({ id: workRun, ticketId, kind: 'work', boxId: newBoxId(), boxProvider: 'hetzner' }),
        );
        // Appended out of ts order on purpose.
        yield* store.appendEvents([
          event({ ticketId, runId: workRun, source: 'opencode', ts: 300, line: 'third' }),
          event({ ticketId, runId: workRun, source: 'cloud-init', ts: 100, line: 'first' }),
          event({ ticketId, runId: workRun, source: 'runner', ts: 200, line: 'second' }),
        ]);
        const out = yield* traceReport(ticketId);
        const order = ['first', 'second', 'third'].map((s) => out.indexOf(s));
        assert.isTrue((order[0] ?? -1) >= 0);
        assert.deepStrictEqual(
          order,
          [...order].sort((a, b) => a - b),
        );
      }),
    ),
  );

  it.effect('reports a total span derived from the first and last event ts', () =>
    seed(({ store, ticketId, workRun }) =>
      Effect.gen(function* () {
        yield* store.addRun(run({ id: workRun, ticketId, kind: 'work' }));
        yield* store.appendEvents([
          event({ ticketId, runId: workRun, source: 'cloud-init', ts: 1000, line: 'a' }),
          event({ ticketId, runId: workRun, source: 'runner', ts: 1120, line: 'b' }),
        ]);
        const out = yield* traceReport(ticketId);
        assert.include(out, 'span_ms: 120');
      }),
    ),
  );

  it.effect('labels phases from the originating run kind and control-plane errors', () =>
    seed(({ store, ticketId, workRun, reviewRun }) =>
      Effect.gen(function* () {
        yield* store.patch(ticketId, {
          state: 'failed',
          attempts: 2,
          reason: 'AgentFailed: boom',
        });
        yield* store.addRun(run({ id: workRun, ticketId, kind: 'work' }));
        yield* store.addRun(run({ id: reviewRun, ticketId, kind: 'review' }));
        yield* store.appendEvents([
          event({ ticketId, runId: workRun, source: 'opencode', ts: 1, line: 'work' }),
          event({ ticketId, runId: reviewRun, source: 'opencode', ts: 2, line: 'review' }),
          event({
            ticketId,
            source: 'control-plane',
            level: 'error',
            ts: 3,
            line: 'AgentFailed: boom',
          }),
        ]);
        const out = yield* traceReport(ticketId);
        assert.include(out, 'in_progress');
        assert.include(out, 'review');
        assert.include(out, 'failed');
        assert.include(out, 'state: failed');
        assert.include(out, 'reason: AgentFailed: boom');
      }),
    ),
  );

  it.effect('shows box id + provider + run id for the recorded runs', () =>
    seed(({ store, ticketId, workRun }) =>
      Effect.gen(function* () {
        const boxId = newBoxId();
        yield* store.addRun(
          run({ id: workRun, ticketId, kind: 'work', boxId, boxProvider: 'hetzner' }),
        );
        const out = yield* traceReport(ticketId);
        assert.include(out, boxId);
        assert.include(out, 'hetzner');
        assert.include(out, workRun);
      }),
    ),
  );

  it.effect('gives a definitive empty state when nothing has happened yet', () =>
    seed(({ ticketId }) =>
      Effect.gen(function* () {
        const out = yield* traceReport(ticketId);
        assert.include(out, 'no runs or events yet');
        assert.include(out, 'state: backlog');
      }),
    ),
  );

  it.effect('fails with TicketNotFound for an absent ticket', () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(traceReport(newTicketId()));
      assert.isTrue(result._tag === 'Left' && result.left._tag === 'TicketNotFound');
    }).pipe(Effect.provide(InMemoryTicketStore)),
  );
});

describe('costReport', () => {
  it.effect('aggregates tokens across runs for one ticket with a model breakdown', () =>
    seed(({ store, ticketId, workRun, reviewRun }) =>
      Effect.gen(function* () {
        yield* store.addRun(
          run({
            id: workRun,
            ticketId,
            kind: 'work',
            usage: { model: 'opus', tokensIn: 1000, tokensOut: 200, wallTimeSec: 4 },
          }),
        );
        yield* store.addRun(
          run({
            id: reviewRun,
            ticketId,
            kind: 'review',
            usage: { model: 'sonnet', tokensIn: 50, tokensOut: 25, wallTimeSec: 1 },
          }),
        );
        const out = yield* costReport(Option.some(ticketId));
        assert.include(out, '1050'); // summed tokens_in
        assert.include(out, '225'); // summed tokens_out
        assert.include(out, 'opus');
        assert.include(out, 'sonnet');
        assert.include(out, 'tokens-only'); // no invented prices
        assert.notInclude(out, '$');
      }),
    ),
  );

  it.effect('aggregates across all tickets when no ticket is given', () =>
    Effect.gen(function* () {
      const store = yield* TicketStore;
      const t1 = yield* store.add({ title: 'a', goal: 'g', target: 't/repo' });
      const t2 = yield* store.add({ title: 'b', goal: 'g', target: 't/repo' });
      yield* store.addRun(
        run({
          id: newRunId(),
          ticketId: t1.id,
          kind: 'work',
          usage: { model: 'opus', tokensIn: 10, tokensOut: 1, wallTimeSec: 1 },
        }),
      );
      yield* store.addRun(
        run({
          id: newRunId(),
          ticketId: t2.id,
          kind: 'work',
          usage: { model: 'opus', tokensIn: 5, tokensOut: 2, wallTimeSec: 1 },
        }),
      );
      const out = yield* costReport(Option.none());
      assert.include(out, t1.id);
      assert.include(out, t2.id);
      assert.include(out, '15'); // summed tokens_in across tickets
    }).pipe(Effect.provide(InMemoryTicketStore)),
  );

  it.effect('definitive empty states when no runs exist', () =>
    seed(({ ticketId }) =>
      Effect.gen(function* () {
        const scoped = yield* costReport(Option.some(ticketId));
        assert.include(scoped, 'no runs yet');
        const global = yield* costReport(Option.none());
        assert.include(global, '0 runs found');
      }),
    ),
  );

  it.effect('fails with TicketNotFound for an absent ticket', () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(costReport(Option.some(newTicketId())));
      assert.isTrue(result._tag === 'Left' && result.left._tag === 'TicketNotFound');
    }).pipe(Effect.provide(InMemoryTicketStore)),
  );
});
