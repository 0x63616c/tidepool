import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import type { RunnerConfig } from './protocol.ts';
import {
  FormatFailed,
  type FormatPort,
  GitFailed,
  type GitPort,
  makeRunner,
  NoChanges,
  preCommitCommands,
} from './runner-core.ts';

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

const makeGit = (
  over: Partial<GitPort> = {},
  calls: GitCalls = { ops: [] },
): { git: GitPort; calls: GitCalls } => {
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

const makeFormat = (
  over: Partial<FormatPort> = {},
  calls: GitCalls = { ops: [] },
): { format: FormatPort; calls: GitCalls } => {
  const format: FormatPort = {
    hasFormatScript: async () => {
      calls.ops.push('hasFormatScript');
      return true;
    },
    run: async (_dir, command) => {
      calls.ops.push(`run:${command}`);
    },
    ...over,
  };
  return { format, calls };
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

describe('preCommitCommands', () => {
  it('always runs biome SAFE autofix and never --unsafe', () => {
    const cmds = preCommitCommands({ hasFormatScript: false });
    assert.deepStrictEqual(cmds, ['bunx biome check --write .']);
    assert.strictEqual(
      cmds.some((c) => c.includes('--unsafe')),
      false,
    );
  });

  it("appends the repo's format script when package.json declares one", () => {
    assert.deepStrictEqual(preCommitCommands({ hasFormatScript: true }), [
      'bunx biome check --write .',
      'bun run format',
    ]);
  });
});

describe('makeRunner', () => {
  it('formats + biome-fixes the generated code before committing', async () => {
    // One shared ordered call log across git + format so we can assert ordering.
    const calls: GitCalls = { ops: [] };
    const { git } = makeGit({}, calls);
    const { format } = makeFormat({}, calls);
    const { opencode, stopped } = makeOpencode();
    const result = await Effect.runPromise(makeRunner({ git, opencode, format })(config));
    assert.strictEqual(result.commitSha, 'deadbeef');
    assert.deepStrictEqual(calls.ops, [
      'clone',
      'branch',
      'config',
      'status',
      'hasFormatScript',
      'run:bunx biome check --write .',
      'run:bun run format',
      'add',
      'commit',
      'headSha',
      'push',
    ]);
    // The biome-write/format steps must precede the commit so PRs pass CI.
    assert.strictEqual(
      calls.ops.indexOf('run:bunx biome check --write .') < calls.ops.indexOf('commit'),
      true,
    );
    assert.strictEqual(stopped(), 1, 'server released on success');
  });

  it('skips the format script step when package.json has none', async () => {
    const { git, calls } = makeGit();
    const { format } = makeFormat({ hasFormatScript: async () => false });
    const { opencode } = makeOpencode();
    await Effect.runPromise(makeRunner({ git, opencode, format })(config));
    assert.strictEqual(calls.ops.includes('run:bun run format'), false);
  });

  it('fails NoChanges (and never formats or commits) when the agent produced no diff', async () => {
    const { git, calls } = makeGit({ statusPorcelain: async () => '   ' });
    const { format } = makeFormat();
    const { opencode, stopped } = makeOpencode();
    const exit = await Effect.runPromiseExit(makeRunner({ git, opencode, format })(config));
    assert.strictEqual(
      Exit.isFailure(exit) && exit.cause._tag === 'Fail' && exit.cause.error instanceof NoChanges,
      true,
    );
    assert.strictEqual(calls.ops.includes('commit'), false);
    assert.strictEqual(calls.ops.includes('run:bunx biome check --write .'), false);
    assert.strictEqual(stopped(), 1, 'server still released on a post-session failure');
  });

  it('surfaces a typed FormatFailed when a pre-commit format step fails', async () => {
    const { git, calls } = makeGit();
    const { format } = makeFormat({
      run: () => Promise.reject(new Error('biome: unfixable error')),
    });
    const { opencode } = makeOpencode();
    const exit = await Effect.runPromiseExit(makeRunner({ git, opencode, format })(config));
    assert.strictEqual(
      Exit.isFailure(exit) &&
        exit.cause._tag === 'Fail' &&
        exit.cause.error instanceof FormatFailed,
      true,
    );
    assert.strictEqual(calls.ops.includes('commit'), false);
  });

  it('surfaces a typed GitFailed when a git step fails', async () => {
    const { git } = makeGit({ push: () => Promise.reject(new Error('rejected')) });
    const { format } = makeFormat();
    const { opencode } = makeOpencode();
    const exit = await Effect.runPromiseExit(makeRunner({ git, opencode, format })(config));
    assert.strictEqual(
      Exit.isFailure(exit) && exit.cause._tag === 'Fail' && exit.cause.error instanceof GitFailed,
      true,
    );
  });
});
