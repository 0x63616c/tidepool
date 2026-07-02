import { assert, describe, it } from '@effect/vitest';
import { defineConfig } from './config.ts';
import { deriveStateFromPhase, type Ticket, type TicketPhase } from './domain.ts';
import { deferredBacklog, fifoSelector, PIPELINE_OCCUPIED } from './selection.ts';

/**
 * `fifoSelector` — pure, no Effect/DI needed (that's the point of the seam:
 * a plain function a future policy can swap in). Covered in isolation here;
 * `reconciler.test.ts` covers it wired into `step`/`settle`.
 */

const configWithMax = (max: number) =>
  defineConfig({
    targets: [{ repo: 't/repo', base: 'main', models: { work: 'm', review: 'm' } }],
    models: { work: 'm', review: 'm' },
    workers: { max, idleTimeoutSec: 300, maxTtlSec: 3600 },
    retries: 2,
  });

let seq = 0;
const ticketIn = (phase: TicketPhase, conditions: Ticket['conditions'] = []): Ticket =>
  ({
    id: `tckt_${++seq}` as Ticket['id'],
    title: 't',
    body: 'g',
    target: 't/repo',
    state: deriveStateFromPhase({ phase, conditions, prNumber: null, workHandle: null }),
    phase,
    conditions,
    branch: null,
    prNumber: null,
    prId: null,
    mergeSha: null,
    attempts: 0,
    contentionCount: 0,
    workedAttempt: null,
    reason: null,
    workHandle: null,
    dispatchedAt: null,
  }) as Ticket;

describe('PIPELINE_OCCUPIED', () => {
  it('holds every non-terminal phase past queued', () => {
    assert.sameMembers([...PIPELINE_OCCUPIED], ['working', 'reviewing', 'merging', 'verifying']);
  });
});

describe('fifoSelector.admit', () => {
  it('admits when no ticket occupies a pipeline slot', () => {
    assert.isTrue(fifoSelector.admit([ticketIn('queued')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is working', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('working')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is merging', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('merging')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is reviewing', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('reviewing')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is rate_capped (a gate, not a state — still holds its slot)', () => {
    assert.isFalse(
      fifoSelector.admit([ticketIn('working', [{ type: 'rate_capped' }])], configWithMax(1)),
    );
  });

  it('does not count queued/done/failed toward the occupied total', () => {
    const tickets = [ticketIn('queued'), ticketIn('queued'), ticketIn('done'), ticketIn('failed')];
    assert.isTrue(fifoSelector.admit(tickets, configWithMax(1)));
  });

  it('generalizes to N: admits up to max concurrently-occupied slots, blocks past it', () => {
    const config = configWithMax(2);
    assert.isTrue(fifoSelector.admit([ticketIn('working')], config)); // 1 occupied < 2
    assert.isFalse(
      fifoSelector.admit([ticketIn('working'), ticketIn('verifying')], config), // 2 occupied >= 2
    );
  });
});

describe('deferredBacklog', () => {
  // A round-level (not per-ticket) view of who's waiting — feeds the reconciler's
  // aggregate 'cap full' log line so it can summarize a whole tick in ONE line
  // instead of an identical INFO per deferred ticket, every 5s, forever.

  it('reports nothing deferred when there is a free slot', () => {
    assert.deepStrictEqual(deferredBacklog([ticketIn('queued')], configWithMax(1)), []);
  });

  it('defers every backlog ticket when the cap is already full', () => {
    const occupied = ticketIn('working');
    const waiting = [ticketIn('queued'), ticketIn('queued')];
    assert.deepStrictEqual(
      deferredBacklog([occupied, ...waiting], configWithMax(1)),
      waiting.map((t) => t.id),
    );
  });

  it('defers only the overflow past the free slots, in list (FIFO) order', () => {
    const first = ticketIn('queued');
    const second = ticketIn('queued');
    const third = ticketIn('queued');
    // max=2, nothing occupied yet → 2 free slots → the first 2 admit, the 3rd waits.
    assert.deepStrictEqual(deferredBacklog([first, second, third], configWithMax(2)), [third.id]);
  });

  it('never defers non-backlog tickets', () => {
    assert.deepStrictEqual(
      deferredBacklog(
        [ticketIn('working'), ticketIn('done'), ticketIn('failed')],
        configWithMax(1),
      ),
      [],
    );
  });
});
