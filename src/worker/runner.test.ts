import { fileURLToPath } from 'node:url';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import { RunnerResult } from './protocol.ts';
import { makeProgram } from './runner.ts';
import type { FormatPort, GitPort } from './runner-core.ts';

/**
 * Two guarantees the entrypoint must hold: (1) it bundles — `Bun.build` resolves
 * runner.ts (and its sdk + effect deps) into one artifact, the exact thing the
 * orchestrator uploads; (2) it emits exactly ONE stdout line that decodes as a
 * `RunnerResult`. We prove (2) with fake ports so no server or clone is needed.
 */

const config = {
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

const fakeOpencode: OpencodePort = {
  startServer: async () => ({ url: 'http://fake' }),
  stopServer: () => {},
  createSession: async () => 'ses_fake',
  subscribeEvents: async function* () {
    yield { type: 'session.idle', properties: { sessionID: 'ses_fake' } };
  },
  prompt: async () => ({ info: assistantInfo, text: 'done' }),
};

describe('runner bundle', () => {
  it('bundles runner.ts (with sdk + effect) into a single artifact', async () => {
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./runner.ts', import.meta.url))],
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

describe('makeProgram', () => {
  it('emits exactly one stdout line that decodes as a RunnerResult', async () => {
    const lines: Array<string> = [];
    await Effect.runPromise(
      makeProgram({
        git: fakeGit,
        opencode: fakeOpencode,
        format: fakeFormat,
        readConfig: async () => JSON.stringify(config),
        emit: (line) => lines.push(line),
      }),
    );
    assert.strictEqual(lines.length, 1);
    const [line] = lines;
    assert.ok(line !== undefined);
    assert.strictEqual(line.includes('\n'), false);
    const result = Effect.runSync(Schema.decode(Schema.parseJson(RunnerResult))(line));
    assert.strictEqual(result.commitSha, 'deadbeef');
    assert.strictEqual(result.usage.tokensIn, 1200);
  });
});
