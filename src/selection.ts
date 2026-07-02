import type { Config } from './config.ts';
import type { Ticket, TicketPhase } from './domain.ts';
import type { TicketId } from './ids.ts';

/**
 * Ticket selection — the ONE question the reconciler asks before letting a
 * ticket leave `backlog`: is there a free `workers.max` slot? Pulled out of
 * `reconciler.ts` into its own pure, DI-free module so a future policy
 * (`--blocked-by`, priority, newest-not-blocked) slots in by swapping this
 * file's export, not by touching `stepTicket` (tenet 4: narrow front, hidden
 * impl — the reconciler only ever calls `fifoSelector.admit`).
 */

/**
 * Phases that hold a `workers.max` slot: everything past `queued` and before
 * a terminal phase (`done` | `failed`). Conditions do NOT release the slot —
 * a `rate_capped` ticket is mid-pipeline (open branch, sometimes an open PR)
 * that has merely been asked to wait out a provider rate limit; its gate
 * clears on the very next `step` (see reconciler.ts's gate rule), so it is
 * never actually idle while holding its slot. Letting it release the slot
 * would let a SECOND ticket start mid-pipeline at `max=1`, breaking the
 * merge-safety guarantee `workers.max` exists for (DESIGN.md §Compute:
 * "N=1 serializes tickets ... merge conflicts essentially can't occur").
 */
export const PIPELINE_OCCUPIED: ReadonlyArray<TicketPhase> = [
  'working',
  'reviewing',
  'merging',
  'verifying',
];

/**
 * A ticket-selection policy. `admit` is asked ONLY at the `backlog` exit —
 * every other transition (retry, rework, rate-cap requeue, review) moves a
 * ticket between two already-occupied states, so it never needs re-asking
 * (the ticket already holds its slot for the rest of its pipeline lifetime).
 *
 * FIFO order is NOT decided here: it falls out of `store.list()`'s
 * `ORDER BY seq` (store-sql.ts) plus `step`'s sequential (non-concurrent)
 * iteration over that list — the oldest `backlog` ticket is always the first
 * one offered a chance to admit each round. `admit` only answers "is there
 * room right now", evaluated fresh (re-read from the store) so a dispatch
 * earlier in the SAME round is visible to the next ticket's check.
 *
 * KNOWN LIMITATION (documented, not fixed — lower priority, see DESIGN.md):
 * this is a read-then-act check, not `SELECT ... FOR UPDATE`. It is race-free
 * only because `step` runs sequentially within one reconciler and the
 * reconciler itself runs at `replicas: 1` + `Recreate` (tenet 3: reconciler is
 * the only mover — singular, not plural). Two concurrent reconcilers could
 * both read the same free slot and admit two tickets.
 */
export interface TicketSelector {
  readonly admit: (tickets: ReadonlyArray<Ticket>, config: Config) => boolean;
}

/** The only policy today: FIFO order (via iteration order), N free slots. */
export const fifoSelector: TicketSelector = {
  admit: (tickets, config) =>
    tickets.filter((t) => PIPELINE_OCCUPIED.includes(t.phase)).length < config.workers.max,
};

/**
 * Which BACKLOG tickets are waiting because `workers.max` is full — a
 * ROUND-level view (given one ticket snapshot) rather than `admit`'s per-ticket
 * one, used ONLY to power the reconciler's aggregate "cap full" log line so a
 * whole tick can be summarized in ONE line instead of an identical INFO per
 * deferred ticket, every 5s, forever. Never used for actual admission — that
 * stays `admit`, re-read fresh per ticket inside `stepTicket` (race-free within
 * a round, see its doc comment); this is a read-only approximation of the same
 * FIFO-order-plus-free-slots rule, for reporting.
 */
export const deferredBacklog = (
  tickets: ReadonlyArray<Ticket>,
  config: Config,
): ReadonlyArray<TicketId> => {
  const occupied = tickets.filter((t) => PIPELINE_OCCUPIED.includes(t.phase)).length;
  const free = Math.max(0, config.workers.max - occupied);
  return tickets
    .filter((t) => t.phase === 'queued')
    .slice(free)
    .map((t) => t.id);
};
