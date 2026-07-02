import { afterEach, assert, describe, it } from '@effect/vitest';
import { shortGitSha } from './git-sha.ts';

/**
 * The log-stamping sha (distinct from `gitShaLabelValue` in
 * infra/pulumi/cluster/guards.ts, which coerces the FULL sha into a k8s-label-safe
 * value): a 7-char slice of `TIDEPOOL_GIT_SHA` for humans reading `kubectl logs`,
 * fail-open to `dev` so a local/off-cluster run never crashes or prints a
 * truncated partial sha.
 */
describe('shortGitSha', () => {
  const original = process.env.TIDEPOOL_GIT_SHA;

  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_GIT_SHA;
    else process.env.TIDEPOOL_GIT_SHA = original;
  });

  it('slices a full sha to the first 7 chars', () => {
    process.env.TIDEPOOL_GIT_SHA = 'abc1234def5678';
    assert.strictEqual(shortGitSha(), 'abc1234');
  });

  it('falls back to dev when unset', () => {
    delete process.env.TIDEPOOL_GIT_SHA;
    assert.strictEqual(shortGitSha(), 'dev');
  });

  it('falls back to dev when empty', () => {
    process.env.TIDEPOOL_GIT_SHA = '';
    assert.strictEqual(shortGitSha(), 'dev');
  });

  it('falls back to dev when shorter than 7 chars (never emits a truncated sha)', () => {
    process.env.TIDEPOOL_GIT_SHA = 'abc12';
    assert.strictEqual(shortGitSha(), 'dev');
  });

  it('takes an explicit override over the env var', () => {
    process.env.TIDEPOOL_GIT_SHA = 'abc1234def5678';
    assert.strictEqual(shortGitSha('deadbeefcafe'), 'deadbee');
  });
});
