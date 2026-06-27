import { Effect, Layer, Ref } from 'effect';
import {
  AgentFailed,
  type CIStatus,
  MergeConflict,
  RateCapped,
  type ReviewVerdict,
  type Run,
  type Ticket,
  TicketNotFound,
} from './domain.ts';
import { newBoxId, newPrId, newTicketId, type TicketId } from './ids.ts';
import { AgentRunner, BoxMaker, Forge, TicketStore, type TicketStoreApi } from './services.ts';

/**
 * Fakes-first dev loop: the whole reconciler runs locally, fast, free against
 * these. `Fake*` are just swapped `Layer`s for the locked interfaces — the real
 * adapters drop in with zero reconciler change.
 */

// ── In-memory TicketStore — the durable boundary in tests ────────────────────

/**
 * Build a store backed by `Ref`s and return its API. Persist the returned value
 * across a reconciler "reconstruction" to model durable state surviving a crash.
 */
export const makeInMemoryStore: Effect.Effect<TicketStoreApi> = Effect.gen(function* () {
  const tickets = yield* Ref.make<ReadonlyArray<Ticket>>([]);
  const runs = yield* Ref.make<ReadonlyArray<Run>>([]);

  const api: TicketStoreApi = {
    add: (input) =>
      Ref.modify(tickets, (cur) => {
        const ticket: Ticket = {
          id: newTicketId(),
          title: input.title,
          goal: input.goal,
          target: input.target,
          state: 'backlog',
          branch: null,
          prNumber: null,
          prId: null,
          mergeSha: null,
          attempts: 0,
          workedAttempt: null,
        };
        return [ticket, [...cur, ticket]];
      }),
    byId: (id) =>
      Effect.flatMap(Ref.get(tickets), (arr) => {
        const found = arr.find((t) => t.id === id);
        return found ? Effect.succeed(found) : Effect.fail(new TicketNotFound({ id }));
      }),
    list: () => Ref.get(tickets),
    patch: (id, patch) =>
      Effect.gen(function* () {
        const arr = yield* Ref.get(tickets);
        const idx = arr.findIndex((t) => t.id === id);
        const current = arr[idx];
        if (current === undefined) return yield* Effect.fail(new TicketNotFound({ id }));
        const updated: Ticket = { ...current, ...patch };
        yield* Ref.set(
          tickets,
          arr.map((t, i) => (i === idx ? updated : t)),
        );
        return updated;
      }),
    addRun: (run) => Ref.update(runs, (cur) => [...cur, run]),
    runsFor: (id: TicketId) =>
      Effect.map(Ref.get(runs), (cur) => cur.filter((r) => r.ticketId === id)),
  };

  return api;
});

/** Convenience layer with a fresh store per build. */
export const InMemoryTicketStore = Layer.effect(TicketStore, makeInMemoryStore);

// ── FakeForge — scripted CI + merge ──────────────────────────────────────────

export interface FakeForgeOptions {
  readonly ci?: CIStatus;
  readonly failMerge?: boolean;
}

export const fakeForge = (opts: FakeForgeOptions = {}): Layer.Layer<Forge> =>
  Layer.effect(
    Forge,
    Effect.gen(function* () {
      const counter = yield* Ref.make(1000);
      const ci = opts.ci ?? 'green';
      return {
        openPR: (input) =>
          Effect.map(
            Ref.updateAndGet(counter, (n) => n + 1),
            (number) => ({
              id: newPrId(),
              number,
              url: `https://github.com/${input.repo}/pull/${number}`,
            }),
          ),
        checks: () => Effect.succeed(ci),
        merge: (input) =>
          opts.failMerge
            ? Effect.fail(new MergeConflict({ prNumber: input.prNumber }))
            : Effect.succeed({ sha: `sha_${input.prNumber}` }),
      };
    }),
  );

// ── FakeBoxMaker — scoped lease, optional live-count probe ────────────────────

export interface FakeBoxMakerOptions {
  /** Increment on acquire, decrement on release — assert it returns to 0 (L3). */
  readonly live?: Ref.Ref<number>;
}

export const fakeBoxMaker = (opts: FakeBoxMakerOptions = {}): Layer.Layer<BoxMaker> =>
  Layer.succeed(BoxMaker, {
    lease: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (opts.live) yield* Ref.update(opts.live, (n) => n + 1);
          return { id: newBoxId(), ip: '10.0.0.2', role: 'worker' as const };
        }),
        () => (opts.live ? Ref.update(opts.live, (n) => n - 1) : Effect.void),
      ),
    reap: () => Effect.succeed({ deleted: [] }),
  });

// ── FakeAgentRunner — scripted work/review + usage ───────────────────────────

export interface FakeAgentRunnerOptions {
  readonly verdict?: ReviewVerdict;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly failWork?: 'rate' | 'agent';
}

export const fakeAgentRunner = (opts: FakeAgentRunnerOptions = {}): Layer.Layer<AgentRunner> =>
  Layer.succeed(AgentRunner, {
    work: (input) => {
      if (opts.failWork === 'rate') return Effect.fail(new RateCapped({}));
      if (opts.failWork === 'agent') return Effect.fail(new AgentFailed({ reason: 'fake' }));
      return Effect.succeed({
        title: `feat: ${input.ticket.title} (${input.ticket.id})`,
        body: input.ticket.goal,
        commitSha: 'deadbeef',
        usage: {
          model: input.model,
          tokensIn: opts.tokensIn ?? 100,
          tokensOut: opts.tokensOut ?? 50,
          wallTimeSec: 1,
        },
      });
    },
    review: (input) =>
      Effect.succeed({
        verdict: opts.verdict ?? 'approve',
        usage: { model: input.model, tokensIn: 20, tokensOut: 10, wallTimeSec: 0.5 },
      }),
  });
