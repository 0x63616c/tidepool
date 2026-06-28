import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { OpencodeFailed, type OpencodePort, runSession } from './opencode-session.ts';

/**
 * `runSession` is the deep module over opencode: it owns the embedded server's
 * lifecycle (acquireRelease) and the event-collector fiber (forkScoped), and
 * hands back a typed `Usage`. We prove it against a fake port — no real server,
 * no network — asserting (a) it rolls the streamed events into usage and
 * (b) the scoped server-release finalizer always runs, even when a step fails.
 */

const assistantMsg = {
  type: 'message.updated',
  properties: {
    info: {
      id: 'msg_1',
      sessionID: 'ses_fake',
      role: 'assistant',
      time: { created: 1000, completed: 3500 },
      modelID: 'gpt-5.4-mini',
      providerID: 'openai',
      tokens: { input: 1200, output: 340 },
    },
  },
};

const idleFor = (sessionId: string) => ({
  type: 'session.idle',
  properties: { sessionID: sessionId },
});

interface Calls {
  started: number;
  stopped: number;
}

const makeFake = (over: Partial<OpencodePort> = {}): { port: OpencodePort; calls: Calls } => {
  const calls: Calls = { started: 0, stopped: 0 };
  const port: OpencodePort = {
    startServer: async () => {
      calls.started += 1;
      return { url: 'http://fake' };
    },
    stopServer: () => {
      calls.stopped += 1;
    },
    createSession: async () => 'ses_fake',
    subscribeEvents: async function* () {
      yield assistantMsg;
      yield idleFor('ses_fake');
    },
    prompt: async () => assistantMsg.properties.info,
    ...over,
  };
  return { port, calls };
};

describe('runSession', () => {
  it('rolls streamed assistant events into a typed Usage', async () => {
    const { port } = makeFake();
    const usage = await Effect.runPromise(
      Effect.scoped(
        runSession(port, { dir: '/tmp/w', model: 'openai/gpt-5.4-mini', prompt: 'go' }),
      ),
    );
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
    assert.strictEqual(usage.model, 'openai/gpt-5.4-mini');
  });

  it('starts then releases the server exactly once on success', async () => {
    const { port, calls } = makeFake();
    await Effect.runPromise(
      Effect.scoped(runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' })),
    );
    assert.strictEqual(calls.started, 1);
    assert.strictEqual(calls.stopped, 1);
  });

  it('still releases the server when a session step fails (finalizer on failure)', async () => {
    const { port, calls } = makeFake({
      createSession: () => Promise.reject(new Error('boom')),
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' })),
    );
    assert.strictEqual(Exit.isFailure(exit), true);
    assert.strictEqual(calls.started, 1);
    assert.strictEqual(calls.stopped, 1);
  });

  it('surfaces a typed OpencodeFailed (tagged) when the server cannot start', async () => {
    const { port } = makeFake({ startServer: () => Promise.reject(new Error('no port')) });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' })),
    );
    assert.strictEqual(
      Exit.isFailure(exit) &&
        exit.cause._tag === 'Fail' &&
        exit.cause.error instanceof OpencodeFailed,
      true,
    );
  });
});
