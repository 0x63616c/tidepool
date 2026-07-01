import { Data, Schema } from 'effect';
import { BoxId, PrId, RunId, TicketId } from './ids.ts';

/**
 * Domain model — the single source of truth for ticket/run shape. Everything
 * persisted, displayed, or moved by the reconciler is one of these. Validated
 * with `effect/Schema` (no zod — tenet 10, one way of doing things).
 */

/**
 * Ticket lifecycle. Terminal: `done`, `failed`. `rate_capped` is requeueable.
 * `running` = an agent-worker (work or review) has been dispatched and is in
 * flight; the reconciler polls it each tick (async dispatch+poll model).
 */
export const TicketState = Schema.Literal(
  'backlog',
  'in_progress',
  'running',
  'review',
  'done',
  'failed',
  'rate_capped',
);
export type TicketState = typeof TicketState.Type;

export const isTerminal = (s: TicketState): boolean => s === 'done' || s === 'failed';

/** Token + model accounting for one agent invocation. Non-zero tokens prove a real run. */
export const Usage = Schema.Struct({
  model: Schema.String,
  tokensIn: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  tokensOut: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  wallTimeSec: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
});
export type Usage = typeof Usage.Type;

export const AgentKind = Schema.Literal('work', 'review');
export type AgentKind = typeof AgentKind.Type;

/**
 * Opaque reattach handle for an in-flight agent-worker, stored on the ticket
 * while it is `running`. Today a fake/local id; under k8s (PR-4) it is the Job
 * name. The seam treats it as an opaque string — no provider type leaks (tenet 4).
 */
export const WorkHandle = Schema.String.pipe(Schema.brand('WorkHandle'));
export type WorkHandle = typeof WorkHandle.Type;

/** Brand an opaque string as a `WorkHandle` (any non-empty string is valid). */
export const makeWorkHandle = Schema.decodeSync(WorkHandle);

export const BoxProvider = Schema.Literal('hetzner', 'local');
export type BoxProvider = typeof BoxProvider.Type;

/**
 * One agent invocation. `boxProvider === 'hetzner'` ⇒ ran on a REAL cloud worker
 * (Phase C proof). `'local'` means LocalBoxMaker (Phase B). Both work and review
 * lease a box, so the id/provider are nullable only for legacy/in-process runs.
 */
export const Run = Schema.Struct({
  id: RunId,
  ticketId: TicketId,
  kind: AgentKind,
  boxId: Schema.NullOr(BoxId),
  boxProvider: Schema.NullOr(BoxProvider),
  usage: Usage,
});
export type Run = typeof Run.Type;

/**
 * Ticket — a first-class store row (the backlog IS the db, never files).
 * `branch`/`prNumber` are the reattach handles; `workedAttempt` records which
 * attempt's work run already produced the open PR, so a reconstructed reconciler
 * resumes (advances to review) rather than restarting the agent.
 */
export const Ticket = Schema.Struct({
  id: TicketId,
  title: Schema.String,
  goal: Schema.String,
  target: Schema.String,
  state: TicketState,
  branch: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Int),
  prId: Schema.NullOr(PrId),
  mergeSha: Schema.NullOr(Schema.String),
  attempts: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  workedAttempt: Schema.NullOr(Schema.Int),
  /** Human-readable why-it-moved, set on failure/retry/rate-cap. Null while clean. */
  reason: Schema.NullOr(Schema.String),
  /**
   * Reattach handle for the in-flight agent-worker — set on `dispatch`, cleared
   * when the ticket leaves `running`. Non-null iff `state === 'running'`.
   */
  workHandle: Schema.NullOr(WorkHandle),
  /**
   * Epoch-ms the current work was dispatched; powers the deadline reaper
   * (`now - dispatchedAt > deadline → cancel`). Non-null iff `state === 'running'`.
   */
  dispatchedAt: Schema.NullOr(Schema.Number),
});
export type Ticket = typeof Ticket.Type;

/** Input to create a ticket. The store assigns id + initial state. */
export const NewTicket = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  target: Schema.String,
});
export type NewTicket = typeof NewTicket.Type;

/**
 * Where a `RunEvent` line came from. `control-plane` is the reconciler itself
 * (state transitions, failures); `cloud-init` / `runner` / `opencode` are the
 * three capture layers on the box (boot log, worker stderr, agent transcript).
 */
export const RunSource = Schema.Literal('control-plane', 'cloud-init', 'runner', 'opencode');
export type RunSource = typeof RunSource.Type;

/** Severity of a `RunEvent`. Null for raw captures whose level lives in the line. */
export const EventLevel = Schema.Literal('info', 'warn', 'error');
export type EventLevel = typeof EventLevel.Type;

/**
 * One observability event — an append-only log line tied to a ticket (and,
 * where known, a run/box). The opencode transcript, worker stderr, cloud-init
 * log, and control-plane failures all land here, so `tp logs`/`tp transcript`
 * read a single durable stream instead of files (tenet 1: state in sqlite).
 */
export const RunEvent = Schema.Struct({
  ticketId: TicketId,
  runId: Schema.NullOr(RunId),
  boxId: Schema.NullOr(BoxId),
  source: RunSource,
  ts: Schema.Number,
  level: Schema.NullOr(EventLevel),
  line: Schema.String,
});
export type RunEvent = typeof RunEvent.Type;

export const CIStatus = Schema.Literal('pending', 'green', 'red');
export type CIStatus = typeof CIStatus.Type;

export const ReviewVerdict = Schema.Literal('approve', 'request_changes');
export type ReviewVerdict = typeof ReviewVerdict.Type;

// ── Typed errors (flow in Effect channels, never thrown) ────────────────────

/** Box could not be provisioned (Hetzner capacity, boot failure, ssh timeout). */
export class BoxFailed extends Data.TaggedError('BoxFailed')<{
  readonly reason: string;
}> {}

/** Agent run could not complete (opencode crash, non-zero exit, push failure). */
export class AgentFailed extends Data.TaggedError('AgentFailed')<{
  readonly reason: string;
}> {}

/** Provider rate-cap hit. Surfaced + requeued, never crashes the loop. */
export class RateCapped extends Data.TaggedError('RateCapped')<{
  readonly retryAfterSec?: number;
}> {}

/** Forge operation failed (network, auth, GitHub 5xx). */
export class ForgeError extends Data.TaggedError('ForgeError')<{
  readonly op: string;
  readonly reason: string;
}> {}

/** Merge blocked by a conflict — the branch is stale vs base. */
export class MergeConflict extends Data.TaggedError('MergeConflict')<{
  readonly prNumber: number;
}> {}

/** A worker credential could not be resolved (missing PAT / auth file, sops read). */
export class CredentialError extends Data.TaggedError('CredentialError')<{
  readonly reason: string;
}> {}

/** Looked-up ticket not present in the store. */
export class TicketNotFound extends Data.TaggedError('TicketNotFound')<{
  readonly id: string;
}> {}
