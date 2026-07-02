import { assert, describe, it } from '@effect/vitest';
import { defineConfig } from './config.ts';
import type { Ticket, TicketState } from './domain.ts';
import { fifoSelector, PIPELINE_OCCUPIED } from './selection.ts';

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
    goal: 'g',
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
