import { assert, describe, it } from '@effect/vitest';
import {
  checkRunState,
  classifyMergeError,
  combineCI,
  commitStatusState,
  parseRepo,
} from './forge.ts';

/**
 * The CI roll-up is the load-bearing decision in the review loop, so it gets a
 * pure unit. A PR head SHA has many checks (GitHub check-runs + legacy commit
 * statuses); they collapse to one `CIStatus`. Semantics: WAIT while anything is
 * still running (don't burn a retry on a not-yet-settled run), then red if any
 * settled check failed, else green. No checks at all ⇒ pending (nothing reported).
 */

describe('combineCI', () => {
  it('no checks → pending', () => {
    assert.strictEqual(combineCI([]), 'pending');
  });

  it('all success → green', () => {
    assert.strictEqual(combineCI(['success', 'success']), 'green');
  });

  it('a settled failure → red', () => {
    assert.strictEqual(combineCI(['success', 'failure']), 'red');
  });

  it('still pending wins over an already-failed check (wait, do not retry yet)', () => {
    assert.strictEqual(combineCI(['failure', 'pending']), 'pending');
  });

  it('neutral/skipped does not block green', () => {
    assert.strictEqual(combineCI(['success', 'neutral']), 'green');
  });
});

describe('checkRunState', () => {
  it('not completed → pending', () => {
    assert.strictEqual(checkRunState('in_progress', null), 'pending');
    assert.strictEqual(checkRunState('queued', null), 'pending');
  });
  it('completed success → success', () => {
    assert.strictEqual(checkRunState('completed', 'success'), 'success');
  });
  it('completed skipped/neutral → neutral', () => {
    assert.strictEqual(checkRunState('completed', 'skipped'), 'neutral');
    assert.strictEqual(checkRunState('completed', 'neutral'), 'neutral');
  });
  it('completed failure/cancelled/timed_out → failure', () => {
    assert.strictEqual(checkRunState('completed', 'failure'), 'failure');
    assert.strictEqual(checkRunState('completed', 'cancelled'), 'failure');
    assert.strictEqual(checkRunState('completed', 'timed_out'), 'failure');
  });
});

describe('commitStatusState', () => {
  it('maps legacy commit status states', () => {
    assert.strictEqual(commitStatusState('pending'), 'pending');
    assert.strictEqual(commitStatusState('success'), 'success');
    assert.strictEqual(commitStatusState('failure'), 'failure');
    assert.strictEqual(commitStatusState('error'), 'failure');
  });
});

describe('classifyMergeError', () => {
  it('405/409 are merge conflicts (stale branch); other codes are forge errors', () => {
    assert.strictEqual(classifyMergeError(405), 'conflict');
    assert.strictEqual(classifyMergeError(409), 'conflict');
    assert.strictEqual(classifyMergeError(500), 'forge');
    assert.strictEqual(classifyMergeError(401), 'forge');
  });
});

describe('parseRepo', () => {
  it('splits owner/name', () => {
    assert.deepStrictEqual(parseRepo('0x63616c/tidepool-testbed'), {
      owner: '0x63616c',
      name: 'tidepool-testbed',
    });
  });
});
