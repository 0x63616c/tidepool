import { fileURLToPath } from 'node:url';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import { ReviewRunnerResult } from './protocol.ts';
import { makeReviewProgram } from './review-runner.ts';

/**
 * Two guarantees the review entrypoint (FIX 1) must hold: (1) it bundles —
 * `Bun.build` resolves review-runner.ts (and its sdk + effect deps) into one
 * artifact, the exact thing uploaded to the leased box; (2) it ensures the scratch
 * dir, drives one session, and emits exactly ONE stdout line that decodes as a
 * `ReviewRunnerResult`. We prove (2) with fake ports — no server, no box.
 */

const config = { dir: '/tmp/tp-review-x', model: 'openai/gpt-5.4-mini', prompt: 'grade it' };

const assistantInfo = {
  id: 'msg_1',
  sessionID: 'ses_fake',
  role: 'assistant',
  time: { created: 1000, completed: 3500 },
  modelID: 'gpt-5.4-mini',
  providerID: 'openai',
  tokens: { input: 1200, output: 340 },
};

const fakeOpencode: OpencodePort = {
  startServer: async () => ({ url: 'http://fake' }),
  stopServer: () => {},
  createSession: async () => 'ses_fake',
  subscribeEvents: async function* () {
    yield { type: 'message.updated', properties: { info: assistantInfo } };
    yield { type: 'session.idle', properties: { sessionID: 'ses_fake' } };
  },
  prompt: async () => ({ info: assistantInfo, text: 'looks good\nVERDICT: APPROVE' }),
  listMessages: async () => [],
};

describe('review runner bundle', () => {
  it('bundles review-runner.ts (with sdk + effect) into a single artifact', async () => {
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./review-runner.ts', import.meta.url))],
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

describe('makeReviewProgram', () => {
  it('ensures the scratch dir and emits one stdout line decoding as a ReviewRunnerResult', async () => {
    const lines: Array<string> = [];
    const ensured: Array<string> = [];
    await Effect.runPromise(
      makeReviewProgram({
        opencode: fakeOpencode,
        ensureDir: async (dir) => {
          ensured.push(dir);
        },
        readConfig: async () => JSON.stringify(config),
        emit: (line) => lines.push(line),
      }),
    );
    assert.deepStrictEqual(ensured, [config.dir]);
    assert.strictEqual(lines.length, 1);
    const [line] = lines;
    assert.ok(line !== undefined);
    assert.strictEqual(line.includes('\n'), false);
    const result = Effect.runSync(Schema.decode(Schema.parseJson(ReviewRunnerResult))(line));
    assert.strictEqual(result.text, 'looks good\nVERDICT: APPROVE');
    assert.strictEqual(result.usage.tokensIn, 1200);
  });
});
