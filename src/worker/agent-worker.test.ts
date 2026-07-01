import { fileURLToPath } from 'node:url';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { makeAgentWorkerProgram } from './agent-worker.ts';
import type { OpencodePort } from './opencode-session.ts';
import { ReviewRunnerResult, RunnerResult } from './protocol.ts';
import type { FormatPort, GitPort } from './runner-core.ts';

/**
 * The generalized agent-worker entrypoint dispatches on `config.kind`: `work`
 * runs the full clone→edit→commit→push core and emits a `RunnerResult`; `review`
 * drives one session over an embedded diff and emits a `ReviewRunnerResult`. Both
 * arms must write EXACTLY ONE stdout line (the schema the runner prints today —
 * no new result channel). We prove both branches with fake ports so no server or
 * clone is needed, and that the file bundles (the artifact a k8s Job would run).
 */

const workConfig = {
  kind: 'work',
  cloneUrl: 'https://x-access-token:tok@github.com/o/r.git',
  base: 'main',
  branch: 'tp/tckt_x-do-thing',
  dir: '/tmp/tp-work-x',
  model: 'openai/gpt-5.4-mini',
  prompt: 'do the thing',
  commitMsg: '#tckt_x feat: do the thing',
};

const reviewConfig = {
  kind: 'review',
  dir: '/tmp/tp-review-x',
  model: 'openai/gpt-5.4-mini',
  prompt: 'review this diff',
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

const fakeGit: GitPort = {
  clone: async () => {},
  checkoutBranch: async () => {},
  configUser: async () => {},
  statusPorcelain: async () => ' M src/string.ts',
  addAll: async () => {},
  commit: async () => {},
  headSha: async () => 'deadbeef\n',
  push: async () => {},
};

const fakeFormat: FormatPort = {
  hasFormatScript: async () => true,
  run: async () => {},
};

const fakeOpencode = (text: string): OpencodePort => ({
  startServer: async () => ({ url: 'http://fake' }),
  stopServer: () => {},
  createSession: async () => 'ses_fake',
  subscribeEvents: async function* () {
    yield { type: 'session.idle', properties: { sessionID: 'ses_fake' } };
  },
  prompt: async () => ({ info: assistantInfo, text }),
});

const runWith = async (config: unknown, opencode: OpencodePort): Promise<Array<string>> => {
  const lines: Array<string> = [];
  await Effect.runPromise(
    makeAgentWorkerProgram({
      git: fakeGit,
      opencode,
      format: fakeFormat,
      ensureDir: async () => {},
      readConfig: async () => JSON.stringify(config),
      emit: (line) => lines.push(line),
    }),
  );
  return lines;
};

describe('agent-worker dispatch', () => {
  it('kind=work → emits exactly one line decoding as a RunnerResult', async () => {
    const lines = await runWith(workConfig, fakeOpencode('done'));
    assert.strictEqual(lines.length, 1);
    const [line] = lines;
    assert.ok(line !== undefined);
    assert.strictEqual(line.includes('\n'), false);
    const result = Effect.runSync(Schema.decode(Schema.parseJson(RunnerResult))(line));
    assert.strictEqual(result.commitSha, 'deadbeef');
    assert.strictEqual(result.usage.tokensIn, 1200);
  });

  it('kind=review → emits exactly one line decoding as a ReviewRunnerResult', async () => {
    const lines = await runWith(reviewConfig, fakeOpencode('VERDICT: APPROVE'));
    assert.strictEqual(lines.length, 1);
    const [line] = lines;
    assert.ok(line !== undefined);
    assert.strictEqual(line.includes('\n'), false);
    const result = Effect.runSync(Schema.decode(Schema.parseJson(ReviewRunnerResult))(line));
    assert.strictEqual(result.text, 'VERDICT: APPROVE');
    assert.strictEqual(result.usage.tokensIn, 1200);
  });
});

describe('agent-worker bundle', () => {
  it('bundles agent-worker.ts (with sdk + effect) into a single artifact', async () => {
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./agent-worker.ts', import.meta.url))],
      target: 'bun',
      external: ['bun'],
    });
    assert.strictEqual(built.success, true);
    assert.strictEqual(built.outputs.length, 1);
    const [artifact] = built.outputs;
    assert.ok(artifact !== undefined);
    const code = await artifact.text();
    assert.strictEqual(code.length > 0, true);
  });
});
