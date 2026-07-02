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
  pullState: () => Promise.resolve({ merged: false, state: 'open', mergeCommitSha: null }),
  checkRuns: () => Promise.resolve([]),
  commitStatuses: () => Promise.resolve([]),
  compare: () => Promise.resolve({ status: 'identical' }),
  updateBranch: () => Promise.resolve(),
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

  it.effect('isBranchUpToDate compares base to branch without leaking GitHub types', () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const forge = makeGithubForge(
        fakeRest({
          compare: (p) => {
            calls.push(p);
            return Promise.resolve({ status: 'behind' });
          },
        }),
      );

      assert.isFalse(
        yield* forge.isBranchUpToDate({ repo: 'o/r', base: 'main', branch: 'tp/tckt_x' }),
      );
      assert.deepStrictEqual(calls, [{ owner: 'o', repo: 'r', base: 'main', head: 'tp/tckt_x' }]);
    }),
  );

  it.effect('updateBranch calls the PR update API and maps conflicts', () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const ok = makeGithubForge(
        fakeRest({
          updateBranch: (p) => {
            calls.push(p);
            return Promise.resolve();
          },
        }),
      );
      yield* ok.updateBranch({ repo: 'o/r', prNumber: 42 });
      assert.deepStrictEqual(calls, [{ owner: 'o', repo: 'r', pull_number: 42 }]);

      const conflict = makeGithubForge(
        fakeRest({ updateBranch: () => Promise.reject({ status: 422 }) }),
      );
      const exit = yield* Effect.exit(conflict.updateBranch({ repo: 'o/r', prNumber: 42 }));
      assert.isTrue(
        exit._tag === 'Failure' &&
          exit.cause._tag === 'Fail' &&
          exit.cause.error._tag === 'MergeConflict',
      );
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

  /**
   * `prState` is the ground truth the reconciler reads before trusting its own
   * state (closes the external-merge/crash/lost-reply windows). The tri-state
   * mapping itself is unit-tested against `prLifecycleOf` in forge.test.ts; here
   * only the orchestration (calling `pullState`, wrapping the result, mapping a
   * rejected promise to `ForgeError`) is under test.
   */
  it.effect('prState reports merged with the merge sha', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(
        fakeRest({
          pullState: () =>
            Promise.resolve({ merged: true, state: 'closed', mergeCommitSha: 'deadbeef' }),
        }),
      );
      const state = yield* forge.prState({ repo: 'o/r', prNumber: 42 });
      assert.deepStrictEqual(state, { state: 'merged', mergeSha: 'deadbeef' });
    }),
  );

  it.effect('prState reports closed (no merge) with a null sha', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(
        fakeRest({
          pullState: () =>
            Promise.resolve({ merged: false, state: 'closed', mergeCommitSha: null }),
        }),
      );
      const state = yield* forge.prState({ repo: 'o/r', prNumber: 42 });
      assert.deepStrictEqual(state, { state: 'closed', mergeSha: null });
    }),
  );

  it.effect('prState reports open by default', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(fakeRest());
      const state = yield* forge.prState({ repo: 'o/r', prNumber: 42 });
      assert.deepStrictEqual(state, { state: 'open', mergeSha: null });
    }),
  );

  it.effect('prState maps a rejected lookup to ForgeError', () =>
    Effect.gen(function* () {
      const forge = makeGithubForge(
        fakeRest({ pullState: () => Promise.reject(new Error('github 503')) }),
      );
      const exit = yield* Effect.exit(forge.prState({ repo: 'o/r', prNumber: 42 }));
      assert.isTrue(
        exit._tag === 'Failure' &&
          exit.cause._tag === 'Fail' &&
          exit.cause.error._tag === 'ForgeError',
      );
    }),
  );
});
