import type { Config } from './config.ts';
import type { Ticket, TicketState } from './domain.ts';

/**
 * Ticket selection — the ONE question the reconciler asks before letting a
 * ticket leave `backlog`: is there a free `workers.max` slot? Pulled out of
 * `reconciler.ts` into its own pure, DI-free module so a future policy
 * (`--blocked-by`, priority, newest-not-blocked) slots in by swapping this
 * file's export, not by touching `stepTicket` (tenet 4: narrow front, hidden
 * impl — the reconciler only ever calls `fifoSelector.admit`).
 */

/**
 * States that hold a `workers.max` slot: everything past `backlog` and before
 * a terminal state (`done` | `failed`). `rate_capped` counts too — it is a
 * ticket mid-pipeline (open branch, sometimes an open PR) that has merely been
 * asked to wait out a provider rate limit; it re-enters `in_progress`/`review`
 * on the very next `step` (see reconciler.ts's `rate_capped` case), so it is
 * never actually idle while holding its slot. Letting it release the slot
 * would let a SECOND ticket start mid-pipeline at `max=1`, breaking the
 * merge-safety guarantee `workers.max` exists for (DESIGN.md §Compute:
 * "N=1 serializes tickets ... merge conflicts essentially can't occur").
 */
export const PIPELINE_OCCUPIED: ReadonlyArray<TicketState> = [
  'in_progress',
  'running',
  'review',
  'rate_capped',
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
    tickets.filter((t) => PIPELINE_OCCUPIED.includes(t.state)).length < config.workers.max,
};
