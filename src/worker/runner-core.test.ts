import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import type { RunnerConfig } from './protocol.ts';
import { GitFailed, type GitPort, makeRunner, NoChanges } from './runner-core.ts';

/**
 * `makeRunner` is the runner's orchestration core: clone → branch → session →
 * dirty-check → commit → push. It is proved against fake git + opencode ports —
 * no clone, no server — so the control flow (and the typed GitFailed/NoChanges
 * outcomes) is testable without a box. The scoped opencode server-release
 * finalizer must fire whether the run succeeds or fails after the session.
 */

const config: RunnerConfig = {
  cloneUrl: 'https://x-access-token:tok@github.com/o/r.git',
  base: 'main',
  branch: 'tp/tckt_x-do-thing',
  dir: '/tmp/tp-work-x',
  model: 'openai/gpt-5.4-mini',
  prompt: 'do the thing',
  commitMsg: '#tckt_x feat: do the thing',
};

const assistantInfo = {
  id: 'msg_1',
  sessionID: 'ses_fake',
  role: 'assistant',
  time: { created: 1000, completed: 3500 },
  modelID: 'gpt-5.4-mini',
  providerID: 'openai',
  tokens: { input: 1200, output: 340 },
};

interface GitCalls {
  readonly ops: Array<string>;
}

const makeGit = (over: Partial<GitPort> = {}): { git: GitPort; calls: GitCalls } => {
  const calls: GitCalls = { ops: [] };
  const note =
    <A>(op: string, value: A) =>
    async (): Promise<A> => {
      calls.ops.push(op);
      return value;
    };
  const git: GitPort = {
    clone: note('clone', undefined),
    checkoutBranch: note('branch', undefined),
    configUser: note('config', undefined),
    statusPorcelain: note('status', ' M src/string.ts'),
    addAll: note('add', undefined),
    commit: note('commit', undefined),
    headSha: note('headSha', 'deadbeef\n'),
    push: note('push', undefined),
    ...over,
  };
  return { git, calls };
};

const makeOpencode = (): { opencode: OpencodePort; stopped: () => number } => {
  let stopped = 0;
  const opencode: OpencodePort = {
    startServer: async () => ({ url: 'http://fake' }),
    stopServer: () => {
      stopped += 1;
    },
    createSession: async () => 'ses_fake',
    subscribeEvents: async function* () {
      yield { type: 'message.updated', properties: { info: assistantInfo } };
      yield { type: 'session.idle', properties: { sessionID: 'ses_fake' } };
    },
    prompt: async () => assistantInfo,
  };
  return { opencode, stopped: () => stopped };
};

describe('makeRunner', () => {
  it('clones, branches, drives the session, commits and pushes — returning the result', async () => {
    const { git, calls } = makeGit();
    const { opencode, stopped } = makeOpencode();
    const result = await Effect.runPromise(makeRunner({ git, opencode })(config));
    assert.strictEqual(result.commitSha, 'deadbeef');
    assert.strictEqual(result.usage.tokensIn, 1200);
    assert.deepStrictEqual(calls.ops, [
      'clone',
      'branch',
      'config',
      'status',
      'add',
      'commit',
      'headSha',
      'push',
    ]);
    assert.strictEqual(stopped(), 1, 'server released on success');
  });

  it('fails NoChanges (and never commits) when the agent produced no diff', async () => {
    const { git, calls } = makeGit({ statusPorcelain: async () => '   ' });
    const { opencode, stopped } = makeOpencode();
    const exit = await Effect.runPromiseExit(makeRunner({ git, opencode })(config));
    assert.strictEqual(
      Exit.isFailure(exit) && exit.cause._tag === 'Fail' && exit.cause.error instanceof NoChanges,
      true,
    );
    assert.strictEqual(calls.ops.includes('commit'), false);
    assert.strictEqual(stopped(), 1, 'server still released on a post-session failure');
  });

  it('surfaces a typed GitFailed when a git step fails', async () => {
    const { git } = makeGit({ push: () => Promise.reject(new Error('rejected')) });
    const { opencode } = makeOpencode();
    const exit = await Effect.runPromiseExit(makeRunner({ git, opencode })(config));
    assert.strictEqual(
      Exit.isFailure(exit) && exit.cause._tag === 'Fail' && exit.cause.error instanceof GitFailed,
      true,
    );
  });
});
