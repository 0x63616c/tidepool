import { Context, Data, type Effect } from 'effect';
import type {
  AgentFailed,
  CIStatus,
  ForgeError,
  MergeConflict,
  NewTicket,
  RateCapped,
  ReviewVerdict,
  Run,
  RunEvent,
  RunSource,
  Ticket,
  Usage,
  WorkHandle,
} from './domain.ts';
import type { PrId, RunId, TicketId } from './ids.ts';

/**
 * The deep modules. Each is a single `Context.Tag` (narrow front); real and
 * `Fake*` implementations are just swapped `Layer`s. Hetzner / GitHub / opencode
 * / k8s types never leak across these seams.
 */

// ── TicketStore: the durable single source of truth (tickets + runs) ─────────

export type TicketPatch = Partial<
  Pick<
    Ticket,
    | 'state'
    | 'branch'
    | 'prNumber'
    | 'prId'
    | 'mergeSha'
    | 'attempts'
    | 'workedAttempt'
    | 'reason'
    | 'workHandle'
    | 'dispatchedAt'
  >
>;

/** Filter for `eventsFor`. All optional; omitted fields don't constrain the query. */
export interface EventQuery {
  readonly ticketId?: TicketId;
  readonly runId?: RunId;
  readonly source?: RunSource;
}

export interface TicketStoreApi {
  readonly add: (input: NewTicket) => Effect.Effect<Ticket>;
  readonly byId: (id: TicketId) => Effect.Effect<Ticket, import('./domain.ts').TicketNotFound>;
  readonly list: () => Effect.Effect<ReadonlyArray<Ticket>>;
  readonly patch: (
    id: TicketId,
    patch: TicketPatch,
  ) => Effect.Effect<Ticket, import('./domain.ts').TicketNotFound>;
  readonly addRun: (run: Run) => Effect.Effect<void>;
  readonly runsFor: (id: TicketId) => Effect.Effect<ReadonlyArray<Run>>;
  /** Append observability events (batch). Insertion order is preserved on read. */
  readonly appendEvents: (events: ReadonlyArray<RunEvent>) => Effect.Effect<void>;
  /** Read events oldest-first, narrowed by ticket / run / source. */
  readonly eventsFor: (q: EventQuery) => Effect.Effect<ReadonlyArray<RunEvent>>;
}

export class TicketStore extends Context.Tag('TicketStore')<TicketStore, TicketStoreApi>() {}

// ── Forge: the git host (GitHub now, GitLab-able later) ──────────────────────

export interface PullRequest {
  readonly id: PrId;
  readonly number: number;
  readonly url: string;
}

export interface OpenPRInput {
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface ForgeApi {
  readonly openPR: (input: OpenPRInput) => Effect.Effect<PullRequest, ForgeError>;
  readonly checks: (input: {
    readonly repo: string;
    readonly prNumber: number;
  }) => Effect.Effect<CIStatus, ForgeError>;
  readonly merge: (input: {
    readonly repo: string;
    readonly prNumber: number;
  }) => Effect.Effect<{ readonly sha: string }, ForgeError | MergeConflict>;
}

export class Forge extends Context.Tag('Forge')<Forge, ForgeApi>() {}

// ── AgentWorker: async dispatch+poll of agent-workers (work | review) ────────

/**
 * Title/body are owned by the agent; the branch name is owned by the reconciler.
 * The optional capture fields carry the observability payload back from the
 * worker (opaque to this seam — `transcript` stays `unknown[]` so no opencode
 * type leaks, tenet 4); the reconciler persists them as `RunEvent`s.
 */
export interface WorkResult {
  readonly title: string;
  readonly body: string;
  readonly commitSha: string | null;
  readonly usage: Usage;
  readonly transcript?: ReadonlyArray<unknown>;
  readonly workerStderr?: string;
  readonly cloudInitLog?: string;
}

export interface ReviewResult {
  readonly verdict: ReviewVerdict;
  readonly usage: Usage;
  readonly transcript?: ReadonlyArray<unknown>;
}

/**
 * What a finished agent-worker produced. A union (not just `WorkResult`) because
 * the review agent yields a verdict, not a work result — `poll`'s `Succeeded`
 * carries whichever matches the dispatched `kind`.
 */
export type DispatchOutcome = Data.TaggedEnum<{
  readonly Work: { readonly result: WorkResult };
  readonly Review: { readonly result: ReviewResult };
}>;
export const DispatchOutcome = Data.taggedEnum<DispatchOutcome>();

/**
 * The lifecycle of one dispatched agent-worker, observed via `poll`. `Running`
 * = still in flight (wait, re-poll next tick); `Succeeded` = finished cleanly,
 * harvest the outcome; `Failed` = the worker errored (the reconciler classifies
 * `reason` into retry vs rate-cap, mirroring the old in-process mapping).
 */
export type WorkStatus = Data.TaggedEnum<{
  readonly Running: object;
  readonly Succeeded: { readonly outcome: DispatchOutcome };
  readonly Failed: { readonly reason: string };
}>;
export const WorkStatus = Data.taggedEnum<WorkStatus>();

/**
 * What to dispatch. Tagged on `kind` so work (needs `base`/`branch`) and review
 * (needs `prNumber`) carry exactly their own fields — both run as agent-workers,
 * the only difference the control-plane sees is this discriminant.
 */
export type DispatchInput =
  | {
      readonly kind: 'work';
      readonly ticket: Ticket;
      readonly repo: string;
      readonly base: string;
      readonly branch: string;
      readonly model: string;
    }
  | {
      readonly kind: 'review';
      readonly ticket: Ticket;
      readonly repo: string;
      readonly prNumber: number;
      readonly model: string;
    };

export interface AgentWorkerApi {
  /**
   * Launch an agent-worker for `input` and return its opaque `WorkHandle` (stored
   * on the ticket as the reattach handle). Fire-and-forget: the work runs out of
   * band and is observed via `poll`. A failure to *launch* (or, for synchronous
   * adapters, the agent itself) surfaces here as `AgentFailed | RateCapped`.
   */
  readonly dispatch: (input: DispatchInput) => Effect.Effect<WorkHandle, AgentFailed | RateCapped>;
  /** Observe a dispatched worker: `Running` / `Succeeded{outcome}` / `Failed{reason}`. */
  readonly poll: (handle: WorkHandle) => Effect.Effect<WorkStatus, AgentFailed>;
  /** Stop a worker (deadline reaper / abandon). Idempotent — a gone worker is success. */
  readonly cancel: (handle: WorkHandle) => Effect.Effect<void>;
  /** Sweep finished / orphaned workers (label-selector + TTL under k8s). */
  readonly reap: () => Effect.Effect<{ readonly cancelled: ReadonlyArray<WorkHandle> }>;
}

export class AgentWorker extends Context.Tag('AgentWorker')<AgentWorker, AgentWorkerApi>() {}
