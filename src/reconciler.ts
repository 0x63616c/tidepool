import { Effect } from 'effect';
import { AppConfig, baseFor, type Config, modelsFor } from './config.ts';
import type {
  AgentFailed,
  BoxFailed,
  MergeConflict,
  RateCapped,
  Run,
  Ticket,
  TicketNotFound,
} from './domain.ts';
import { newRunId } from './ids.ts';
import {
  AgentRunner,
  BoxMaker,
  type BoxSpec,
  Forge,
  TicketStore,
  type TicketStoreApi,
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

const recordRun = (store: TicketStoreApi, run: Omit<Run, 'id'>): Effect.Effect<void> =>
  store.addRun({ id: newRunId(), ...run });

/** Bump attempts; fail the ticket once it has burned through `retries`. */
const retryOrFail = (
  store: TicketStoreApi,
  ticket: Ticket,
  retries: number,
): Effect.Effect<unknown, TicketNotFound> => {
  const attempts = ticket.attempts + 1;
  return attempts >= retries
    ? store.patch(ticket.id, { attempts, state: 'failed' })
    : store.patch(ticket.id, { attempts, state: 'in_progress' });
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
        const work = yield* Effect.scoped(
          Effect.gen(function* () {
            const box = yield* boxes.lease(boxSpec(config));
            const result = yield* agents.work({
              box,
              ticket,
              repo: ticket.target,
              base,
              branch,
              model: models.work,
            });
            yield* recordRun(store, {
              ticketId: ticket.id,
              kind: 'work',
              boxId: box.id,
              boxProvider: box.provider,
              usage: result.usage,
            });
            return result;
          }),
        );

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
          yield* retryOrFail(store, ticket, config.retries);
          return;
        }

        // CI green → review agent grades the diff vs goal.
        const review = yield* agents.review({
          ticket,
          repo: ticket.target,
          prNumber,
          model: models.review,
        });
        yield* recordRun(store, {
          ticketId: ticket.id,
          kind: 'review',
          boxId: null,
          boxProvider: null,
          usage: review.usage,
        });

        if (review.verdict === 'request_changes') {
          yield* retryOrFail(store, ticket, config.retries);
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
        Effect.flatMap(TicketStore, (s) => s.patch(ticket.id, { state: 'rate_capped' })),
      AgentFailed: (_: AgentFailed) =>
        Effect.flatMap(AppConfig, (c) =>
          Effect.flatMap(TicketStore, (s) => retryOrFail(s, ticket, c.retries)),
        ),
      BoxFailed: (_: BoxFailed) =>
        Effect.flatMap(AppConfig, (c) =>
          Effect.flatMap(TicketStore, (s) => retryOrFail(s, ticket, c.retries)),
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
