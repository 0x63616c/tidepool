import { Data, Deferred, Duration, Effect } from 'effect';
import type { Usage } from '../domain.ts';
import { parseUsage } from './usage.ts';

/**
 * The opencode session seam. `runSession` is a deep module: it owns the embedded
 * server's lifecycle and the event-collector fiber, and exposes one narrow front
 * — given a dir/model/prompt, drive a full agent session and return its `Usage`
 * plus the assistant's reply text (the review agent grades on that text).
 * The opencode SDK's types stop at the `OpencodePort`; above it everything is
 * plain records + Effect, so the orchestration is testable against a fake port
 * (no server, no network), exactly like `forge`'s `GithubRest`.
 */

/**
 * Hard ceiling for one opencode session. A hung session (server stuck, files
 * created but `session.idle` never arrives, or `prompt` never resolving) would
 * otherwise pin the runner — and, upstream, the reconciler's settle — forever.
 * The default is generous (real sessions finish in minutes); a worker exceeding
 * it is treated as stuck: the scope releases (killing the server) and the run
 * fails with a typed `OpencodeFailed`, so the box is torn down and retried.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 8 * 60 * 1000;

/** What one driven session yields: token accounting plus the assistant's reply. */
export interface SessionOutcome {
  readonly usage: Usage;
  readonly text: string;
}

/** The assistant's reply to one prompt: its message info plus the rendered text. */
export interface PromptReply {
  readonly info: unknown;
  readonly text: string;
}

/** Opaque handle to a started opencode server (just its base URL). */
export interface OpencodeServerHandle {
  readonly url: string;
}

/** Everything `runSession` needs to send one prompt. */
export interface PromptParams {
  readonly sessionId: string;
  readonly dir: string;
  readonly model: string;
  readonly prompt: string;
}

/**
 * The narrow set of opencode operations the runner needs. The SDK's wire types
 * stop here; the port speaks plain records + an event async-iterable, so the
 * session orchestration above it is a deep module testable with a fake.
 */
export interface OpencodePort {
  /** Spawn the embedded server; resolves once it is listening. */
  readonly startServer: () => Promise<OpencodeServerHandle>;
  /** Tear the server (and its child process) down — the release half. */
  readonly stopServer: (server: OpencodeServerHandle) => void | Promise<void>;
  /** Create a session, returning its id. */
  readonly createSession: (server: OpencodeServerHandle, dir: string) => Promise<string>;
  /** Subscribe to the server's event stream (ends when the server closes). */
  readonly subscribeEvents: (server: OpencodeServerHandle, dir: string) => AsyncIterable<unknown>;
  /** Send a prompt; resolves with the final assistant message info + reply text. */
  readonly prompt: (server: OpencodeServerHandle, params: PromptParams) => Promise<PromptReply>;
}

/** A step of the opencode session failed (server, session, or prompt). */
export class OpencodeFailed extends Data.TaggedError('OpencodeFailed')<{
  readonly op: string;
  readonly reason: string;
}> {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Did this event signal our session went idle (the agent finished its turn)? */
const isSessionIdle = (ev: unknown, sessionId: string): boolean =>
  isRecord(ev) &&
  ev.type === 'session.idle' &&
  isRecord(ev.properties) &&
  ev.properties.sessionID === sessionId;

const fail = (op: string) => (e: unknown) => new OpencodeFailed({ op, reason: String(e) });

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Reduce one opencode SSE event to a compact one-line summary, or `null` to
 * skip it. This is the whole observability decision: which of opencode's 30+
 * event types are worth a log line while the agent works, and what each says.
 * We surface the high-signal ones — tool calls (pending→running→completed/error),
 * todo progress, file edits, commands, retries, session errors, and permission
 * prompts (a common hang cause) — and drop the noisy ones (per-token text and
 * reasoning deltas, lsp chatter, idle — the latter is already logged as session
 * completion). Pure and total over `unknown` so it's trivially testable and can
 * never throw inside the collector.
 */
export const describeEvent = (ev: unknown): string | null => {
  if (!isRecord(ev) || typeof ev.type !== 'string') return null;
  const p = isRecord(ev.properties) ? ev.properties : {};
  switch (ev.type) {
    case 'message.part.updated': {
      const part = isRecord(p.part) ? p.part : null;
      if (!part || part.type !== 'tool') return null; // skip text/reasoning deltas
      const tool = str(part.tool) ?? 'tool';
      const state = isRecord(part.state) ? part.state : {};
      const status = str(state.status) ?? 'pending';
      if (status === 'error') return `tool ${tool} error: ${str(state.error) ?? 'unknown error'}`;
      const title = str(state.title);
      return `tool ${tool} ${status}${title ? ` — ${title}` : ''}`;
    }
    case 'todo.updated': {
      const todos = Array.isArray(p.todos) ? p.todos : [];
      const by = (s: string) => todos.filter((t) => isRecord(t) && t.status === s).length;
      return `todos ${by('completed')}/${todos.length} done (${by('in_progress')} in progress)`;
    }
    case 'file.edited': {
      const file = str(p.file);
      return file ? `edited ${file}` : null;
    }
    case 'command.executed': {
      const name = str(p.name);
      return name ? `command ${name}` : null;
    }
    case 'session.status': {
      const s = isRecord(p.status) ? p.status : {};
      if (s.type === 'retry') {
        const attempt = typeof s.attempt === 'number' ? s.attempt : '?';
        const msg = str(s.message);
        return `status retry (attempt ${attempt})${msg ? `: ${msg}` : ''}`;
      }
      return str(s.type) ? `status ${s.type}` : null;
    }
    case 'session.error': {
      const err = isRecord(p.error) ? p.error : null;
      if (!err) return 'session error';
      const name = str(err.name) ?? 'error';
      const message = isRecord(err.data) ? str(err.data.message) : null;
      return `session error: ${name}${message ? `: ${message}` : ''}`;
    }
    case 'permission.updated':
      return `permission requested: ${str(p.title) ?? '(untitled)'}`;
    default:
      return null;
  }
};

/**
 * Forked collector: drain the event stream into `sink` until our session goes
 * idle (or the stream ends), then signal `done`. Stream errors are swallowed —
 * the final assistant info is appended by `runSession` regardless, so a dropped
 * subscription never loses the proof-of-work tokens. Runs under `forkScoped`, so
 * if the session fails before idle the fiber is interrupted at scope close.
 */
const collectEvents = (
  port: OpencodePort,
  server: OpencodeServerHandle,
  dir: string,
  sessionId: string,
  sink: Array<unknown>,
  done: Deferred.Deferred<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Pull the SSE stream one event at a time so each can be logged through the
    // app logger (→ stderr → `kubectl logs`), turning the previously-silent
    // agent session into a live play-by-play. The sink still accumulates every
    // raw event for usage parsing; logging is additive.
    const iterator = port.subscribeEvents(server, dir)[Symbol.asyncIterator]();
    while (true) {
      const next = yield* Effect.tryPromise(() => iterator.next());
      if (next.done) break;
      const ev = next.value;
      sink.push(ev);
      const line = describeEvent(ev);
      if (line !== null) yield* Effect.logInfo(line);
      if (isSessionIdle(ev, sessionId)) break;
    }
  }).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(done, undefined)));

/**
 * Drive one agent session end-to-end, rolling the events into a `Usage` and
 * surfacing the assistant's reply text. The server is owned by `acquireRelease`
 * so its finalizer (stopServer) runs on success AND failure; the collector runs
 * in a `forkScoped` fiber tied to the same scope. We send the prompt, wait for
 * idle (bounded by a short timeout so a dropped idle event after a completed
 * prompt can't hang the runner), then append the prompt's final assistant info
 * before parsing — guaranteeing non-zero tokens even if the stream dropped the
 * cumulative updates.
 *
 * The whole session is bounded by `timeoutMs` (FIX 2): a genuinely stuck server
 * — where `prompt` itself never resolves — would slip past the idle wait, so the
 * outer `timeoutFail` is the hard backstop. On timeout the scope releases
 * (stopServer aborts the server) and we fail with a typed `OpencodeFailed`,
 * which maps to `AgentFailed` upstream so the box is torn down and retried.
 */
export const runSession = (
  port: OpencodePort,
  params: { readonly dir: string; readonly model: string; readonly prompt: string },
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
): Effect.Effect<SessionOutcome, OpencodeFailed, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => port.startServer(), catch: fail('startServer') }),
        (s) => Effect.promise(async () => port.stopServer(s)),
      );
      yield* Effect.logInfo('opencode server started');

      const sessionId = yield* Effect.tryPromise({
        try: () => port.createSession(server, params.dir),
        catch: fail('createSession'),
      });

      const events: Array<unknown> = [];
      const done = yield* Deferred.make<void>();
      yield* Effect.forkScoped(collectEvents(port, server, params.dir, sessionId, events, done));

      const { info, text } = yield* Effect.tryPromise({
        try: () =>
          port.prompt(server, {
            sessionId,
            dir: params.dir,
            model: params.model,
            prompt: params.prompt,
          }),
        catch: fail('prompt'),
      });

      // The prompt has resolved, so idle is imminent; cap the wait well under the
      // hard timeout so a dropped idle event still yields a successful run.
      yield* Deferred.await(done).pipe(Effect.timeout('2 minutes'), Effect.ignore);
      events.push({ type: 'message.updated', properties: { info } });
      yield* Effect.logInfo('opencode session complete');
      return { usage: parseUsage(events), text };
    }),
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new OpencodeFailed({
          op: 'session',
          reason: `opencode session exceeded ${timeoutMs}ms hard timeout`,
        }),
    }),
  );
