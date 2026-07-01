import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Logger } from 'effect';
import {
  describeEvent,
  OpencodeFailed,
  type OpencodePort,
  runSession,
} from './opencode-session.ts';

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
    prompt: async () => ({ info: assistantMsg.properties.info, text: 'VERDICT: APPROVE' }),
    ...over,
  };
  return { port, calls };
};

describe('runSession', () => {
  it('rolls streamed assistant events into a typed Usage and surfaces the reply text', async () => {
    const { port } = makeFake();
    const { usage, text } = await Effect.runPromise(
      Effect.scoped(
        runSession(port, { dir: '/tmp/w', model: 'openai/gpt-5.4-mini', prompt: 'go' }),
      ),
    );
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
    assert.strictEqual(usage.model, 'openai/gpt-5.4-mini');
    assert.strictEqual(text, 'VERDICT: APPROVE');
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

  it('(FIX 2) fails OpencodeFailed and releases the server when the hard timeout elapses', async () => {
    // A stuck server: prompt never resolves (opencode serve hung). Without the
    // hard timeout this would pin the runner — and the reconciler's settle —
    // forever. With it, the scope releases (server torn down) and the run fails.
    const { port, calls } = makeFake({ prompt: () => new Promise(() => {}) });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' }, 30)),
    );
    assert.strictEqual(
      Exit.isFailure(exit) &&
        exit.cause._tag === 'Fail' &&
        exit.cause.error instanceof OpencodeFailed &&
        exit.cause.error.op === 'session',
      true,
    );
    // Scoped finalizer fired on timeout — the embedded server was torn down.
    assert.strictEqual(calls.stopped, 1);
  });

  it('logs a line per interesting opencode event as the session runs', async () => {
    // Observability: while the agent works, the collector must surface each
    // interesting event (tool calls, etc.) on the logger so `kubectl logs`
    // shows what the pod is doing instead of going silent until completion.
    const lines: string[] = [];
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) =>
        lines.push(Array.isArray(message) ? message.join(' ') : String(message)),
      ),
    );
    const toolEvent = {
      type: 'message.part.updated',
      properties: { part: { type: 'tool', tool: 'bash', state: { status: 'running' } } },
    };
    const { port } = makeFake({
      subscribeEvents: async function* () {
        yield toolEvent;
        yield idleFor('ses_fake');
      },
    });
    await Effect.runPromise(
      Effect.scoped(runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' })).pipe(
        Effect.provide(capture),
      ),
    );
    assert.strictEqual(lines.includes('tool bash running'), true);
  });
});

describe('describeEvent', () => {
  it('summarizes a running tool call', () => {
    assert.strictEqual(
      describeEvent({
        type: 'message.part.updated',
        properties: { part: { type: 'tool', tool: 'bash', state: { status: 'running' } } },
      }),
      'tool bash running',
    );
  });

  it('appends the human-readable title when present', () => {
    assert.strictEqual(
      describeEvent({
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', tool: 'bash', state: { status: 'running', title: 'ls -la' } },
        },
      }),
      'tool bash running — ls -la',
    );
  });

  it('includes the error message on a failed tool call', () => {
    assert.strictEqual(
      describeEvent({
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', tool: 'bash', state: { status: 'error', error: 'exit 1' } },
        },
      }),
      'tool bash error: exit 1',
    );
  });

  it('skips streaming text parts (too noisy to log per token)', () => {
    assert.strictEqual(
      describeEvent({
        type: 'message.part.updated',
        properties: { part: { type: 'text', text: 'hello' } },
      }),
      null,
    );
  });

  it('summarizes todo progress', () => {
    assert.strictEqual(
      describeEvent({
        type: 'todo.updated',
        properties: {
          todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }],
        },
      }),
      'todos 1/3 done (1 in progress)',
    );
  });

  it('reports an edited file', () => {
    assert.strictEqual(
      describeEvent({ type: 'file.edited', properties: { file: 'src/x.ts' } }),
      'edited src/x.ts',
    );
  });

  it('reports an executed command', () => {
    assert.strictEqual(
      describeEvent({ type: 'command.executed', properties: { name: 'build' } }),
      'command build',
    );
  });

  it('reports a retry status with the attempt number', () => {
    assert.strictEqual(
      describeEvent({
        type: 'session.status',
        properties: { status: { type: 'retry', attempt: 2, message: 'rate limited' } },
      }),
      'status retry (attempt 2): rate limited',
    );
  });

  it('reports a typed session error with its message', () => {
    assert.strictEqual(
      describeEvent({
        type: 'session.error',
        properties: { error: { name: 'ProviderAuthError', data: { message: 'bad key' } } },
      }),
      'session error: ProviderAuthError: bad key',
    );
  });

  it('reports a permission request (a hang cause worth seeing)', () => {
    assert.strictEqual(
      describeEvent({ type: 'permission.updated', properties: { title: 'run rm -rf /' } }),
      'permission requested: run rm -rf /',
    );
  });

  it('returns null for session.idle (redundant with the completion log)', () => {
    assert.strictEqual(describeEvent(idleFor('ses_fake')), null);
  });

  it('returns null for uninteresting or malformed events', () => {
    assert.strictEqual(describeEvent({ type: 'lsp.updated', properties: {} }), null);
    assert.strictEqual(describeEvent(null), null);
    assert.strictEqual(describeEvent('nope'), null);
    assert.strictEqual(describeEvent({}), null);
  });
});
