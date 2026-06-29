import { Duration, Effect, Schedule } from 'effect';
import { AppConfig, baseFor, type Config, modelsFor } from './config.ts';
import type {
  AgentFailed,
  BoxFailed,
  MergeConflict,
  RateCapped,
  Run,
  RunEvent,
  Ticket,
  TicketNotFound,
} from './domain.ts';
import { newRunId, type RunId, type TicketId } from './ids.ts';
import {
  AgentRunner,
  BoxMaker,
  type BoxSpec,
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

const boxSpec = (config: Config): BoxSpec => ({
  type: config.box.type,
  locations: config.box.locations,
  ttlSec: config.workers.maxTtlSec,
});

/** Record a run, minting its id once so callers can attach `RunEvent`s to it. */
const recordRun = (store: TicketStoreApi, run: Omit<Run, 'id'>): Effect.Effect<RunId> =>
  Effect.gen(function* () {
    const id = newRunId();
    yield* store.addRun({ id, ...run });
    return id;
  });

/** Build the obs events captured from a successful work run (one per layer present). */
const workCaptures = (
  ticketId: TicketId,
  runId: RunId,
  boxId: RunEvent['boxId'],
  result: WorkResult,
): ReadonlyArray<RunEvent> => {
  const ts = Date.now();
  const events: RunEvent[] = [];
  if (result.transcript !== undefined)
    events.push({
      ticketId,
      runId,
      boxId,
      source: 'opencode',
      ts,
      level: null,
      line: JSON.stringify(result.transcript),
    });
  if (result.workerStderr !== undefined)
    events.push({
      ticketId,
      runId,
      boxId,
      source: 'runner',
      ts,
      level: null,
      line: result.workerStderr,
    });
  if (result.cloudInitLog !== undefined)
    events.push({
      ticketId,
      runId,
      boxId,
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
 * `in_progress`.
 */
const retryOrFail = (
  store: TicketStoreApi,
  ticket: Ticket,
  retries: number,
  reason: string,
): Effect.Effect<unknown, TicketNotFound> => {
  const attempts = ticket.attempts + 1;
  const retryState: Ticket['state'] = ticket.prNumber !== null ? 'review' : 'in_progress';
  return attempts >= retries
    ? store.patch(ticket.id, { attempts, state: 'failed', reason })
    : store.patch(ticket.id, { attempts, state: retryState, reason });
};

const stepTicket = (
  ticket: Ticket,
): Effect.Effect<void, never, TicketStore | Forge | BoxMaker | AgentRunner | AppConfig> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const store = yield* TicketStore;
    const forge = yield* Forge;
    const boxes = yield* BoxMaker;
    const agents = yield* AgentRunner;
    const models = modelsFor(config, ticket.target);
    const base = baseFor(config, ticket.target);

    switch (ticket.state) {
      case 'backlog': {
        yield* store.patch(ticket.id, { state: 'in_progress' });
        return;
      }

      case 'in_progress': {
        // Resume guard: this attempt's work already produced the open PR →
        // advance to review rather than re-running the agent (resumability).
        if (ticket.workedAttempt === ticket.attempts && ticket.prNumber !== null) {
          yield* store.patch(ticket.id, { state: 'review' });
          return;
        }

        const branch = branchFor(ticket);
        const { boxId, runId, work } = yield* Effect.scoped(
          Effect.gen(function* () {
            const box = yield* boxes.lease({
              ...boxSpec(config),
              labels: { ticket: ticket.id },
            });
            const result = yield* agents.work({
              box,
              ticket,
              repo: ticket.target,
              base,
              branch,
              model: models.work,
            });
            const runId = yield* recordRun(store, {
              ticketId: ticket.id,
              kind: 'work',
              boxId: box.id,
              boxProvider: box.provider,
              usage: result.usage,
            });
            return { boxId: box.id, runId, work: result };
          }),
        );

        // Persist whatever the box captured (transcript / runner stderr / cloud-init).
        yield* store.appendEvents(workCaptures(ticket.id, runId, boxId, work));

        // Open the PR on first work; on a retry the fix is pushed to the same branch.
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
          });
        } else {
          yield* store.patch(ticket.id, {
            branch,
            workedAttempt: ticket.attempts,
            state: 'review',
          });
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

        // CI green → lease a worker box and grade the diff vs goal on it. Review
        // runs remotely exactly like work (FIX 1), so the control box never needs
        // opencode or its auth; the box is released on scope close.
        const {
          boxId: reviewBoxId,
          reviewRunId,
          review,
        } = yield* Effect.scoped(
          Effect.gen(function* () {
            const box = yield* boxes.lease({
              ...boxSpec(config),
              labels: { ticket: ticket.id },
            });
            const review = yield* agents.review({
              box,
              ticket,
              repo: ticket.target,
              prNumber,
              model: models.review,
            });
            const reviewRunId = yield* recordRun(store, {
              ticketId: ticket.id,
              kind: 'review',
              boxId: box.id,
              boxProvider: box.provider,
              usage: review.usage,
            });
            return { boxId: box.id, reviewRunId, review };
          }),
        );
        if (review.transcript !== undefined)
          yield* store.appendEvents([
            {
              ticketId: ticket.id,
              runId: reviewRunId,
              boxId: reviewBoxId,
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

        // approve + green → auto-merge → done.
        const merged = yield* forge.merge({ repo: ticket.target, prNumber });
        yield* store.patch(ticket.id, { state: 'done', mergeSha: merged.sha });
        return;
      }

      default:
        return; // done | failed | rate_capped — terminal / requeued elsewhere
    }
  }).pipe(
    // Typed failures never crash the loop — they map to ticket state (tenet: never crash).
    Effect.catchTags({
      RateCapped: (_: RateCapped) =>
        Effect.flatMap(TicketStore, (s) =>
          Effect.zipRight(
            s.patch(ticket.id, { state: 'rate_capped', reason: 'rate-capped' }),
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
      BoxFailed: (e: BoxFailed) =>
        Effect.flatMap(AppConfig, (c) =>
          Effect.flatMap(TicketStore, (s) =>
            Effect.zipRight(
              retryOrFail(s, ticket, c.retries, `box: ${e.reason}`),
              s.appendEvents([failureEvent(ticket.id, `BoxFailed: ${e.reason}`)]),
            ),
          ),
        ),
      MergeConflict: (_: MergeConflict) =>
        Effect.flatMap(TicketStore, (s) => s.patch(ticket.id, { state: 'in_progress' })),
      ForgeError: () => Effect.void, // transient — retried next tick, ticket unchanged
    }),
    // Ticket vanished mid-step (we just listed it) — re-listed next tick; never crash the loop.
    Effect.catchTag('TicketNotFound', () => Effect.void),
    Effect.asVoid,
  );

const NON_TERMINAL: ReadonlyArray<Ticket['state']> = ['backlog', 'in_progress', 'review'];

/** Advance every non-terminal ticket by one transition. Concurrency = workers.max. */
export const step: Effect.Effect<
  void,
  never,
  TicketStore | Forge | BoxMaker | AgentRunner | AppConfig
> = Effect.gen(function* () {
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
): Effect.Effect<void, never, TicketStore | Forge | BoxMaker | AgentRunner | AppConfig> =>
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
): Effect.Effect<void, never, TicketStore | Forge | BoxMaker | AgentRunner | AppConfig> =>
  settle().pipe(
    Effect.catchAllCause((cause) => Effect.logError('settle round failed; continuing', cause)),
    Effect.repeat(Schedule.spaced(Duration.seconds(intervalSec))),
    Effect.asVoid,
  );
