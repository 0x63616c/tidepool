import { assert, describe, it } from '@effect/vitest';
import { defineConfig } from './config.ts';
import type { Ticket, TicketState } from './domain.ts';
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
const ticketIn = (state: TicketState): Ticket =>
  ({
    id: `tckt_${++seq}` as Ticket['id'],
    title: 't',
    body: 'g',
    target: 't/repo',
    state,
    branch: null,
    prNumber: null,
    prId: null,
    mergeSha: null,
    attempts: 0,
    workedAttempt: null,
    reason: null,
    workHandle: null,
    dispatchedAt: null,
  }) as Ticket;

describe('PIPELINE_OCCUPIED', () => {
  it('holds every non-terminal state past backlog, including rate_capped', () => {
    assert.sameMembers([...PIPELINE_OCCUPIED], ['in_progress', 'running', 'review', 'rate_capped']);
  });
});

describe('fifoSelector.admit', () => {
  it('admits when no ticket occupies a pipeline slot', () => {
    assert.isTrue(fifoSelector.admit([ticketIn('backlog')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is in_progress', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('in_progress')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is running', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('running')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is in review', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('review')], configWithMax(1)));
  });

  it('blocks at max=1 when one ticket is rate_capped (mid-pipeline, holds its slot)', () => {
    assert.isFalse(fifoSelector.admit([ticketIn('rate_capped')], configWithMax(1)));
  });

  it('does not count backlog/done/failed toward the occupied total', () => {
    const tickets = [
      ticketIn('backlog'),
      ticketIn('backlog'),
      ticketIn('done'),
      ticketIn('failed'),
    ];
    assert.isTrue(fifoSelector.admit(tickets, configWithMax(1)));
  });

  it('generalizes to N: admits up to max concurrently-occupied slots, blocks past it', () => {
    const config = configWithMax(2);
    assert.isTrue(fifoSelector.admit([ticketIn('running')], config)); // 1 occupied < 2
    assert.isFalse(
      fifoSelector.admit([ticketIn('running'), ticketIn('review')], config), // 2 occupied >= 2
    );
  });
});

describe('deferredBacklog', () => {
  // A round-level (not per-ticket) view of who's waiting — feeds the reconciler's
  // aggregate 'cap full' log line so it can summarize a whole tick in ONE line
  // instead of an identical INFO per deferred ticket, every 5s, forever.

  it('reports nothing deferred when there is a free slot', () => {
    assert.deepStrictEqual(deferredBacklog([ticketIn('backlog')], configWithMax(1)), []);
  });

  it('defers every backlog ticket when the cap is already full', () => {
    const occupied = ticketIn('running');
    const waiting = [ticketIn('backlog'), ticketIn('backlog')];
    assert.deepStrictEqual(
      deferredBacklog([occupied, ...waiting], configWithMax(1)),
      waiting.map((t) => t.id),
    );
  });

  it('defers only the overflow past the free slots, in list (FIFO) order', () => {
    const first = ticketIn('backlog');
    const second = ticketIn('backlog');
    const third = ticketIn('backlog');
    // max=2, nothing occupied yet → 2 free slots → the first 2 admit, the 3rd waits.
    assert.deepStrictEqual(deferredBacklog([first, second, third], configWithMax(2)), [third.id]);
  });

  it('never defers non-backlog tickets', () => {
    assert.deepStrictEqual(
      deferredBacklog(
        [ticketIn('running'), ticketIn('done'), ticketIn('failed')],
        configWithMax(1),
      ),
      [],
    );
  });
});
