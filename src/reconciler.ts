import { Clock, Duration, Effect, Schedule } from 'effect';
import { AppConfig, baseFor, modelsFor } from './config.ts';
import type {
  AgentFailed,
  MergeConflict,
  RateCapped,
  Run,
  RunEvent,
  Ticket,
  TicketNotFound,
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
 * The reconciler — the ONLY mover (tenet 3). Every ticket state transition
 * happens here, driven off durable store state. There is no hidden in-flight
 * state: a reconstructed reconciler reads the store and resumes. One `step`
 * advances each non-terminal ticket by exactly one transition; `settle` loops
 * `step` to a fixpoint (all terminal or no progress).
 *
 * Execution is async dispatch+poll (not a synchronous block): `in_progress` and
 * a green `review` DISPATCH an agent-worker, store its `workHandle` +
 * `dispatchedAt`, and move the ticket to `running`. Each subsequent tick POLLs
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

/** Record a run, minting its id once so callers can attach `RunEvent`s to it. */
const recordRun = (store: TicketStoreApi, run: Omit<Run, 'id'>): Effect.Effect<RunId> =>
  Effect.gen(function* () {
    const id = newRunId();
    yield* store.addRun({ id, ...run });
    return id;
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
 * Bump attempts; fail the ticket once it has burned through `retries`. Routing:
 *  - `rework` retries (the diff is deficient — review requested changes, or CI is
 *    red) go back to `in_progress` and re-run work so the feedback can actually be
 *    addressed; the worker force-pushes the ticket's branch, so the existing PR
 *    updates and re-review sees a NEW diff (re-grading the same diff would just
 *    reject identically and burn every attempt).
 *  - other (transient) retries — deadline, dispatch error — re-run the current
 *    stage: `review` if a PR is already open, else `in_progress`.
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
    const retryState: Ticket['state'] = opts?.rework
      ? 'in_progress'
      : ticket.prNumber !== null
        ? 'review'
        : 'in_progress';
    const cleared = { workHandle: null, dispatchedAt: null } as const;
    const to: Ticket['state'] = attempts >= retries ? 'failed' : retryState;
    // The ONE place every retry-or-fail decision is logged, regardless of the
    // 4 call sites (work Failed, CI red, dispatch AgentFailed, review-rejected)
    // that route through here — each caller ALSO logs its own proximate cause
    // (e.g. "worker failed; retrying or failing"); this line adds the outcome
    // (retry vs exhausted) that the caller can't know without duplicating
    // `retries`/`attempts` bookkeeping.
    yield* Effect.logInfo(to === 'failed' ? 'attempts exhausted; failing' : 'retrying').pipe(
      Effect.annotateLogs({ from: ticket.state, to, attempts, retries, reason }),
    );
    return yield* store.patch(ticket.id, { attempts, state: to, reason, ...cleared });
  });

/**
 * Tri-state settle from the forge's ground truth for a ticket's PR — the closed
 * loop that catches an external merge, a crash between `forge.merge` succeeding
 * and the `done` patch landing, and a merge call that succeeded remotely but
 * errored client-side (all three leave `PR merged ∧ ticket ≠ done` without this
 * check). Callers run this BEFORE any CI check, review dispatch, or merge
 * attempt, so drift never has a chance to start. Returns `true` iff the ticket
 * was settled to a terminal state from the forge's state (the caller must
 * `return` immediately); `false` means the PR is still open at the forge and
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
      yield* Effect.logInfo('PR already merged at the forge; settling ticket done').pipe(
        Effect.annotateLogs({ pr: prNumber, sha: prState.mergeSha }),
      );
      yield* store.patch(ticket.id, {
        state: 'done',
        mergeSha: prState.mergeSha,
        workHandle: null,
        dispatchedAt: null,
      });
      return true;
    }
    if (prState.state === 'closed') {
      yield* Effect.logWarning('PR closed without merge; failing ticket (no retry)').pipe(
        Effect.annotateLogs({ pr: prNumber }),
      );
      yield* store.patch(ticket.id, {
        state: 'failed',
        reason: 'pr-closed-unmerged',
        workHandle: null,
        dispatchedAt: null,
      });
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

    switch (ticket.state) {
      case 'backlog': {
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
        yield* store.patch(ticket.id, { state: 'in_progress' });
        return;
      }

      case 'in_progress': {
        // Resume guard: this attempt's work already produced the open PR →
        // advance to review rather than re-dispatching the agent (resumability).
        if (ticket.workedAttempt === ticket.attempts && ticket.prNumber !== null) {
          yield* store.patch(ticket.id, { state: 'review' });
          return;
        }

        // No admission check here: this ticket was already admitted at the
        // `backlog` exit and has held its slot ever since (Decision 1).
        // Dispatch the work agent-worker; store the reattach handle + dispatch time
        // and move to `running`. The work runs out of band; we poll it each tick.
        const branch = branchFor(ticket);
        // Logged BEFORE the dispatch so a dispatch that throws (e.g. apiserver
        // TLS) still leaves a visible attempt line ahead of the failure event.
        yield* Effect.logInfo('dispatching work agent').pipe(Effect.annotateLogs({ branch }));
        const handle = yield* worker.dispatch({
          kind: 'work',
          ticket,
          repo: ticket.target,
          base,
          branch,
          model: models.work,
        });
        // The handle IS the correlation id (tckt_4utv62nij6): it's already the
        // k8s Job's name (see k8s-agent-worker.ts), threaded onto the Job's
        // `TIDEPOOL_RUN_ID` env var and the worker's own log annotations — one
        // value greps a ticket's flow end-to-end across reconciler + pod logs.
        yield* Effect.logInfo('dispatched work agent').pipe(
          Effect.annotateLogs({ branch, runId: handle }),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* store.patch(ticket.id, {
          branch,
          state: 'running',
          workHandle: handle,
          dispatchedAt: now,
        });
        return;
      }

      case 'running': {
        const handle = ticket.workHandle;
        if (handle === null) {
          // Inconsistent: running without a handle. Re-drive from the prior state.
          yield* store.patch(ticket.id, {
            state: ticket.prNumber !== null ? 'review' : 'in_progress',
            workHandle: null,
            dispatchedAt: null,
          });
          return;
        }

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
            // a rate-cap requeues (never counts an attempt); anything else retries.
            if (RATE_CAP_RE.test(status.reason)) {
              yield* Effect.logInfo('worker rate-capped; requeued (no attempt spent)');
              yield* store.patch(ticket.id, {
                state: 'rate_capped',
                reason: 'rate-capped',
                workHandle: null,
                dispatchedAt: null,
              });
              yield* store.appendEvents([failureEvent(ticket.id, 'rate-capped')]);
            } else {
              yield* Effect.logWarning('worker failed; retrying or failing').pipe(
                Effect.annotateLogs({ reason: status.reason }),
              );
              yield* retryOrFail(store, ticket, config.retries, `agent: ${status.reason}`);
              yield* store.appendEvents([failureEvent(ticket.id, `AgentFailed: ${status.reason}`)]);
            }
            return;
          }

          case 'Succeeded': {
            const outcome = status.outcome;
            if (outcome._tag === 'Work') {
              const work = outcome.result;
              const runId = yield* recordRun(store, {
                ticketId: ticket.id,
                kind: 'work',
                boxId: null,
                boxProvider: null,
                usage: work.usage,
              });
              yield* store.appendEvents(workCaptures(ticket.id, runId, work));

              // Open the PR on first work; on a retry the fix is on the same branch.
              const branch = branchFor(ticket);
              if (ticket.prNumber === null) {
                const pr = yield* forge.openPR({
                  repo: ticket.target,
                  branch,
                  base,
                  title: work.title,
                  body: work.body,
                });
                yield* Effect.logInfo('opened PR; moving to review').pipe(
                  Effect.annotateLogs({ pr: pr.number }),
                );
                yield* store.patch(ticket.id, {
                  branch,
                  prNumber: pr.number,
                  prId: pr.id,
                  workedAttempt: ticket.attempts,
                  state: 'review',
                  workHandle: null,
                  dispatchedAt: null,
                });
              } else {
                yield* store.patch(ticket.id, {
                  branch,
                  workedAttempt: ticket.attempts,
                  state: 'review',
                  workHandle: null,
                  dispatchedAt: null,
                });
              }
              return;
            }

            // Review outcome: persist its transcript, then merge or retry.
            const review = outcome.result;
            const reviewRunId = yield* recordRun(store, {
              ticketId: ticket.id,
              kind: 'review',
              boxId: null,
              boxProvider: null,
              usage: review.usage,
            });
            if (review.transcript !== undefined)
              yield* store.appendEvents([
                {
                  ticketId: ticket.id,
                  runId: reviewRunId,
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

            const prNumber = ticket.prNumber;
            if (prNumber === null) {
              // Inconsistent: a review finished with no PR. Re-drive work.
              yield* store.patch(ticket.id, {
                state: 'in_progress',
                workHandle: null,
                dispatchedAt: null,
              });
              return;
            }

            // Ground truth before merging (idempotent merge): a prior
            // `forge.merge` may already have succeeded on GitHub — either the
            // control plane crashed before the `done` patch landed, or the
            // merge call itself succeeded remotely but errored client-side
            // (network timeout, ambiguous 405/409). Re-observing here settles
            // from that instead of attempting a duplicate merge.
            const preMergeState = yield* forge.prState({ repo: ticket.target, prNumber });
            if (yield* settleFromPrState(store, ticket, prNumber, preMergeState)) return;

            // approve + green → auto-merge → done.
            const merged = yield* forge.merge({ repo: ticket.target, prNumber });
            yield* Effect.logInfo('merged PR; ticket done').pipe(
              Effect.annotateLogs({ pr: prNumber, sha: merged.sha }),
            );
            yield* store.patch(ticket.id, {
              state: 'done',
              mergeSha: merged.sha,
              workHandle: null,
              dispatchedAt: null,
            });
            return;
          }
        }
        return;
      }

      case 'review': {
        const prNumber = ticket.prNumber;
        if (prNumber === null) {
          // Inconsistent: no PR to review. Re-run work.
          yield* store.patch(ticket.id, { state: 'in_progress' });
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
        // the `backlog` exit admitted it (Decision 1).
        // CI green → dispatch the review agent-worker (grades the diff vs the ticket body) and
        // move to `running`; the verdict is harvested when its poll succeeds. The
        // control-plane never runs opencode — the worker does (FIX 1).
        yield* Effect.logInfo('CI green; dispatching review agent').pipe(
          Effect.annotateLogs({ pr: prNumber }),
        );
        const handle = yield* worker.dispatch({
          kind: 'review',
          ticket,
          repo: ticket.target,
          prNumber,
          model: models.review,
        });
        // Same correlation id as the work dispatch above (tckt_4utv62nij6).
        yield* Effect.logInfo('dispatched review agent').pipe(
          Effect.annotateLogs({ pr: prNumber, runId: handle }),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* store.patch(ticket.id, {
          state: 'running',
          workHandle: handle,
          dispatchedAt: now,
        });
        return;
      }

      case 'rate_capped': {
        // (Decision 2b) A rate_capped ticket is mid-pipeline — it still holds its
        // workers.max slot (see selection.ts's PIPELINE_OCCUPIED) — and was only
        // ever asked to wait out a provider rate limit, not to give up its place.
        // Re-pick it immediately: no PR yet → back to work; PR already open →
        // back to review (CI/review dispatch picks up right where it left off).
        const to: Ticket['state'] = ticket.prNumber !== null ? 'review' : 'in_progress';
        yield* Effect.logInfo('re-picking rate-capped ticket').pipe(
          Effect.annotateLogs({ from: 'rate_capped', to }),
        );
        yield* store.patch(ticket.id, { state: to });
        return;
      }

      default:
        return; // done | failed — terminal
    }
  }).pipe(
    // Typed failures never crash the loop — they map to ticket state (tenet: never crash).
    // `dispatch` can fail synchronously (RateCapped / AgentFailed) before the ticket
    // reaches `running`; the async worker-side failure is the `Failed` poll branch above.
    Effect.catchTags({
      RateCapped: (_: RateCapped) =>
        Effect.flatMap(TicketStore, (s) =>
          Effect.zipRight(
            Effect.logInfo('dispatch rate-capped; requeued (no attempt spent)'),
            Effect.zipRight(
              s.patch(ticket.id, {
                state: 'rate_capped',
                reason: 'rate-capped',
                workHandle: null,
                dispatchedAt: null,
              }),
              s.appendEvents([failureEvent(ticket.id, 'rate-capped')]),
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
      MergeConflict: (_: MergeConflict) =>
        Effect.flatMap(TicketStore, (s) =>
          Effect.zipRight(
            Effect.logWarning('merge conflict; bouncing ticket back to in_progress'),
            s.patch(ticket.id, { state: 'in_progress', workHandle: null, dispatchedAt: null }),
          ),
        ),
      ForgeError: () => Effect.void, // transient — retried next tick, ticket unchanged
    }),
    // Ticket vanished mid-step (we just listed it) — re-listed next tick; never crash the loop.
    Effect.catchTag('TicketNotFound', () => Effect.void),
    // Every log emitted inside this step carries the ticket + target, so a line in
    // `kubectl logs` is self-identifying (which ticket, which repo) without grepping.
    Effect.annotateLogs({ ticket: ticket.id, target: ticket.target, state: ticket.state }),
    Effect.asVoid,
  );

const NON_TERMINAL: ReadonlyArray<Ticket['state']> = [
  'backlog',
  'in_progress',
  'running',
  'review',
  'rate_capped',
];

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
    const config = yield* AppConfig;
    const tickets = yield* store.list();

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

    const active = tickets.filter((t) => NON_TERMINAL.includes(t.state));
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
