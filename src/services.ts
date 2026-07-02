import { Context, Data, type Effect } from 'effect';
import type {
  AgentFailed,
  CIStatus,
  CredentialError,
  ForgeError,
  MergeConflict,
  NewTicket,
  PrLifecycle,
  RateCapped,
  ReviewVerdict,
  Run,
  RunEvent,
  RunSource,
  TargetBreaker,
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
    | 'phase'
    | 'conditions'
    | 'branch'
    | 'prNumber'
    | 'prId'
    | 'mergeSha'
    | 'attempts'
    | 'contentionCount'
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
  readonly listBreakers: () => Effect.Effect<ReadonlyArray<TargetBreaker>>;
  readonly upsertBreaker: (breaker: TargetBreaker) => Effect.Effect<void>;
  readonly patch: (
    id: TicketId,
    patch: TicketPatch,
  ) => Effect.Effect<Ticket, import('./domain.ts').TicketNotFound>;
  readonly addRun: (run: Run) => Effect.Effect<void>;
  readonly finalizeOpenRun: (
    ticketId: TicketId,
    patch: Pick<Run, 'status' | 'reason' | 'finishedAt' | 'usage'>,
  ) => Effect.Effect<Run | null>;
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

export interface PrState {
  readonly state: PrLifecycle;
  readonly mergeSha: string | null;
}

export interface ForgeApi {
  readonly openPR: (input: OpenPRInput) => Effect.Effect<PullRequest, ForgeError>;
  /**
   * Ground truth for a PR — merged/closed/open, read fresh from the forge. The
   * reconciler calls this FIRST for any ticket that carries a PR, before any CI
   * check, review dispatch, or merge attempt — that ordering is what closes the
   * loop (external merges/closes/lost-replies are observed, not assumed away).
   */
  readonly prState: (input: {
    readonly repo: string;
    readonly prNumber: number;
  }) => Effect.Effect<PrState, ForgeError>;
  readonly checks: (input: {
    readonly repo: string;
    readonly prNumber: number;
  }) => Effect.Effect<CIStatus, ForgeError>;
  readonly checksForCommitOnMain: (input: {
    readonly repo: string;
    readonly sha: string;
  }) => Effect.Effect<CIStatus, ForgeError>;
  readonly isBranchUpToDate: (input: {
    readonly repo: string;
    readonly base: string;
    readonly branch: string;
  }) => Effect.Effect<boolean, ForgeError>;
  readonly updateBranch: (input: {
    readonly repo: string;
    readonly prNumber: number;
  }) => Effect.Effect<void, ForgeError | MergeConflict>;
  readonly merge: (input: {
    readonly repo: string;
    readonly prNumber: number;
  }) => Effect.Effect<{ readonly sha: string }, ForgeError | MergeConflict>;
  readonly closePR: (input: {
    readonly repo: string;
    readonly prNumber: number;
    readonly comment: string;
  }) => Effect.Effect<void, ForgeError>;
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
  /** The reviewer's free-text output `verdict` was parsed from — logged alongside it (tckt_4utv62nij6) so a `request_changes` is greppable WHY, not just WHAT. */
  readonly reason: string;
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

// ── CredentialBroker: the one place an agent-worker's creds come from ─────────

/**
 * The credentials one agent-worker needs to do its job. Opaque strings — the
 * broker hides where they come from (sops today, minted App tokens / rotated
 * opencode auth tomorrow), so this shape is the stable front the future swap
 * keeps (tenet 4). `opencodeAuth` is the opencode `auth.json` blob (LLM provider
 * auth); `githubToken` is the git clone/push + PR-diff token.
 */
export interface WorkerCredentials {
  readonly opencodeAuth: string;
  readonly githubToken: string;
}

/**
 * Which dispatch is asking. Narrow + non-leaky (ids/primitives only): `repo`
 * scopes a future GitHub App installation token, `kind`/`ticketId` scope + audit
 * the grant. Passthrough ignores it; the rotation swap keys creds on it.
 */
export interface CredentialRequest {
  readonly kind: 'work' | 'review';
  readonly repo: string;
  readonly ticketId: TicketId;
}

export interface CredentialBrokerApi {
  /** Resolve the creds for one dispatched job. The dispatch path's only cred source. */
  readonly credsFor: (job: CredentialRequest) => Effect.Effect<WorkerCredentials, CredentialError>;
}

export class CredentialBroker extends Context.Tag('CredentialBroker')<
  CredentialBroker,
  CredentialBrokerApi
>() {}
