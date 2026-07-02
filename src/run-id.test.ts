import { afterEach, assert, describe, it } from '@effect/vitest';
import { workerRunId } from './run-id.ts';

/**
 * The worker-side half of the run-id correlation thread (tckt_4utv62nij6):
 * fail-open to `dev` exactly like `shortGitSha`, so a pod started without the
 * env var (local dev, a manual `kubectl run`) never crashes or fabricates a
 * fake handle.
 */
describe('workerRunId', () => {
  const original = process.env.TIDEPOOL_RUN_ID;

  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_RUN_ID;
    else process.env.TIDEPOOL_RUN_ID = original;
  });

  it('reads the run id from the env var', () => {
    process.env.TIDEPOOL_RUN_ID = 'work-tckt-ab12cd-x7q2';
    assert.strictEqual(workerRunId(), 'work-tckt-ab12cd-x7q2');
  });

  it('falls back to dev when unset', () => {
    delete process.env.TIDEPOOL_RUN_ID;
    assert.strictEqual(workerRunId(), 'dev');
  });

  it('falls back to dev when empty/whitespace', () => {
    process.env.TIDEPOOL_RUN_ID = '   ';
    assert.strictEqual(workerRunId(), 'dev');
  });

  it('takes an explicit override over the env var', () => {
    process.env.TIDEPOOL_RUN_ID = 'work-tckt-ab12cd-x7q2';
    assert.strictEqual(workerRunId('explicit-handle'), 'explicit-handle');
  });
});
