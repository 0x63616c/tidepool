import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { type GithubRest, makeGithubForge } from './forge.ts';

/**
 * The GitHub adapter's orchestration — driven through the locked `ForgeApi` over
 * a fake `GithubRest` port, so behaviour is verified with no network. The real
 * port just binds Octokit; these tests own the mapping logic.
 */

const fakeRest = (over: Partial<GithubRest> = {}): GithubRest => ({
  createPull: () => Promise.resolve({ number: 42, url: 'https://github.com/o/r/pull/42' }),
  headSha: () => Promise.resolve('abc123'),
  checkRuns: () => Promise.resolve([]),
  commitStatuses: () => Promise.resolve([]),
  squashMerge: () => Promise.resolve({ sha: 'merged-sha' }),
  ...over,
});

describe('makeGithubForge', () => {
  it.effect('openPR creates the PR and assigns a fresh prefixed prId', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(fakeRest());
      const pr = yield* forge.openPR({
        repo: 'o/r',
        branch: 'tp/x',
        base: 'main',
        title: 't',
        body: 'b',
      });
      assert.strictEqual(pr.number, 42);
      assert.strictEqual(pr.url, 'https://github.com/o/r/pull/42');
      assert.isTrue(pr.id.startsWith('pr_'));
    }),
  );

  it.effect('checks rolls up check-runs + statuses at the PR head into one CIStatus', () =>
    Effect.gen(function* () {
      const green = makeGithubForge(
        fakeRest({
          checkRuns: () => Promise.resolve([{ status: 'completed', conclusion: 'success' }]),
          commitStatuses: () => Promise.resolve([{ state: 'success' }]),
        }),
      );
      assert.strictEqual(yield* green.checks({ repo: 'o/r', prNumber: 42 }), 'green');

      const red = makeGithubForge(
        fakeRest({
          checkRuns: () => Promise.resolve([{ status: 'completed', conclusion: 'failure' }]),
        }),
      );
      assert.strictEqual(yield* red.checks({ repo: 'o/r', prNumber: 42 }), 'red');
    }),
  );

  it.effect('merge squashes and returns the merge sha', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(
        fakeRest({ squashMerge: () => Promise.resolve({ sha: 'deadbeef' }) }),
      );
      const merged = yield* forge.merge({ repo: 'o/r', prNumber: 42 });
      assert.strictEqual(merged.sha, 'deadbeef');
    }),
  );

  it.effect('merge maps a 409 to MergeConflict', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(
        fakeRest({ squashMerge: () => Promise.reject({ status: 409 }) }),
      );
      const exit = yield* Effect.exit(forge.merge({ repo: 'o/r', prNumber: 42 }));
      assert.isTrue(
        exit._tag === 'Failure' &&
          exit.cause._tag === 'Fail' &&
          exit.cause.error._tag === 'MergeConflict',
      );
    }),
  );

  it.effect('merge maps a 500 to ForgeError', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(
        fakeRest({ squashMerge: () => Promise.reject({ status: 500 }) }),
      );
      const exit = yield* Effect.exit(forge.merge({ repo: 'o/r', prNumber: 42 }));
      assert.isTrue(
        exit._tag === 'Failure' &&
          exit.cause._tag === 'Fail' &&
          exit.cause.error._tag === 'ForgeError',
      );
    }),
  );
});
