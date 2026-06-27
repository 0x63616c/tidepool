import { Context, type Effect, type Scope } from 'effect';
import type {
  AgentFailed,
  BoxFailed,
  CIStatus,
  ForgeError,
  MergeConflict,
  NewTicket,
  RateCapped,
  ReviewVerdict,
  Run,
  Ticket,
  Usage,
} from './domain.ts';
import type { BoxId, PrId, TicketId } from './ids.ts';

/**
 * The four deep modules. Each is a single `Context.Tag` (narrow front); real
 * and `Fake*` implementations are just swapped `Layer`s. Hetzner / GitHub /
 * opencode types never leak across these seams.
 */

// ── TicketStore: the durable single source of truth (tickets + runs) ─────────

export type TicketPatch = Partial<
  Pick<Ticket, 'state' | 'branch' | 'prNumber' | 'prId' | 'mergeSha' | 'attempts' | 'workedAttempt'>
>;

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

// ── BoxMaker: ephemeral compute (direct Hetzner API; Local/Fake for A & B) ───

export type BoxRole = 'worker' | 'management';

export interface Box {
  readonly id: BoxId;
  readonly ip: string;
  readonly role: BoxRole;
}

export interface BoxSpec {
  readonly type: string;
  readonly locations: ReadonlyArray<string>;
  readonly ttlSec: number;
}

export interface BoxMakerApi {
  /**
   * Lease a worker box inside the caller's `Scope`. `acquireRelease` guarantees
   * the box is DELETEd on scope close — even on crash/defect (spend guardrail L3).
   */
  readonly lease: (spec: BoxSpec) => Effect.Effect<Box, BoxFailed, Scope.Scope>;
  /** Reaper: destroy orphaned / over-TTL worker boxes. Never touches management. */
  readonly reap: () => Effect.Effect<{ readonly deleted: ReadonlyArray<BoxId> }, BoxFailed>;
}

export class BoxMaker extends Context.Tag('BoxMaker')<BoxMaker, BoxMakerApi>() {}

// ── AgentRunner: drives opencode (real) / scripted results (fake) ────────────

/** Title/body are owned by the agent; the branch name is owned by the reconciler. */
export interface WorkResult {
  readonly title: string;
  readonly body: string;
  readonly commitSha: string | null;
  readonly usage: Usage;
}

export interface ReviewResult {
  readonly verdict: ReviewVerdict;
  readonly usage: Usage;
}

export interface AgentRunnerApi {
  /**
   * Run the work agent on `box`: clone `repo`, branch `branch` off `base`,
   * implement the ticket goal, commit, and push `branch` to the forge.
   */
  readonly work: (input: {
    readonly box: Box;
    readonly ticket: Ticket;
    readonly repo: string;
    readonly base: string;
    readonly branch: string;
    readonly model: string;
  }) => Effect.Effect<WorkResult, AgentFailed | RateCapped>;
  /** Run the review agent: grade the open PR's diff against the ticket goal. */
  readonly review: (input: {
    readonly ticket: Ticket;
    readonly repo: string;
    readonly prNumber: number;
    readonly model: string;
  }) => Effect.Effect<ReviewResult, AgentFailed | RateCapped>;
}

export class AgentRunner extends Context.Tag('AgentRunner')<AgentRunner, AgentRunnerApi>() {}
