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
import { newRunId, type RunId, type TicketId } from './ids.ts';
import {
  AgentWorker,
  Forge,
  TicketStore,
  type TicketStoreApi,
  type WorkResult,
} from './services.ts';

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

/**
 * Bump attempts; fail the ticket once it has burned through `retries`. The retry
 * target depends on how far the ticket got (FIX 3): a ticket that already opened a
 * PR re-enters `review` (re-check CI / re-grade the existing branch), because
 * re-running work would push to an existing branch and fail the non-fast-forward,
 * wasting attempts. Only a pre-PR failure (no open PR yet) re-runs work via
 * `in_progress`. Always clears the dispatch handle — a retry starts a fresh worker.
 */
const retryOrFail = (
  store: TicketStoreApi,
  ticket: Ticket,
  retries: number,
  reason: string,
): Effect.Effect<unknown, TicketNotFound> => {
  const attempts = ticket.attempts + 1;
  const retryState: Ticket['state'] = ticket.prNumber !== null ? 'review' : 'in_progress';
  const cleared = { workHandle: null, dispatchedAt: null } as const;
  return attempts >= retries
    ? store.patch(ticket.id, { attempts, state: 'failed', reason, ...cleared })
    : store.patch(ticket.id, { attempts, state: retryState, reason, ...cleared });
};

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

        // Dispatch the work agent-worker; store the reattach handle + dispatch time
        // and move to `running`. The work runs out of band; we poll it each tick.
        const branch = branchFor(ticket);
        const handle = yield* worker.dispatch({
          kind: 'work',
          ticket,
          repo: ticket.target,
          base,
          branch,
          model: models.work,
        });
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
              yield* store.patch(ticket.id, {
                state: 'rate_capped',
                reason: 'rate-capped',
                workHandle: null,
                dispatchedAt: null,
              });
              yield* store.appendEvents([failureEvent(ticket.id, 'rate-capped')]);
            } else {
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

            if (review.verdict === 'request_changes') {
              yield* retryOrFail(store, ticket, config.retries, 'review-rejected');
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

            // approve + green → auto-merge → done.
            const merged = yield* forge.merge({ repo: ticket.target, prNumber });
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

        const ci = yield* forge.checks({ repo: ticket.target, prNumber });
        if (ci === 'pending') return; // wait; next tick re-checks
        if (ci === 'red') {
          yield* retryOrFail(store, ticket, config.retries, 'ci-red');
          return;
        }

        // CI green → dispatch the review agent-worker (grades the diff vs goal) and
        // move to `running`; the verdict is harvested when its poll succeeds. The
        // control-plane never runs opencode — the worker does (FIX 1).
        const handle = yield* worker.dispatch({
          kind: 'review',
          ticket,
          repo: ticket.target,
          prNumber,
          model: models.review,
        });
        const now = yield* Clock.currentTimeMillis;
        yield* store.patch(ticket.id, {
          state: 'running',
          workHandle: handle,
          dispatchedAt: now,
        });
        return;
      }

      default:
        return; // done | failed | rate_capped — terminal / requeued elsewhere
    }
  }).pipe(
    // Typed failures never crash the loop — they map to ticket state (tenet: never crash).
    // `dispatch` can fail synchronously (RateCapped / AgentFailed) before the ticket
    // reaches `running`; the async worker-side failure is the `Failed` poll branch above.
    Effect.catchTags({
      RateCapped: (_: RateCapped) =>
        Effect.flatMap(TicketStore, (s) =>
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
      AgentFailed: (e: AgentFailed) =>
        Effect.flatMap(AppConfig, (c) =>
          Effect.flatMap(TicketStore, (s) =>
            Effect.zipRight(
              retryOrFail(s, ticket, c.retries, `agent: ${e.reason}`),
              s.appendEvents([failureEvent(ticket.id, `AgentFailed: ${e.reason}`)]),
            ),
          ),
        ),
      MergeConflict: (_: MergeConflict) =>
        Effect.flatMap(TicketStore, (s) =>
          s.patch(ticket.id, { state: 'in_progress', workHandle: null, dispatchedAt: null }),
        ),
      ForgeError: () => Effect.void, // transient — retried next tick, ticket unchanged
    }),
    // Ticket vanished mid-step (we just listed it) — re-listed next tick; never crash the loop.
    Effect.catchTag('TicketNotFound', () => Effect.void),
    Effect.asVoid,
  );

const NON_TERMINAL: ReadonlyArray<Ticket['state']> = [
  'backlog',
  'in_progress',
  'running',
  'review',
];

/** Advance every non-terminal ticket by one transition. Concurrency = workers.max. */
export const step: Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const store = yield* TicketStore;
    const tickets = yield* store.list();
    const active = tickets.filter((t) => NON_TERMINAL.includes(t.state));
    yield* Effect.forEach(active, stepTicket, { concurrency: config.workers.max, discard: true });
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
  intervalSec = 30,
): Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =>
  settle().pipe(
    Effect.catchAllCause((cause) => Effect.logError('settle round failed; continuing', cause)),
    Effect.repeat(Schedule.spaced(Duration.seconds(intervalSec))),
    Effect.asVoid,
  );
