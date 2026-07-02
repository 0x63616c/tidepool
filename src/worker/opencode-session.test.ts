import { assert, describe, it } from '@effect/vitest';
import { Cause, Effect, Exit, Logger } from 'effect';
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
  describeEvent,
  diffMessages,
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
    listMessages: async () => [],
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

  it('renders the real reason (not the generic "An error has occurred") through Cause.pretty, since that is the only place worker errors are logged', () => {
    const cause = Cause.fail(new OpencodeFailed({ op: 'server', reason: 'no port available' }));
    const rendered = Cause.pretty(cause);
    assert.strictEqual(rendered.includes('no port available'), true);
    assert.strictEqual(rendered.includes('An error has occurred'), false);
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

  it('ends on the prompt resolving even when session.idle never arrives (in-cluster SSE delivers only heartbeats)', async () => {
    // In-cluster, the SSE subscription emits only server.connected/heartbeat —
    // never a session.idle, and the stream never ends. The old code waited on
    // that idle event with a 2-minute fallback, so every prod session sat idle
    // for ~2 minutes after the work was already done. runSession must end when
    // the prompt resolves, not on an idle signal that in-cluster never comes.
    const { port } = makeFake({
      subscribeEvents: async function* () {
        yield { type: 'server.heartbeat' };
        // Stream stays open with no further events — exactly like in-cluster.
        await new Promise<never>(() => {});
      },
    });
    const { text } = await Effect.runPromise(
      Effect.scoped(runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' })),
    );
    assert.strictEqual(text, 'VERDICT: APPROVE');
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
      // A real prompt takes minutes; the collector drains and logs the event
      // stream while it runs. Delay so those log lines land before runSession
      // interrupts the collector on turn completion.
      prompt: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { info: assistantMsg.properties.info, text: 'VERDICT: APPROVE' };
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

/**
 * Ticket D — the prod blocker. Real opencode sessions run 6-9 minutes; the
 * old 8-min hard timeout killed them mid-work. 60 minutes gives real headroom.
 */
describe('DEFAULT_SESSION_TIMEOUT_MS', () => {
  it('is 60 minutes (was 8 — too short for real ~6-9 min sessions)', () => {
    assert.strictEqual(DEFAULT_SESSION_TIMEOUT_MS, 60 * 60 * 1000);
  });
});

/** More review visibility (tckt_fxtlog): tighten the progress poll from 3s to 1s. */
describe('DEFAULT_POLL_INTERVAL_MS', () => {
  it('is 1 second (was 3 — user wants tighter live-review visibility)', () => {
    assert.strictEqual(DEFAULT_POLL_INTERVAL_MS, 1000);
  });
});

/**
 * Ticket E — worker observability lie. In-cluster, `client.event.subscribe`
 * delivers only `server.connected`/`server.heartbeat` (proven by in-cluster
 * repro) — zero session/tool events — so `collectEvents`'s SSE-based logging
 * goes silent for the whole session. `diffMessages` is the pure reducer behind
 * a poll-based replacement: given the part-id -> last-logged-signature map and
 * the latest full `GET /session/:id/message` snapshot, it returns structured
 * transcript entries only for parts that are new or whose status changed, so
 * a poller built on it never re-logs an unchanged part.
 */
describe('diffMessages', () => {
  const toolPart = (
    id: string,
    tool: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    type: 'tool',
    tool,
    state: { status, ...extra },
  });
  const messages = (r: ReturnType<typeof diffMessages>) => r.entries.map((e) => e.message);

  it('emits no entries for an empty snapshot', () => {
    const { entries, seen } = diffMessages(new Map(), []);
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(seen.size, 0);
  });

  it('emits one entry for a brand-new part', () => {
    const snapshot = [{ info: {}, parts: [toolPart('p1', 'bash', 'running')] }];
    const result = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(messages(result), ['tool bash running']);
    assert.strictEqual(result.seen.get('p1'), 'tool:running:0');
  });

  it('re-logs a part whose status changed, plus a genuinely new part, in one pass', () => {
    const seen1 = new Map([['p1', 'tool:running:0']]);
    const snapshot = [
      { info: {}, parts: [toolPart('p1', 'bash', 'completed', { title: 'ls' })] },
      { info: {}, parts: [toolPart('p2', 'write', 'running')] },
    ];
    const result = diffMessages(seen1, snapshot);
    assert.deepStrictEqual(messages(result), ['tool bash completed — ls', 'tool write running']);
    assert.strictEqual(result.seen.get('p1'), 'tool:completed:0');
    assert.strictEqual(result.seen.get('p2'), 'tool:running:0');
  });

  it('does not re-log a part whose status is unchanged from the last poll', () => {
    const snapshot = [{ info: {}, parts: [toolPart('p1', 'bash', 'completed', { title: 'ls' })] }];
    const seen1 = new Map([['p1', 'tool:completed:0']]);
    const { entries } = diffMessages(seen1, snapshot);
    assert.deepStrictEqual(entries, []);
  });

  it('is total over malformed/unknown input — never throws', () => {
    assert.doesNotThrow(() => diffMessages(new Map(), [null, 'nope', {}, { parts: 'nope' }]));
    assert.deepStrictEqual(
      diffMessages(new Map(), [null, 'nope', {}, { parts: 'nope' }]).entries,
      [],
    );
  });

  it('captures the message role (user/assistant) as an annotation on every entry from that message', () => {
    const snapshot = [{ info: { role: 'assistant' }, parts: [toolPart('p1', 'bash', 'running')] }];
    const { entries } = diffMessages(new Map(), snapshot);
    assert.strictEqual(entries[0]?.annotations.role, 'assistant');
  });

  it('omits the role annotation when the message carries none', () => {
    const snapshot = [{ info: {}, parts: [toolPart('p1', 'bash', 'running')] }];
    const { entries } = diffMessages(new Map(), snapshot);
    assert.strictEqual('role' in (entries[0]?.annotations ?? {}), false);
  });

  it('tags the status line entry kind=tool-call and carries the tool input for every tool, not just edit tools', () => {
    const snapshot = [
      { info: {}, parts: [toolPart('p1', 'bash', 'running', { input: { command: 'ls -la' } })] },
    ];
    const { entries } = diffMessages(new Map(), snapshot);
    const call = entries.find((e) => e.annotations.kind === 'tool-call');
    assert.strictEqual(call?.annotations.tool, 'bash');
    assert.deepStrictEqual(call?.annotations.input, { command: 'ls -la' });
  });

  it('logs the tool input for a non-edit tool with different args (grep pattern)', () => {
    const snapshot = [
      {
        info: {},
        parts: [toolPart('p1', 'grep', 'running', { input: { pattern: 'TODO', path: 'src' } })],
      },
    ];
    const { entries } = diffMessages(new Map(), snapshot);
    const call = entries.find((e) => e.annotations.kind === 'tool-call');
    assert.deepStrictEqual(call?.annotations.input, { pattern: 'TODO', path: 'src' });
  });

  it('emits a tool-result entry carrying the output once a tool call completes', () => {
    const snapshot = [
      { info: {}, parts: [toolPart('p1', 'bash', 'completed', { output: 'file1\nfile2' })] },
    ];
    const { entries } = diffMessages(new Map(), snapshot);
    const result = entries.find((e) => e.annotations.kind === 'tool-result');
    assert.ok(result !== undefined);
    assert.strictEqual(result?.annotations.output, 'file1\nfile2');
    assert.strictEqual(result?.annotations.tool, 'bash');
  });

  it('emits a tool-result entry carrying the error message when a tool call fails', () => {
    const snapshot = [{ info: {}, parts: [toolPart('p1', 'bash', 'error', { error: 'exit 1' })] }];
    const { entries } = diffMessages(new Map(), snapshot);
    const result = entries.find((e) => e.annotations.kind === 'tool-result');
    assert.strictEqual(result?.annotations.output, 'exit 1');
  });

  it('does not emit a tool-result entry while the tool is still running', () => {
    const snapshot = [
      { info: {}, parts: [toolPart('p1', 'bash', 'running', { output: 'partial' })] },
    ];
    const { entries } = diffMessages(new Map(), snapshot);
    assert.strictEqual(
      entries.some((e) => e.annotations.kind === 'tool-result'),
      false,
    );
  });

  it('re-fires a completed tool part when its output arrives on a LATER poll, status unchanged (the dropped-output bug)', () => {
    const first = diffMessages(new Map(), [
      { info: {}, parts: [toolPart('p1', 'bash', 'completed')] },
    ]);
    assert.strictEqual(
      first.entries.some((e) => e.annotations.kind === 'tool-result'),
      false,
    );
    const second = diffMessages(first.seen, [
      { info: {}, parts: [toolPart('p1', 'bash', 'completed', { output: 'total 0' })] },
    ]);
    const result = second.entries.find((e) => e.annotations.kind === 'tool-result');
    assert.ok(result !== undefined);
    assert.strictEqual(result?.annotations.output, 'total 0');
  });

  it('still dedups: does not re-fire when polled again with the same completed+output', () => {
    const first = diffMessages(new Map(), [
      { info: {}, parts: [toolPart('p1', 'bash', 'completed', { output: 'total 0' })] },
    ]);
    const second = diffMessages(first.seen, [
      { info: {}, parts: [toolPart('p1', 'bash', 'completed', { output: 'total 0' })] },
    ]);
    assert.deepStrictEqual(second.entries, []);
  });

  it('renders a step-start part as a one-shot boundary line', () => {
    const snapshot = [{ info: {}, parts: [{ id: 's1', type: 'step-start' }] }];
    const { entries, seen } = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(
      entries.map((e) => [e.message, e.annotations.kind]),
      [['step start', 'step']],
    );
    assert.strictEqual(seen.get('s1'), 'step-start:');
  });

  it('renders a step-finish part as a one-shot boundary line', () => {
    const snapshot = [{ info: {}, parts: [{ id: 's1', type: 'step-finish' }] }];
    const { entries } = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(
      entries.map((e) => [e.message, e.annotations.kind]),
      [['step finish', 'step']],
    );
  });

  it('renders a file part with its path', () => {
    const snapshot = [{ info: {}, parts: [{ id: 'f1', type: 'file', filename: 'src/x.ts' }] }];
    const { entries } = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(
      entries.map((e) => [e.message, e.annotations.kind, e.annotations.path]),
      [['file src/x.ts', 'file', 'src/x.ts']],
    );
  });

  it('does not render snapshot/agent/session-patch parts (opencode-internal bookkeeping), but still marks them seen', () => {
    const snapshot = [
      {
        info: {},
        parts: [
          { id: 'x1', type: 'snapshot' },
          { id: 'x2', type: 'agent' },
          { id: 'x3', type: 'patch' },
        ],
      },
    ];
    const { entries, seen } = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(seen.size, 3);
  });
});

/** tckt_fxtlog: stream the assistant's actual reply/reasoning text, delta-only per poll. */
describe('diffMessages — text/reasoning deltas', () => {
  const textPart = (id: string, type: 'text' | 'reasoning', text: string) => ({ id, type, text });
  const messages = (r: ReturnType<typeof diffMessages>) => r.entries.map((e) => e.message);

  it('emits the full text as the delta the first time a text part appears', () => {
    const snapshot = [{ info: {}, parts: [textPart('t1', 'text', 'Hello')] }];
    const result = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(messages(result), ['[text] Hello']);
    assert.strictEqual(result.entries[0]?.annotations.kind, 'text');
    assert.strictEqual(result.seen.get('t1'), 'text:5');
  });

  it('emits only the newly-appended substring on the next poll, not the whole text', () => {
    const seen1 = new Map([['t1', 'text:5']]);
    const snapshot = [{ info: {}, parts: [textPart('t1', 'text', 'Hello world')] }];
    const result = diffMessages(seen1, snapshot);
    assert.deepStrictEqual(messages(result), ['[text]  world']);
    assert.strictEqual(result.seen.get('t1'), 'text:11');
  });

  it('does not re-log a text part whose length is unchanged', () => {
    const seen1 = new Map([['t1', 'text:11']]);
    const snapshot = [{ info: {}, parts: [textPart('t1', 'text', 'Hello world')] }];
    const { entries } = diffMessages(seen1, snapshot);
    assert.deepStrictEqual(entries, []);
  });

  it('labels reasoning parts distinctly from text parts', () => {
    const snapshot = [{ info: {}, parts: [textPart('r1', 'reasoning', 'thinking...')] }];
    const result = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(messages(result), ['[reasoning] thinking...']);
    assert.strictEqual(result.entries[0]?.annotations.kind, 'reasoning');
    assert.strictEqual(result.seen.get('r1'), 'reasoning:11');
  });

  it('emits only the reasoning delta across polls, same as text', () => {
    const seen1 = new Map([['r1', 'reasoning:11']]);
    const snapshot = [{ info: {}, parts: [textPart('r1', 'reasoning', 'thinking... more')] }];
    const result = diffMessages(seen1, snapshot);
    assert.deepStrictEqual(messages(result), ['[reasoning]  more']);
  });
});

/** tckt_fxtlog: log the real diff for file-editing tool calls, not just "edited <file>". */
describe('diffMessages — file edit diff logging', () => {
  const toolPart = (
    id: string,
    tool: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    type: 'tool',
    tool,
    state: { status, ...extra },
  });
  const messages = (r: ReturnType<typeof diffMessages>) => r.entries.map((e) => e.message);

  it('logs the patch content once an apply_patch tool call completes', () => {
    const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new';
    const snapshot = [
      { info: {}, parts: [toolPart('e1', 'apply_patch', 'completed', { input: { patch } })] },
    ];
    const result = diffMessages(new Map(), snapshot);
    const lines = messages(result);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], 'tool apply_patch completed');
    assert.ok(lines[1]?.startsWith('[diff] apply_patch:'));
    assert.ok(lines[1]?.includes(patch));
    const diff = result.entries.find((e) => e.annotations.kind === 'file-diff');
    assert.strictEqual(diff?.annotations.patch, patch);
    assert.strictEqual(diff?.annotations.tool, 'apply_patch');
  });

  it('falls back to before/after content when there is no unified patch', () => {
    const snapshot = [
      {
        info: {},
        parts: [
          toolPart('e2', 'edit', 'completed', {
            input: { oldString: 'const a = 1;', newString: 'const a = 2;' },
          }),
        ],
      },
    ];
    const result = diffMessages(new Map(), snapshot);
    const lines = messages(result);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1]?.includes('const a = 1;'));
    assert.ok(lines[1]?.includes('const a = 2;'));
    const diff = result.entries.find((e) => e.annotations.kind === 'file-diff');
    assert.ok(String(diff?.annotations.patch).includes('const a = 1;'));
  });

  it('does not log a diff while the edit tool is still running', () => {
    const snapshot = [{ info: {}, parts: [toolPart('e1', 'apply_patch', 'running')] }];
    const result = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(messages(result), ['tool apply_patch running']);
  });

  it('does not log a diff for a non-editing tool', () => {
    const snapshot = [
      { info: {}, parts: [toolPart('b1', 'bash', 'completed', { input: { patch: 'nope' } })] },
    ];
    const result = diffMessages(new Map(), snapshot);
    assert.deepStrictEqual(messages(result), ['tool bash completed']);
  });
});

describe('runSession progress polling (Ticket E)', () => {
  it('polls listMessages on an interval and logs new/changed parts, skipping unchanged ones', async () => {
    const lines: string[] = [];
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) =>
        lines.push(Array.isArray(message) ? message.join(' ') : String(message)),
      ),
    );
    const snapshots: readonly unknown[][] = [
      [],
      [
        {
          info: {},
          parts: [{ id: 'p1', type: 'tool', tool: 'bash', state: { status: 'running' } }],
        },
      ],
      [
        {
          info: {},
          parts: [
            { id: 'p1', type: 'tool', tool: 'bash', state: { status: 'completed', title: 'ls' } },
          ],
        },
        {
          info: {},
          parts: [{ id: 'p2', type: 'tool', tool: 'write', state: { status: 'running' } }],
        },
      ],
    ];
    let call = 0;
    const { port } = makeFake({
      listMessages: async () => snapshots[Math.min(call++, snapshots.length - 1)] ?? [],
      prompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { info: assistantMsg.properties.info, text: 'VERDICT: APPROVE' };
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        runSession(port, { dir: '/tmp/w', model: 'm', prompt: 'go' }, undefined, 4),
      ).pipe(Effect.provide(capture)),
    );
    const toolLines = lines.filter((l) => l.startsWith('tool '));
    assert.deepStrictEqual(toolLines, [
      'tool bash running',
      'tool bash completed — ls',
      'tool write running',
    ]);
  });
});
