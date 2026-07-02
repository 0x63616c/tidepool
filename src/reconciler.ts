import { Clock, Duration, Effect, Schedule } from 'effect';
import { AppConfig, baseFor, modelsFor } from './config.ts';
import {
  type AgentFailed,
  deriveStateFromPhase,
  isTerminalPhase,
  type MergeConflict,
  type RateCapped,
  type Run,
  type RunEvent,
  type RunStatus,
  type TargetBreaker,
  type Ticket,
  type TicketNotFound,
  type Usage,
} from './domain.ts';
import { shortGitSha } from './git-sha.ts';
import { newRunId, type RunId, type TicketId } from './ids.ts';
import { deferredBacklog, fifoSelector } from './selection.ts';
import {
  AgentWorker,
  Forge,
  type PrState,
  TicketStore,
  type TicketStoreApi,
  type WorkResult,
} from './services.ts';
import { truncate } from './strings.ts';

/** Bound a reviewer's free-text reason before it lands in a log line. */
const REASON_LOG_MAX = 200;

/**
 * The reconciler — the ONLY mover (tenet 3). Every ticket transition happens
 * here, driven off durable store state. `phase` + `conditions` are the
 * authoritative machine (`queued → working → reviewing → merging → verifying →
 * done | failed`, rework loops `reviewing → working`); `state` is the derived
 * legacy projection the store maintains at its write choke point (see
 * domain.ts's `projectTicket`). Gate rule: a ticket with any condition set
 * never dispatches — that tick only clears the gate. There is no hidden
 * in-flight state: a reconstructed reconciler reads the store and resumes. One
 * `step` advances each non-terminal ticket by exactly one transition; `settle`
 * loops `step` to a fixpoint (all terminal or no progress).
 *
 * Execution is async dispatch+poll (not a synchronous block): `working` and a
 * green `reviewing` DISPATCH an agent-worker and store its `workHandle` +
 * `dispatchedAt` (the phase itself doesn't move). Each subsequent tick POLLs
 * that handle (mirroring the CI-`pending` poll below) — `Succeeded` harvests the
 * outcome and advances, `Failed` retries/fails, and a worker past its deadline
 * is reaped (`now - dispatchedAt > deadline → cancel`). Resumable across
 * control-plane restarts: the handle on the ticket is the reattach point.
 */

const SLUG_MAX = 32;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');

const branchFor = (ticket: Ticket): string => `tp/${ticket.id}-${slug(ticket.title)}`;

/** Rate-cap signatures — a `Failed` poll carrying one of these is a rate-cap, not a retry. */
const RATE_CAP_RE = /rate.?limit|429|quota|too many requests/i;

/** Record a run at dispatch time, minting its id once so events can attach to it. */
const recordDispatch = (
  store: TicketStoreApi,
  run: Omit<Run, 'id' | 'status' | 'reason' | 'finishedAt' | 'usage'>,
): Effect.Effect<RunId> =>
  Effect.gen(function* () {
    const id = newRunId();
    yield* store.addRun({
      id,
      ...run,
      status: 'running',
      reason: null,
      finishedAt: null,
      usage: null,
    });
    yield* store.appendEvents([runLifecycleEvent(run.ticketId, id, `run dispatched: ${run.kind}`)]);
    return id;
  });

const runLifecycleEvent = (
  ticketId: TicketId,
  runId: RunId,
  line: string,
  level: RunEvent['level'] = 'info',
): RunEvent => ({
  ticketId,
  runId,
  boxId: null,
  source: 'control-plane',
  ts: Date.now(),
  level,
  line,
});

const finalizeOpenRun = (
  store: TicketStoreApi,
  ticketId: TicketId,
  status: Exclude<RunStatus, 'running'>,
  reason: string | null,
  usage: Usage | null,
): Effect.Effect<Run | null> =>
  Effect.gen(function* () {
    const finishedAt = yield* Clock.currentTimeMillis;
    const run = yield* store.finalizeOpenRun(ticketId, { status, reason, finishedAt, usage });
    if (run === null) return null;
    yield* store.appendEvents([
      runLifecycleEvent(
        ticketId,
        run.id,
        reason === null ? `run finalized: ${status}` : `run finalized: ${status}: ${reason}`,
        status === 'succeeded' ? 'info' : 'error',
      ),
    ]);
    return run;
  });

const finalizeSuccessOrLog = (
  store: TicketStoreApi,
  ticket: Ticket,
  usage: Usage,
): Effect.Effect<Run | null> =>
  Effect.gen(function* () {
    const run = yield* finalizeOpenRun(store, ticket.id, 'succeeded', null, usage);
    if (run === null) {
      yield* Effect.logError(
        'successful worker produced usage but no open run row to finalize',
      ).pipe(Effect.annotateLogs({ ticket: ticket.id, usageModel: usage.model }));
    }
    return run;
  });

/**
 * Build the obs events captured from a successful work run (one per layer present).
 * `boxId` is null: the compute is an agent-worker addressed by `workHandle`, not a
 * leased box. The column is retained on `RunEvent`/`Run` for historical rows.
 */
const workCaptures = (
  ticketId: TicketId,
  runId: RunId,
  result: WorkResult,
): ReadonlyArray<RunEvent> => {
  const ts = Date.now();
  const events: RunEvent[] = [];
  if (result.transcript !== undefined)
    events.push({
      ticketId,
      runId,
      boxId: null,
      source: 'opencode',
      ts,
      level: null,
      line: JSON.stringify(result.transcript),
    });
  if (result.workerStderr !== undefined)
    events.push({
      ticketId,
      runId,
      boxId: null,
      source: 'runner',
      ts,
      level: null,
      line: result.workerStderr,
    });
  if (result.cloudInitLog !== undefined)
    events.push({
      ticketId,
      runId,
      boxId: null,
      source: 'cloud-init',
      ts,
      level: null,
      line: result.cloudInitLog,
    });
  return events;
};

/** One control-plane error event — the durable trace of why a ticket stalled. */
const failureEvent = (ticketId: TicketId, line: string): RunEvent => ({
  ticketId,
  runId: null,
  boxId: null,
  source: 'control-plane',
  ts: Date.now(),
  level: 'error',
  line,
});

/**
 * One control-plane info event per phase transition / condition set+clear —
 * the durable machine trace `tp ticket logs` renders (every move the machine
 * makes is evidence, tenet 8).
 */
const transitionEvent = (ticketId: TicketId, line: string): RunEvent => ({
  ticketId,
  runId: null,
  boxId: null,
  source: 'control-plane',
  ts: Date.now(),
  level: 'info',
  line,
});

const systemEvent = (line: string, level: RunEvent['level'] = 'info'): RunEvent => ({
  ticketId: null,
  runId: null,
  boxId: null,
  source: 'control-plane',
  ts: Date.now(),
  level,
  line,
});

const TERMINAL_CLEANUP_EVENT = 'terminal cleanup: failed ticket PR closed';

// ── Log-throttle helpers (pure, DI-free — mirrors fifoSelector/deferredBacklog) ──
//
// Both throttles below track EPHEMERAL, in-process state, explicitly NOT
// persisted: they only decide log cadence, never a ticket transition (tenet 3
// is unaffected), and reset harmlessly on reconciler restart (a fresh process
// just re-announces once more, not spam). Kept as pure functions over
// explicit state (not module mutation) so they're unit-testable in isolation;
// `step`/`stepTicket` own the one long-lived instance of each map/set.

/** Per-ticket "since when has CI been observed pending" — drives the once-per-streak log. */
export type CiPendingState = ReadonlyMap<TicketId, number>;

/**
 * Record one CI-`pending` observation. `shouldLog` is true only the FIRST tick
 * of a streak (so a PR sitting in CI for minutes logs once, not every 5s);
 * `elapsedMs` reports how long the streak has run so far.
 */
export const observeCiPending = (
  state: CiPendingState,
  ticketId: TicketId,
  now: number,
): { readonly shouldLog: boolean; readonly elapsedMs: number; readonly state: CiPendingState } => {
  const since = state.get(ticketId);
  if (since === undefined) {
    return { shouldLog: true, elapsedMs: 0, state: new Map(state).set(ticketId, now) };
  }
  return { shouldLog: false, elapsedMs: now - since, state };
};

/** Forget a ticket's pending streak (CI resolved) so the NEXT pending run logs fresh. */
export const clearCiPending = (state: CiPendingState, ticketId: TicketId): CiPendingState => {
  if (!state.has(ticketId)) return state;
  const next = new Map(state);
  next.delete(ticketId);
  return next;
};

/** The set of backlog tickets deferred by `workers.max` as of the last round. */
export type DeferredSet = ReadonlySet<TicketId>;

/**
 * Compare this round's deferred-backlog set to the last one `step` logged.
 * `changed` is true only when membership actually differs (grew, shrank, or
 * flipped to/from empty) — so a cap that stays full with the SAME waiters
 * logs once, not every tick.
 */
export const diffDeferred = (
  prev: DeferredSet,
  current: ReadonlyArray<TicketId>,
): { readonly changed: boolean; readonly next: DeferredSet } => {
  const next = new Set(current);
  const changed = next.size !== prev.size || current.some((id) => !prev.has(id));
  return { changed, next };
};

/** One-line summary of `workers.max` backlog pressure, for the aggregate log. */
export const formatCapFull = (deferred: ReadonlyArray<TicketId>, max: number): string =>
  `workers.max (${max}) full; ${deferred.length} ticket(s) waiting in backlog`;

/** Ephemeral state owned by the reconciler loop — see the doc comment above. */
let ciPendingState: CiPendingState = new Map();
let lastDeferred: DeferredSet = new Set();

/**
 * Bump attempts; fail the ticket once it has burned through `retries`. Routing
 * (by phase — `state` is only the derived projection):
 *  - `rework` retries (the diff is deficient — review requested changes, or CI is
 *    red) go back to `working` and re-run work so the feedback can actually be
 *    addressed; the worker force-pushes the ticket's branch, so the existing PR
 *    updates and re-review sees a NEW diff (re-grading the same diff would just
 *    reject identically and burn every attempt).
 *  - other (transient) retries — deadline, dispatch error — re-run the current
 *    stage: `reviewing` if a PR is already open, else `working`.
 * Always clears the dispatch handle — a retry starts a fresh worker.
 */
const retryOrFail = (
  store: TicketStoreApi,
  ticket: Ticket,
  retries: number,
  reason: string,
  opts?: { readonly rework?: boolean },
): Effect.Effect<unknown, TicketNotFound> =>
  Effect.gen(function* () {
    const attempts = ticket.attempts + 1;
    const retryPhase: Ticket['phase'] = opts?.rework
      ? 'working'
      : ticket.prNumber !== null
        ? 'reviewing'
        : 'working';
    const cleared = { workHandle: null, dispatchedAt: null } as const;
    const to: Ticket['phase'] = attempts >= retries ? 'failed' : retryPhase;
    // The ONE place every retry-or-fail decision is logged, regardless of the
    // 4 call sites (work Failed, CI red, dispatch AgentFailed, review-rejected)
    // that route through here — each caller ALSO logs its own proximate cause
    // (e.g. "worker failed; retrying or failing"); this line adds the outcome
    // (retry vs exhausted) that the caller can't know without duplicating
    // `retries`/`attempts` bookkeeping.
    yield* Effect.logInfo(to === 'failed' ? 'attempts exhausted; failing' : 'retrying').pipe(
      Effect.annotateLogs({ from: ticket.phase, to, attempts, retries, reason }),
    );
    const patched = yield* store.patch(ticket.id, { attempts, phase: to, reason, ...cleared });
    yield* store.appendEvents([transitionEvent(ticket.id, `phase: ${ticket.phase} -> ${to}`)]);
    return patched;
  });

const recordContention = (
  store: TicketStoreApi,
  ticket: Ticket,
  contentionRetries: number,
  reason: string,
  progress: Parameters<TicketStoreApi['patch']>[1],
): Effect.Effect<{ readonly exhausted: boolean; readonly ticket: Ticket }, TicketNotFound> =>
  Effect.gen(function* () {
    const contentionCount = ticket.contentionCount + 1;
    const humanReason = `merge contention exceeded budget (${contentionCount}/${contentionRetries}): ${reason}`;
    const exhausted = contentionCount > contentionRetries;
    const hasNeedsHuman = ticket.conditions.some((c) => c.type === 'needs_human');
    const conditions =
      exhausted && !hasNeedsHuman
        ? [...ticket.conditions, { type: 'needs_human' as const, reason: humanReason }]
        : ticket.conditions;
    const patched = yield* store.patch(
      ticket.id,
      exhausted
        ? {
            contentionCount,
            conditions,
            reason: humanReason,
            workHandle: null,
            dispatchedAt: null,
          }
        : { ...progress, contentionCount },
    );
    const events = [
      transitionEvent(
        ticket.id,
        `contention count: ${ticket.contentionCount} -> ${contentionCount} (${reason})`,
      ),
    ];
    if (exhausted && !hasNeedsHuman) {
      events.push(transitionEvent(ticket.id, `condition set: needs_human (${humanReason})`));
    }
    yield* store.appendEvents(events);
    return { exhausted, ticket: patched };
  });

/**
 * Tri-state settle from the forge's ground truth for a ticket's PR — the closed
 * loop that catches an external merge, a crash between `forge.merge` succeeding
 * and the `verifying` patch landing, and a merge call that succeeded remotely but
 * errored client-side (all three leave `PR merged ∧ ticket ≠ done` without this
 * check). Callers run this BEFORE any CI check, review dispatch, or merge
 * attempt, so drift never has a chance to start. Returns `true` iff the ticket
 * was settled from the forge's state (the caller must `return` immediately);
 * `false` means the PR is still open at the forge and
 * the caller should proceed exactly as before.
 */
const settleFromPrState = (
  store: TicketStoreApi,
  ticket: Ticket,
  prNumber: number,
  prState: PrState,
): Effect.Effect<boolean, TicketNotFound> =>
  Effect.gen(function* () {
    if (prState.state === 'merged') {
      yield* Effect.logInfo('PR already merged at the forge; verifying main').pipe(
        Effect.annotateLogs({ pr: prNumber, sha: prState.mergeSha }),
      );
      yield* store.patch(ticket.id, {
        phase: 'verifying',
        mergeSha: prState.mergeSha,
        workHandle: null,
        dispatchedAt: null,
      });
      yield* store.appendEvents([
        transitionEvent(
          ticket.id,
          `phase: ${ticket.phase} -> verifying (${prState.mergeSha ?? 'unknown-sha'})`,
        ),
      ]);
      return true;
    }
    if (prState.state === 'closed') {
      yield* Effect.logWarning('PR closed without merge; failing ticket (no retry)').pipe(
        Effect.annotateLogs({ pr: prNumber }),
      );
      yield* store.patch(ticket.id, {
        phase: 'failed',
        reason: 'pr-closed-unmerged',
        workHandle: null,
        dispatchedAt: null,
      });
      yield* store.appendEvents([transitionEvent(ticket.id, `phase: ${ticket.phase} -> failed`)]);
      return true;
    }
    return false;
  });

const stepTicket = (
  ticket: Ticket,
): Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const store = yield* TicketStore;
    const forge = yield* Forge;
    const worker = yield* AgentWorker;
    const models = modelsFor(config, ticket.target);
    const base = baseFor(config, ticket.target);
    const breakerOpen = (yield* store.listBreakers()).some(
      (b) => b.target === ticket.target && b.status === 'open',
    );

    const cleanupFailedOpenPr = Effect.gen(function* () {
      const prNumber = ticket.prNumber;
      if (prNumber === null) return;
      const events = yield* store.eventsFor({ ticketId: ticket.id, source: 'control-plane' });
      if (events.some((e) => e.line === TERMINAL_CLEANUP_EVENT)) return;

      const prState = yield* forge.prState({ repo: ticket.target, prNumber });
      if (prState.state !== 'open') {
        yield* store.appendEvents([transitionEvent(ticket.id, TERMINAL_CLEANUP_EVENT)]);
        return;
      }

      const reason = ticket.reason ?? 'ticket failed';
      yield* forge.closePR({
        repo: ticket.target,
        prNumber,
        comment: `${ticket.id} failed: ${reason}`,
      });
      yield* store.appendEvents([transitionEvent(ticket.id, TERMINAL_CLEANUP_EVENT)]);
    });

    /**
     * Poll the in-flight agent-worker a `working`/`reviewing` ticket dispatched
     * (async dispatch+poll). Shared by both phases: the outcome tag (Work vs
     * Review), not the phase, decides the harvest — a `Succeeded` Work advances
     * to `reviewing`, a `Succeeded` Review verdict routes to `merging` (approve)
     * or rework (request_changes), and `Failed` classifies rate-cap vs retry.
     */
    const pollInFlight = (handle: NonNullable<Ticket['workHandle']>) =>
      Effect.gen(function* () {
        // Deadline reaper: a worker past its deadline is cancelled + retried. This
        // is the spend guardrail under the async model (a native Job deadline is
        // the primary; this is the control-plane backstop).
        const now = yield* Clock.currentTimeMillis;
        if (
          ticket.dispatchedAt !== null &&
          now - ticket.dispatchedAt > config.workers.maxTtlSec * 1000
        ) {
          yield* Effect.logWarning('worker past deadline; cancelling + retrying');
          yield* worker.cancel(handle);
          yield* finalizeOpenRun(store, ticket.id, 'reaped', 'deadline-exceeded', null);
          yield* retryOrFail(store, ticket, config.retries, 'deadline-exceeded');
          yield* store.appendEvents([
            failureEvent(ticket.id, 'deadline-exceeded; worker cancelled'),
          ]);
          return;
        }

        const status = yield* worker.poll(handle);
        switch (status._tag) {
          case 'Running':
            return; // still in flight; next tick re-polls

          case 'Failed': {
            // Classify the worker-side failure like the old in-process mapping:
            // a rate-cap gates the ticket (never counts an attempt); anything
            // else retries.
            if (RATE_CAP_RE.test(status.reason)) {
              yield* Effect.logInfo('worker rate-capped; gated (no attempt spent)');
              yield* finalizeOpenRun(store, ticket.id, 'failed', 'rate-capped', null);
              yield* store.patch(ticket.id, {
                conditions: [{ type: 'rate_capped' }],
                reason: 'rate-capped',
                workHandle: null,
                dispatchedAt: null,
              });
              yield* store.appendEvents([
                failureEvent(ticket.id, 'rate-capped'),
                transitionEvent(ticket.id, 'condition set: rate_capped'),
              ]);
            } else {
              yield* Effect.logWarning('worker failed; retrying or failing').pipe(
                Effect.annotateLogs({ reason: status.reason }),
              );
              yield* finalizeOpenRun(store, ticket.id, 'failed', status.reason, null);
              yield* retryOrFail(store, ticket, config.retries, `agent: ${status.reason}`);
              yield* store.appendEvents([failureEvent(ticket.id, `AgentFailed: ${status.reason}`)]);
            }
            return;
          }

          case 'Succeeded': {
            const outcome = status.outcome;
            if (outcome._tag === 'Work') {
              const work = outcome.result;
              const finalizedRun = yield* finalizeSuccessOrLog(store, ticket, work.usage);
              if (finalizedRun !== null)
                yield* store.appendEvents(workCaptures(ticket.id, finalizedRun.id, work));
              if (ticket.contentionCount > 0) {
                yield* store.appendEvents([
                  transitionEvent(
                    ticket.id,
                    `contention count: ${ticket.contentionCount} -> 0 (successful work)`,
                  ),
                ]);
              }

              // Open the PR on first work; on a retry the fix is on the same branch.
              const branch = ticket.branch ?? branchFor(ticket);
              if (ticket.prNumber === null) {
                const pr = yield* forge.openPR({
                  repo: ticket.target,
                  branch,
                  base,
                  title: work.title,
                  body: work.body,
                });
                yield* Effect.logInfo('opened PR; moving to reviewing').pipe(
                  Effect.annotateLogs({ pr: pr.number }),
                );
                yield* store.patch(ticket.id, {
                  branch,
                  prNumber: pr.number,
                  prId: pr.id,
                  workedAttempt: ticket.attempts,
                  contentionCount: 0,
                  phase: 'reviewing',
                  workHandle: null,
                  dispatchedAt: null,
                });
              } else {
                yield* store.patch(ticket.id, {
                  branch,
                  workedAttempt: ticket.attempts,
                  contentionCount: 0,
                  phase: 'reviewing',
                  workHandle: null,
                  dispatchedAt: null,
                });
              }
              yield* store.appendEvents([
                transitionEvent(ticket.id, `phase: ${ticket.phase} -> reviewing`),
              ]);
              return;
            }

            // Review outcome: persist its transcript, then route the verdict.
            const review = outcome.result;
            const reviewRun = yield* finalizeSuccessOrLog(store, ticket, review.usage);
            if (review.transcript !== undefined)
              yield* store.appendEvents([
                {
                  ticketId: ticket.id,
                  runId: reviewRun?.id ?? null,
                  boxId: null,
                  source: 'opencode',
                  ts: Date.now(),
                  level: null,
                  line: JSON.stringify(review.transcript),
                },
              ]);

            // The verdict + WHY were previously invisible in `kubectl logs` — a
            // `request_changes` looked identical to an approve until you went
            // digging in the persisted transcript. The full untruncated reason
            // stays in that transcript (`RunEvent` above); this line is just the
            // log-signal slice of it.
            yield* Effect.logInfo('review verdict').pipe(
              Effect.annotateLogs({
                pr: ticket.prNumber,
                verdict: review.verdict,
                reason: truncate(review.reason, REASON_LOG_MAX),
              }),
            );

            if (review.verdict === 'request_changes') {
              yield* retryOrFail(store, ticket, config.retries, review.reason, {
                rework: true,
              });
              return;
            }

            if (ticket.prNumber === null) {
              // Inconsistent: a review finished with no PR. Re-drive work.
              yield* store.patch(ticket.id, {
                phase: 'working',
                workHandle: null,
                dispatchedAt: null,
              });
              yield* store.appendEvents([
                transitionEvent(ticket.id, `phase: ${ticket.phase} -> working`),
              ]);
              return;
            }

            // approve → hand off to the `merging` phase (merged on the NEXT
            // tick, idempotently, against forge ground truth) — never inline.
            yield* Effect.logInfo('review approved; moving to merging').pipe(
              Effect.annotateLogs({ pr: ticket.prNumber }),
            );
            yield* store.patch(ticket.id, {
              phase: 'merging',
              workHandle: null,
              dispatchedAt: null,
            });
            yield* store.appendEvents([
              transitionEvent(ticket.id, `phase: ${ticket.phase} -> merging`),
            ]);
            return;
          }
        }
      });

    // Generic gate rule (TOP, before any phase logic): a gated ticket never
    // dispatches. `rate_capped` is transient and clears immediately; hold
    // conditions remain until an operator or a later ticket changes them.
    if (ticket.conditions.length > 0) {
      if (ticket.conditions.some((c) => c.type === 'needs_human' || c.type === 'main_red')) return;
      const to = deriveStateFromPhase({ ...ticket, conditions: [] });
      yield* Effect.logInfo('clearing rate_capped condition; re-picking ticket').pipe(
        Effect.annotateLogs({ from: 'rate_capped', to }),
      );
      yield* store.patch(ticket.id, { conditions: [] });
      yield* store.appendEvents([transitionEvent(ticket.id, 'condition cleared: rate_capped')]);
      return;
    }

    if (breakerOpen && ticket.workHandle === null) return;

    switch (ticket.phase) {
      case 'queued': {
        // The ONE admission gate for `workers.max` (Decision 1: caps the whole
        // pipeline, not just live Jobs) — every other transition below moves a
        // ticket between two states that already hold its slot, so it never
        // needs re-asking. Read fresh from the store (not a snapshot from the
        // top of `step`) so a dispatch earlier in the SAME settle round is
        // visible to the next ticket's admission check — `step` runs tickets
        // sequentially (no `concurrency` option) specifically so this
        // read-then-decide is race-free within one pass.
        // Silent by design: `step` logs the whole round's backlog pressure as
        // ONE aggregate line (see `formatCapFull` + its call site below) rather
        // than an identical INFO here per deferred ticket, every 5s, forever.
        if (!fifoSelector.admit(yield* store.list(), config)) return;
        yield* Effect.logInfo('admitted from backlog').pipe(
          Effect.annotateLogs({ from: 'backlog', to: 'in_progress' }),
        );
        yield* store.patch(ticket.id, { phase: 'working' });
        yield* store.appendEvents([transitionEvent(ticket.id, 'phase: queued -> working')]);
        return;
      }

      case 'working': {
        // A handle means work is in flight — poll it (async dispatch+poll).
        if (ticket.workHandle !== null) {
          yield* pollInFlight(ticket.workHandle);
          return;
        }

        // Resume guard: this attempt's work already produced the open PR →
        // advance to reviewing rather than re-dispatching the agent (resumability).
        if (ticket.workedAttempt === ticket.attempts && ticket.prNumber !== null) {
          yield* store.patch(ticket.id, { phase: 'reviewing' });
          yield* store.appendEvents([transitionEvent(ticket.id, 'phase: working -> reviewing')]);
          return;
        }

        // No admission check here: this ticket was already admitted at the
        // `queued` exit and has held its slot ever since (Decision 1).
        // Dispatch the work agent-worker; store the reattach handle + dispatch
        // time (phase stays `working`). The work runs out of band; we poll it
        // each tick.
        const branch = ticket.branch ?? branchFor(ticket);
        const now = yield* Clock.currentTimeMillis;
        yield* recordDispatch(store, {
          ticketId: ticket.id,
          kind: 'work',
          dispatchedAt: now,
          boxId: null,
          boxProvider: null,
        });
        // Logged BEFORE the dispatch so a dispatch that throws (e.g. apiserver
        // TLS) still leaves a visible attempt line ahead of the failure event.
        yield* Effect.logInfo('dispatching work agent').pipe(Effect.annotateLogs({ branch }));
        const handle = yield* worker
          .dispatch({
            kind: 'work',
            ticket,
            repo: ticket.target,
            base,
            branch,
            model: models.work,
          })
          .pipe(
            Effect.tapError((e) =>
              finalizeOpenRun(
                store,
                ticket.id,
                'failed',
                e._tag === 'RateCapped' ? 'rate-capped' : `agent: ${e.reason}`,
                null,
              ),
            ),
          );
        // The handle IS the correlation id (tckt_4utv62nij6): it's already the
        // k8s Job's name (see k8s-agent-worker.ts), threaded onto the Job's
        // `TIDEPOOL_RUN_ID` env var and the worker's own log annotations — one
        // value greps a ticket's flow end-to-end across reconciler + pod logs.
        yield* Effect.logInfo('dispatched work agent').pipe(
          Effect.annotateLogs({ branch, runId: handle }),
        );
        yield* store.patch(ticket.id, {
          branch,
          workHandle: handle,
          dispatchedAt: now,
        });
        return;
      }

      case 'reviewing': {
        // A handle means the review agent is in flight — poll it.
        if (ticket.workHandle !== null) {
          yield* pollInFlight(ticket.workHandle);
          return;
        }

        const prNumber = ticket.prNumber;
        if (prNumber === null) {
          // Inconsistent: no PR to review. Re-run work.
          yield* store.patch(ticket.id, { phase: 'working' });
          yield* store.appendEvents([transitionEvent(ticket.id, 'phase: reviewing -> working')]);
          return;
        }

        // Ground truth FIRST — before any CI check or review dispatch — so an
        // external merge/close is observed and settled instead of the ticket
        // drifting on toward a duplicate re-dispatch (closes the loop).
        const prState = yield* forge.prState({ repo: ticket.target, prNumber });
        if (yield* settleFromPrState(store, ticket, prNumber, prState)) return;

        const ci = yield* forge.checks({ repo: ticket.target, prNumber });
        if (ci === 'pending') {
          // Log ONCE per pending streak (not every 5s tick) — see the
          // Log-throttle helpers doc comment above `retryOrFail`.
          const now = yield* Clock.currentTimeMillis;
          const observed = observeCiPending(ciPendingState, ticket.id, now);
          ciPendingState = observed.state;
          if (observed.shouldLog) {
            yield* Effect.logInfo('CI pending').pipe(
              Effect.annotateLogs({ pr: prNumber, elapsedMs: observed.elapsedMs }),
            );
          }
          return; // wait; next tick re-checks
        }
        // CI resolved (green or red) — forget the streak so a LATER pending
        // run (e.g. after a retry re-dispatches work) logs fresh, not silently.
        ciPendingState = clearCiPending(ciPendingState, ticket.id);
        if (ci === 'red') {
          yield* Effect.logWarning('PR CI red; retrying or failing').pipe(
            Effect.annotateLogs({ pr: prNumber }),
          );
          yield* retryOrFail(store, ticket, config.retries, 'ci-red');
          return;
        }

        // No admission check here either: this ticket has held its slot since
        // the `queued` exit admitted it (Decision 1).
        // CI green → dispatch the review agent-worker (grades the diff vs the
        // ticket body); phase stays `reviewing`, the verdict is harvested when
        // its poll succeeds. The control-plane never runs opencode — the worker
        // does (FIX 1).
        yield* Effect.logInfo('CI green; dispatching review agent').pipe(
          Effect.annotateLogs({ pr: prNumber }),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* recordDispatch(store, {
          ticketId: ticket.id,
          kind: 'review',
          dispatchedAt: now,
          boxId: null,
          boxProvider: null,
        });
        const handle = yield* worker
          .dispatch({
            kind: 'review',
            ticket,
            repo: ticket.target,
            prNumber,
            model: models.review,
          })
          .pipe(
            Effect.tapError((e) =>
              finalizeOpenRun(
                store,
                ticket.id,
                'failed',
                e._tag === 'RateCapped' ? 'rate-capped' : `agent: ${e.reason}`,
                null,
              ),
            ),
          );
        // Same correlation id as the work dispatch above (tckt_4utv62nij6).
        yield* Effect.logInfo('dispatched review agent').pipe(
          Effect.annotateLogs({ pr: prNumber, runId: handle }),
        );
        yield* store.patch(ticket.id, {
          workHandle: handle,
          dispatchedAt: now,
        });
        return;
      }

      case 'merging': {
        const prNumber = ticket.prNumber;
        if (prNumber === null) {
          // Inconsistent: nothing to merge. Re-drive work.
          yield* store.patch(ticket.id, {
            phase: 'working',
            workHandle: null,
            dispatchedAt: null,
          });
          yield* store.appendEvents([transitionEvent(ticket.id, 'phase: merging -> working')]);
          return;
        }

        // Ground truth before merging (idempotent merge): a prior `forge.merge`
        // may already have succeeded on GitHub — either the control plane
        // crashed before the `done` patch landed, or the merge call itself
        // succeeded remotely but errored client-side (network timeout,
        // ambiguous 405/409). Re-observing here settles from that instead of
        // attempting a duplicate merge.
        const prState = yield* forge.prState({ repo: ticket.target, prNumber });
        if (yield* settleFromPrState(store, ticket, prNumber, prState)) return;

        const branch = ticket.branch;
        if (branch === null) {
          // Inconsistent: PR exists but branch handle is gone. Re-drive work.
          yield* store.patch(ticket.id, {
            phase: 'working',
            workHandle: null,
            dispatchedAt: null,
          });
          yield* store.appendEvents([transitionEvent(ticket.id, 'phase: merging -> working')]);
          return;
        }

        const upToDate = yield* forge.isBranchUpToDate({ repo: ticket.target, base, branch });
        if (!upToDate) {
          yield* Effect.logInfo('merge gate: branch behind main; updating before merge').pipe(
            Effect.annotateLogs({ pr: prNumber, branch, base }),
          );
          yield* store.appendEvents([transitionEvent(ticket.id, 'merge gate: branch behind main')]);
          const updated = yield* forge.updateBranch({ repo: ticket.target, prNumber }).pipe(
            Effect.as(true),
            Effect.catchTag('MergeConflict', () =>
              Effect.gen(function* () {
                yield* Effect.logWarning('merge gate: update conflict; dispatching rework').pipe(
                  Effect.annotateLogs({ pr: prNumber, branch, base }),
                );
                const recorded = yield* recordContention(
                  store,
                  ticket,
                  config.contentionRetries,
                  'merge gate: update conflict',
                  {
                    phase: 'working',
                    workedAttempt: null,
                    workHandle: null,
                    dispatchedAt: null,
                  },
                );
                yield* store.appendEvents([
                  transitionEvent(ticket.id, 'merge gate: update conflict'),
                  ...(recorded.exhausted
                    ? []
                    : [transitionEvent(ticket.id, `phase: ${ticket.phase} -> working`)]),
                ]);
                return false;
              }),
            ),
          );
          if (!updated) return;
          yield* Effect.logInfo('merge gate: branch updated; returning to reviewing').pipe(
            Effect.annotateLogs({ pr: prNumber, branch, base }),
          );
          const recorded = yield* recordContention(
            store,
            ticket,
            config.contentionRetries,
            'merge gate: branch updated',
            {
              phase: 'reviewing',
              workHandle: null,
              dispatchedAt: null,
            },
          );
          yield* store.appendEvents([
            transitionEvent(ticket.id, 'merge gate: branch updated'),
            ...(recorded.exhausted
              ? []
              : [transitionEvent(ticket.id, `phase: ${ticket.phase} -> reviewing`)]),
          ]);
          return;
        }

        yield* Effect.logInfo('merge gate: branch up to date').pipe(
          Effect.annotateLogs({ pr: prNumber, branch, base }),
        );
        yield* store.appendEvents([transitionEvent(ticket.id, 'merge gate: branch up to date')]);

        // approved + green + fresh against current base → auto-merge → verify main.
        const merged = yield* forge.merge({ repo: ticket.target, prNumber });
        yield* Effect.logInfo('merged PR; verifying main').pipe(
          Effect.annotateLogs({ pr: prNumber, sha: merged.sha }),
        );
        yield* store.patch(ticket.id, {
          phase: 'verifying',
          mergeSha: merged.sha,
          workHandle: null,
          dispatchedAt: null,
        });
        yield* store.appendEvents([
          transitionEvent(ticket.id, `phase: merging -> verifying (${merged.sha})`),
        ]);
        return;
      }

      case 'verifying': {
        const sha = ticket.mergeSha;
        if (sha === null) return;
        const ci = yield* forge.checksForCommitOnMain({ repo: ticket.target, sha });
        if (ci === 'pending') return;
        if (ci === 'red') {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.logWarning('main checks red after merge; holding ticket').pipe(
            Effect.annotateLogs({ sha }),
          );
          yield* store.upsertBreaker({
            target: ticket.target,
            status: 'open',
            reason: sha,
            since: now,
          });
          yield* Effect.logError('target breaker opened: main red').pipe(
            Effect.annotateLogs({ target: ticket.target, sha }),
          );
          yield* store.patch(ticket.id, {
            conditions: [{ type: 'main_red', sha }],
            reason: 'main-red',
          });
          yield* store.appendEvents([
            systemEvent(`breaker opened for ${ticket.target}: main red (${sha})`, 'error'),
            failureEvent(ticket.id, `main checks red after merge: ${sha}`),
            transitionEvent(ticket.id, `condition set: main_red (${sha})`),
          ]);
          return;
        }
        yield* Effect.logInfo('main checks green; ticket done').pipe(Effect.annotateLogs({ sha }));
        yield* store.patch(ticket.id, { phase: 'done' });
        yield* store.appendEvents([
          transitionEvent(ticket.id, `phase: verifying -> done (${sha})`),
        ]);
        return;
      }

      case 'done':
        return; // absorbing — terminal phases never move again
      case 'failed':
        yield* cleanupFailedOpenPr;
        return; // absorbing — terminal phases never move again
    }
  }).pipe(
    // Typed failures never crash the loop — they map to ticket phase/conditions
    // (tenet: never crash). `dispatch` can fail synchronously (RateCapped /
    // AgentFailed) before a handle is stored; the async worker-side failure is
    // the `Failed` poll branch above.
    Effect.catchTags({
      RateCapped: (_: RateCapped) =>
        Effect.flatMap(TicketStore, (s) =>
          Effect.zipRight(
            Effect.logInfo('dispatch rate-capped; gated (no attempt spent)'),
            Effect.zipRight(
              s.patch(ticket.id, {
                conditions: [{ type: 'rate_capped' }],
                reason: 'rate-capped',
                workHandle: null,
                dispatchedAt: null,
              }),
              s.appendEvents([
                failureEvent(ticket.id, 'rate-capped'),
                transitionEvent(ticket.id, 'condition set: rate_capped'),
              ]),
            ),
          ),
        ),
      // The silent-failure sink pre-fix: a dispatch that throws (e.g. apiserver
      // TLS) only wrote a DB event, invisible in `kubectl logs`. Now mirrored to
      // stdout as a warning so the same class of outage is visible immediately.
      AgentFailed: (e: AgentFailed) =>
        Effect.flatMap(AppConfig, (c) =>
          Effect.flatMap(TicketStore, (s) =>
            Effect.zipRight(
              Effect.logWarning('dispatch failed; retrying or failing').pipe(
                Effect.annotateLogs({ reason: e.reason }),
              ),
              Effect.zipRight(
                retryOrFail(s, ticket, c.retries, `agent: ${e.reason}`),
                s.appendEvents([failureEvent(ticket.id, `AgentFailed: ${e.reason}`)]),
              ),
            ),
          ),
        ),
      // Merge contention is NOT a work-quality failure: bounce back to
      // `working` with `workedAttempt` cleared (forces a real rework dispatch
      // that rebases the branch) and NO attempt spent.
      MergeConflict: (_: MergeConflict) =>
        Effect.flatMap(AppConfig, (c) =>
          Effect.flatMap(TicketStore, (s) =>
            Effect.gen(function* () {
              yield* Effect.logWarning('merge conflict; bouncing ticket back to working');
              const recorded = yield* recordContention(
                s,
                ticket,
                c.contentionRetries,
                'merge conflict',
                {
                  phase: 'working',
                  workedAttempt: null,
                  workHandle: null,
                  dispatchedAt: null,
                },
              );
              yield* s.appendEvents([
                failureEvent(ticket.id, 'MergeConflict'),
                ...(recorded.exhausted
                  ? []
                  : [transitionEvent(ticket.id, `phase: ${ticket.phase} -> working`)]),
              ]);
            }),
          ),
        ),
      ForgeError: () => Effect.void, // transient — retried next tick, ticket unchanged
    }),
    // Ticket vanished mid-step (we just listed it) — re-listed next tick; never crash the loop.
    Effect.catchTag('TicketNotFound', () => Effect.void),
    // Every log emitted inside this step carries the ticket + target, so a line in
    // `kubectl logs` is self-identifying (which ticket, which repo) without grepping.
    // `state` (the legacy projection) rides along for log continuity.
    Effect.annotateLogs({
      ticket: ticket.id,
      target: ticket.target,
      phase: ticket.phase,
      state: ticket.state,
    }),
    Effect.asVoid,
  );

/**
 * Advance every non-terminal ticket by one transition. Stepped SEQUENTIALLY
 * (no `concurrency`) — that's load-bearing, not incidental: it's what makes
 * the `backlog`-exit admission gate's read-then-decide race-free within one
 * round, so a dispatch by ticket N is visible to ticket N+1's admission check
 * in the same pass. `workers.max` itself is enforced by `fifoSelector.admit`
 * at the single `backlog` exit (Decision 1: caps the whole pipeline — every
 * ticket past `backlog` and before `done`/`failed` occupies a slot, see
 * selection.ts), not by bounding how many tickets get stepped here.
 */
export const step: Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =
  Effect.gen(function* () {
    const store = yield* TicketStore;
    const forge = yield* Forge;
    const config = yield* AppConfig;
    const tickets = yield* store.list();

    const breakers = yield* store.listBreakers();
    yield* Effect.forEach(
      breakers.filter(
        (b): b is TargetBreaker & { readonly status: 'open'; readonly reason: string } =>
          b.status === 'open' && b.reason !== null,
      ),
      (breaker) =>
        Effect.gen(function* () {
          const ci = yield* forge.checksForCommitOnMain({
            repo: breaker.target,
            sha: breaker.reason,
          });
          if (ci !== 'green') return;
          const now = yield* Clock.currentTimeMillis;
          yield* store.upsertBreaker({
            target: breaker.target,
            status: 'closed',
            reason: breaker.reason,
            since: now,
          });
          yield* Effect.logInfo('target breaker closed: main green').pipe(
            Effect.annotateLogs({ target: breaker.target, sha: breaker.reason }),
          );
          for (const ticket of tickets.filter((t) => t.target === breaker.target)) {
            const conditions = ticket.conditions.filter(
              (c) => c.type !== 'main_red' || c.sha !== breaker.reason,
            );
            if (conditions.length !== ticket.conditions.length) {
              yield* store.patch(ticket.id, { conditions });
              yield* store.appendEvents([
                transitionEvent(ticket.id, `condition cleared: main_red (${breaker.reason})`),
              ]);
            }
          }
          yield* store.appendEvents([
            systemEvent(`breaker closed for ${breaker.target}: main green (${breaker.reason})`),
          ]);
        }).pipe(
          Effect.catchTag('ForgeError', () => Effect.void),
          Effect.catchTag('TicketNotFound', () => Effect.void),
        ),
      { discard: true },
    );

    // ONE aggregate line per CHANGE in who's waiting on `workers.max`, not an
    // identical per-ticket INFO every 5s tick forever (the noise this PR
    // quiets — see the "workers.max reached; deferring backlog exit" removal
    // in `stepTicket`'s `backlog` case). Computed from the round's snapshot,
    // BEFORE any ticket in this round dispatches — a slight staleness that
    // only affects this report, never actual admission (`fifoSelector.admit`,
    // re-read fresh per ticket inside `stepTicket`).
    const deferred = deferredBacklog(tickets, config);
    const diff = diffDeferred(lastDeferred, deferred);
    if (diff.changed) {
      lastDeferred = diff.next;
      yield* deferred.length > 0
        ? Effect.logInfo(formatCapFull(deferred, config.workers.max)).pipe(
            Effect.annotateLogs({ waiting: deferred.length, max: config.workers.max }),
          )
        : Effect.logInfo('workers.max backlog pressure cleared');
    }

    const active = tickets.filter((t) => !isTerminalPhase(t.phase) || t.phase === 'failed');
    yield* Effect.forEach(active, stepTicket, { discard: true });
  });

/**
 * Loop `step` until no ticket changes (fixpoint) or `maxRounds` is hit.
 * Resumable by construction: the only state read is the store.
 */
export const settle = (
  maxRounds = 50,
): Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =>
  Effect.gen(function* () {
    const store = yield* TicketStore;
    for (let round = 0; round < maxRounds; round++) {
      const before = yield* store.list();
      yield* step;
      const after = yield* store.list();
      if (JSON.stringify(before) === JSON.stringify(after)) return;
    }
  });

/**
 * The always-on control-plane loop: re-run `settle` every `intervalSec`. This is
 * what `tp run --watch` (and the systemd unit) runs; `settle` stays the only
 * mover (tenet 3) — this adds cadence, nothing else.
 *
 * Resilience is the whole point: a single round that *dies* (an unforeseen
 * defect, not a typed failure — those already map to ticket state inside `step`)
 * is logged via `catchAllCause` and swallowed PER ROUND, so the loop never
 * crashes. The next tick re-reads the durable store and resumes — resumable by
 * construction, exactly like a fresh process would be. The catch sits inside the
 * `repeat` so recovery yields a successful round and the schedule continues;
 * wrapping the repeat instead would log once and stop.
 */
export const reconcileForever = (
  intervalSec = 5,
): Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    // One boot line proving the loop started + which config it read — a healthy
    // idle reconciler is otherwise indistinguishable from a hung one in the logs.
    // The 🚀 makes this one line greppable/eyeballable in a sea of round noise.
    yield* Effect.logInfo('🚀 reconciler loop started').pipe(
      Effect.annotateLogs({
        intervalSec,
        retries: config.retries,
        targets: config.targets.map((t) => t.repo).join(','),
      }),
    );
    yield* settle().pipe(
      Effect.catchAllCause((cause) => Effect.logError('settle round failed; continuing', cause)),
      Effect.repeat(Schedule.spaced(Duration.seconds(intervalSec))),
      Effect.asVoid,
    );
    // Every log line this loop emits (boot banner + every settle-round dispatch/
    // error) carries the short git sha, so a misbehaving prod pod is traceable
    // back to the exact commit (see git-sha.ts). Wraps the WHOLE loop body, not
    // just the boot line, so it survives across every subsequent settle() round.
  }).pipe(Effect.annotateLogs({ sha: shortGitSha() }));
