import { Effect, Layer, Ref } from 'effect';
import {
  AgentFailed,
  type BreakerEvent,
  type CIStatus,
  type CircuitBreaker,
  CredentialError,
  MergeConflict,
  makeWorkHandle,
  type PrLifecycle,
  projectTicket,
  RateCapped,
  type ReviewVerdict,
  type Run,
  type RunEvent,
  type Ticket,
  TicketNotFound,
  type WorkHandle,
} from './domain.ts';
import { newPrId, newTicketId, type TicketId } from './ids.ts';
import {
  AgentWorker,
  CredentialBroker,
  type CredentialRequest,
  type DispatchInput,
  DispatchOutcome,
  Forge,
  TicketStore,
  type TicketStoreApi,
  WorkStatus,
} from './services.ts';

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
  const events = yield* Ref.make<ReadonlyArray<RunEvent>>([]);
  const breakers = yield* Ref.make<ReadonlyArray<CircuitBreaker>>([]);
  const breakerEvents = yield* Ref.make<ReadonlyArray<BreakerEvent>>([]);

  const api: TicketStoreApi = {
    add: (input) =>
      Ref.modify(tickets, (cur) => {
        const ticket: Ticket = {
          id: newTicketId(),
          title: input.title,
          body: input.body,
          target: input.target,
          state: 'backlog',
          phase: 'queued',
          conditions: [],
          branch: null,
          prNumber: null,
          prId: null,
          mergeSha: null,
          attempts: 0,
          contentionCount: 0,
          workedAttempt: null,
          reason: null,
          workHandle: null,
          dispatchedAt: null,
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
        const patched = { ...current, ...patch };
        const updated: Ticket = projectTicket(patched, patch);
        yield* Ref.set(
          tickets,
          arr.map((t, i) => (i === idx ? updated : t)),
        );
        return updated;
      }),
    addRun: (run) => Ref.update(runs, (cur) => [...cur, run]),
    finalizeOpenRun: (ticketId, patch) =>
      Ref.modify(runs, (cur) => {
        const idx = cur.findLastIndex((r) => r.ticketId === ticketId && r.status === 'running');
        if (idx === -1) return [null, cur];
        const updated = { ...cur[idx], ...patch } as Run;
        return [updated, cur.map((r, i) => (i === idx ? updated : r))];
      }),
    runsFor: (id: TicketId) =>
      Effect.map(Ref.get(runs), (cur) => cur.filter((r) => r.ticketId === id)),
    appendEvents: (evs) => Ref.update(events, (cur) => [...cur, ...evs]),
    eventsFor: (q) =>
      Effect.map(Ref.get(events), (cur) =>
        cur.filter(
          (e) =>
            (q.ticketId === undefined || e.ticketId === q.ticketId) &&
            (q.runId === undefined || e.runId === q.runId) &&
            (q.source === undefined || e.source === q.source),
        ),
      ),
    listBreakers: () => Ref.get(breakers),
    openBreaker: (input) =>
      Ref.modify(breakers, (cur) => {
        const existing = cur.find((b) => b.target === input.target);
        const next: CircuitBreaker = {
          target: input.target,
          isOpen: true,
          reason: input.reason,
          sha: input.sha,
          since: existing?.isOpen === true ? existing.since : input.now,
          updatedAt: input.now,
        };
        return [
          next,
          existing === undefined
            ? [...cur, next]
            : cur.map((b) => (b.target === input.target ? next : b)),
        ];
      }),
    closeBreaker: (target, now) =>
      Ref.modify(breakers, (cur) => {
        const existing = cur.find((b) => b.target === target);
        if (existing === undefined || !existing.isOpen) return [null, cur];
        const next: CircuitBreaker = { ...existing, isOpen: false, updatedAt: now };
        return [next, cur.map((b) => (b.target === target ? next : b))];
      }),
    appendBreakerEvents: (evs) => Ref.update(breakerEvents, (cur) => [...cur, ...evs]),
    breakerEvents: () => Ref.get(breakerEvents),
  };

  return api;
});

/** Convenience layer with a fresh store per build. */
export const InMemoryTicketStore = Layer.effect(TicketStore, makeInMemoryStore);

// ── FakeForge — scripted CI + merge ──────────────────────────────────────────

export interface FakeForgeOptions {
  readonly ci?: CIStatus;
  readonly mainCi?: CIStatus;
  readonly failMerge?: boolean;
  /** Scripted freshness result for the merge gate — default up-to-date. */
  readonly branchUpToDate?: boolean;
  /** Make `updateBranch` fail with a conflict (drives merge-gate rework). */
  readonly failUpdateBranch?: boolean;
  /** Scripted ground truth for `prState` — default `'open'` (today's behavior unaffected). */
  readonly prLifecycle?: PrLifecycle;
  /** Per-PR-number ground truth override; unlisted PRs fall back to `prLifecycle`. */
  readonly prState?: Readonly<Record<number, PrLifecycle>>;
  /** `mergeSha` reported alongside `prLifecycle: 'merged'`. */
  readonly mergeSha?: string;
  /** Spy hook: called with every `merge` attempt (assert idempotency — no duplicate merge). */
  readonly onMerge?: (input: { readonly repo: string; readonly prNumber: number }) => void;
  /** Spy hook: called with every merge-gate branch update. */
  readonly onUpdateBranch?: (input: { readonly repo: string; readonly prNumber: number }) => void;
  /** Spy hook: called when terminal cleanup closes a failed ticket's open PR. */
  readonly onClosePR?: (input: {
    readonly repo: string;
    readonly prNumber: number;
    readonly comment: string;
  }) => void;
}

export const fakeForge = (opts: FakeForgeOptions = {}): Layer.Layer<Forge> =>
  Layer.effect(
    Forge,
    Effect.gen(function* () {
      const counter = yield* Ref.make(1000);
      const ci = opts.ci ?? 'green';
      const prLifecycle = opts.prLifecycle ?? 'open';
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
        prState: (input) => {
          const state = opts.prState?.[input.prNumber] ?? prLifecycle;
          return Effect.succeed({
            state,
            mergeSha: state === 'merged' ? (opts.mergeSha ?? `sha_${input.prNumber}`) : null,
          });
        },
        checks: () => Effect.succeed(ci),
        checksForCommitOnMain: () => Effect.succeed(opts.mainCi ?? ci),
        isBranchUpToDate: () => Effect.succeed(opts.branchUpToDate ?? true),
        updateBranch: (input) => {
          opts.onUpdateBranch?.(input);
          return opts.failUpdateBranch
            ? Effect.fail(new MergeConflict({ prNumber: input.prNumber }))
            : Effect.void;
        },
        merge: (input) => {
          opts.onMerge?.(input);
          return opts.failMerge
            ? Effect.fail(new MergeConflict({ prNumber: input.prNumber }))
            : Effect.succeed({ sha: `sha_${input.prNumber}` });
        },
        closePR: (input) => {
          opts.onClosePR?.(input);
          return Effect.void;
        },
      };
    }),
  );

// ── FakeCredentialBroker — scripted creds, no sops/disk ──────────────────────

export interface FakeCredentialBrokerOptions {
  readonly opencodeAuth?: string;
  readonly githubToken?: string;
  /** Make `credsFor` fail (drives the dispatch-time cred-resolution failure path). */
  readonly fail?: string;
  /** Spy hook: called with each `credsFor` request (assert the dispatch keyed it right). */
  readonly onCall?: (job: CredentialRequest) => void;
}

/**
 * Scripted `CredentialBroker` for tests — returns canned creds with no sops or
 * disk read, so nothing decrypts a real secret. `onCall` records the request the
 * dispatch path made, proving creds are resolved via the broker (not inline).
 */
export const fakeCredentialBroker = (
  opts: FakeCredentialBrokerOptions = {},
): Layer.Layer<CredentialBroker> =>
  Layer.succeed(CredentialBroker, {
    credsFor: (job) => {
      opts.onCall?.(job);
      if (opts.fail !== undefined) return Effect.fail(new CredentialError({ reason: opts.fail }));
      return Effect.succeed({
        opencodeAuth: opts.opencodeAuth ?? 'fake-opencode-auth',
        githubToken: opts.githubToken ?? 'fake-gh-token',
      });
    },
  });

// ── FakeAgentWorker — scripted dispatch+poll, no real agent ──────────────────

export interface FakeAgentWorkerOptions {
  readonly verdict?: ReviewVerdict;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Make `dispatch` fail synchronously (mirrors today's in-process failure path). */
  readonly failWork?: 'rate' | 'agent';
  /** Capture payloads to attach to the WorkResult (drive the obs-event path). */
  readonly transcript?: ReadonlyArray<unknown>;
  readonly workerStderr?: string;
  readonly cloudInitLog?: string;
  /** Capture payload to attach to the ReviewResult. */
  readonly reviewTranscript?: ReadonlyArray<unknown>;
  /** The reviewer's free-text reason attached to the ReviewResult (defaults to a canned line). */
  readonly reviewReason?: string;
  /** Force `poll` to report the worker still in flight (drives the wait + reaper paths). */
  readonly stuckRunning?: boolean;
  /** Force `poll` to report a worker-side failure (drives the async `Failed` branch). */
  readonly pollFails?: string;
  /** Spy hook: called with every `dispatch` attempt (proves the admission gate's dispatch count). */
  readonly onDispatch?: (input: DispatchInput) => void;
}

/**
 * Scripted `AgentWorker` for tests. `dispatch` records the outcome it would
 * produce under a fresh handle (or fails synchronously, exactly like the old
 * in-process runner); `poll` replays it as `Succeeded` immediately — so the
 * suite stays green with no k8s. `stuckRunning` / `pollFails` exercise the new
 * async `Running` / `Failed` poll branches.
 */
export const fakeAgentWorker = (opts: FakeAgentWorkerOptions = {}): Layer.Layer<AgentWorker> =>
  Layer.effect(
    AgentWorker,
    Effect.gen(function* () {
      const outcomes = yield* Ref.make(new Map<WorkHandle, DispatchOutcome>());
      const counter = yield* Ref.make(0);
      return {
        dispatch: (input) => {
          opts.onDispatch?.(input);
          if (opts.failWork === 'rate') return Effect.fail(new RateCapped({}));
          if (opts.failWork === 'agent') return Effect.fail(new AgentFailed({ reason: 'fake' }));
          const outcome: DispatchOutcome =
            input.kind === 'work'
              ? DispatchOutcome.Work({
                  result: {
                    title: `feat: ${input.ticket.title} (${input.ticket.id})`,
                    body: input.ticket.body,
                    commitSha: 'deadbeef',
                    usage: {
                      model: input.model,
                      tokensIn: opts.tokensIn ?? 100,
                      tokensOut: opts.tokensOut ?? 50,
                      wallTimeSec: 1,
                    },
                    ...(opts.transcript === undefined ? {} : { transcript: opts.transcript }),
                    ...(opts.workerStderr === undefined ? {} : { workerStderr: opts.workerStderr }),
                    ...(opts.cloudInitLog === undefined ? {} : { cloudInitLog: opts.cloudInitLog }),
                  },
                })
              : DispatchOutcome.Review({
                  result: {
                    verdict: opts.verdict ?? 'approve',
                    reason: opts.reviewReason ?? 'fake review: looks good',
                    usage: { model: input.model, tokensIn: 20, tokensOut: 10, wallTimeSec: 0.5 },
                    ...(opts.reviewTranscript === undefined
                      ? {}
                      : { transcript: opts.reviewTranscript }),
                  },
                });
          return Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(counter, (c) => c + 1);
            const handle = makeWorkHandle(`wh_fake_${input.kind}_${n}`);
            yield* Ref.update(outcomes, (m) => new Map(m).set(handle, outcome));
            return handle;
          });
        },
        poll: (handle) => {
          if (opts.stuckRunning) return Effect.succeed(WorkStatus.Running());
          if (opts.pollFails !== undefined)
            return Effect.succeed(WorkStatus.Failed({ reason: opts.pollFails }));
          return Effect.map(Ref.get(outcomes), (m) => {
            const outcome = m.get(handle);
            return outcome === undefined
              ? WorkStatus.Failed({ reason: `unknown handle ${handle}` })
              : WorkStatus.Succeeded({ outcome });
          });
        },
        cancel: (handle) =>
          Ref.update(outcomes, (m) => new Map([...m].filter(([h]) => h !== handle))),
        reap: () => Effect.succeed({ cancelled: [] }),
      };
    }),
  );
