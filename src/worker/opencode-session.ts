import { Data, Duration, Effect, Fiber } from 'effect';
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
 * 60 minutes (was 8 — real gpt-5.5 sessions doing actual repo work run ~6-9
 * min, so the old timeout was killing production tickets mid-work); a worker
 * exceeding it is treated as stuck: the scope releases (killing the server)
 * and the run fails with a typed `OpencodeFailed`, so the box is torn down and
 * retried. Must stay under the Job's `activeDeadlineSeconds` (see
 * `runtime.ts#workerDeadlineSeconds`, 65 min) or k8s kills the pod first.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/** How often the progress poller re-fetches `listMessages` (see `pollProgress`). */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

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
  /**
   * Snapshot every message + part for a session (`GET /session/:id/message`).
   * In-cluster, `subscribeEvents`' SSE delivers only `server.connected`/
   * `server.heartbeat` — zero session/tool events — so `pollProgress` polls
   * this instead to keep the worker log from going silent mid-session.
   */
  readonly listMessages: (
    server: OpencodeServerHandle,
    sessionId: string,
  ) => Promise<readonly unknown[]>;
}

/** A step of the opencode session failed (server, session, or prompt). */
export class OpencodeFailed extends Data.TaggedError('OpencodeFailed')<{
  readonly op: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.op}: ${this.reason}`;
  }
}

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
 * Reduce a tool part — shared shape between `message.part.updated`'s `part`
 * (from the SSE stream) and a part inside a `listMessages` snapshot (from the
 * poller) — to a compact summary, or `null` if it isn't a tool part. Pure and
 * total so both `describeEvent` and `diffMessages` can lean on it.
 */
const describeToolPart = (part: Record<string, unknown>): string | null => {
  if (part.type !== 'tool') return null;
  const tool = str(part.tool) ?? 'tool';
  const state = isRecord(part.state) ? part.state : {};
  const status = str(state.status) ?? 'pending';
  if (status === 'error') return `tool ${tool} error: ${str(state.error) ?? 'unknown error'}`;
  const title = str(state.title);
  return `tool ${tool} ${status}${title ? ` — ${title}` : ''}`;
};

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
      return part ? describeToolPart(part) : null; // skips text/reasoning deltas too
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
 * Signature that changes exactly when a part is "worth re-logging" — new id,
 * (for tool parts) a status transition, or (for text/reasoning parts) growth
 * in the streamed text's length. Encoding the length in the signature itself
 * (`text:42`) lets `diffMessages` detect growth without a second map.
 */
const partSignature = (part: Record<string, unknown>): string => {
  if (part.type === 'tool') {
    const status = isRecord(part.state) ? str(part.state.status) : null;
    return `tool:${status ?? ''}`;
  }
  if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
    return `${part.type}:${part.text.length}`;
  }
  return `${String(part.type)}:`;
};

/** Tool names that write file content — worth logging the actual diff/patch for, not just a title. */
const EDIT_TOOLS = new Set(['edit', 'apply_patch', 'write', 'patch']);

/**
 * Best-effort diff/patch extraction for a completed file-editing tool call.
 * Prefers a ready-made unified diff (`input.patch`/`input.diff`, e.g. the
 * `apply_patch` tool's shape seen in production); falls back to an
 * old/new-string pair, then raw written content. `null` if the tool isn't an
 * editing tool, hasn't completed yet, or carries none of these shapes.
 */
const describeToolDiff = (part: Record<string, unknown>): string | null => {
  if (part.type !== 'tool') return null;
  const tool = str(part.tool);
  if (!tool || !EDIT_TOOLS.has(tool)) return null;
  const state = isRecord(part.state) ? part.state : {};
  if (str(state.status) !== 'completed') return null;
  const input = isRecord(state.input) ? state.input : {};
  const patch = str(input.patch) ?? str(input.diff);
  if (patch) return `[diff] ${tool}:\n${patch}`;
  const oldString = str(input.oldString);
  const newString = str(input.newString);
  if (oldString !== null || newString !== null) {
    return `[diff] ${tool}:\n--- before\n${oldString ?? ''}\n+++ after\n${newString ?? ''}`;
  }
  const content = str(input.content);
  if (content !== null) return `[diff] ${tool} write:\n${content}`;
  return null;
};

/** Prefix for a streamed text/reasoning delta line, keyed by part type. */
const TEXT_DELTA_LABELS: Record<string, string> = { text: '[text]', reasoning: '[reasoning]' };

/**
 * New substring of a growing text/reasoning part since the last poll, so only
 * the delta is logged rather than the whole accumulated text each time. The
 * previously-logged length is recovered from `prevSig` (`"text:<len>"`), the
 * same signature `partSignature` just produced for this part.
 */
const describeTextDelta = (
  part: Record<string, unknown>,
  prevSig: string | undefined,
): string | null => {
  const label = TEXT_DELTA_LABELS[String(part.type)];
  if (!label || typeof part.text !== 'string') return null;
  const prevLen = prevSig ? Number(prevSig.slice(prevSig.indexOf(':') + 1)) || 0 : 0;
  const delta = part.text.slice(Math.max(0, prevLen));
  return delta.length > 0 ? `${label} ${delta}` : null;
};

/**
 * Pure diff step behind the poll-based progress logger (Ticket E). Given the
 * part-id -> last-logged-signature map from the previous poll and the latest
 * full `listMessages` snapshot (`Array<{info, parts}>`), returns the log lines
 * for parts that are new or whose signature changed, plus the updated map —
 * so a part already logged at its current status/text-length is never
 * re-logged. A single changed part can emit multiple lines (e.g. a completed
 * edit tool logs both its status summary and its diff). Total over `unknown`
 * — a malformed message or part is skipped, never thrown, so `pollProgress`'s
 * loop can never die on a shape it didn't expect.
 */
export const diffMessages = (
  seen: ReadonlyMap<string, string>,
  messages: readonly unknown[],
): { readonly lines: readonly string[]; readonly seen: ReadonlyMap<string, string> } => {
  const next = new Map(seen);
  const lines: string[] = [];
  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.parts)) continue;
    for (const part of msg.parts) {
      if (!isRecord(part) || typeof part.id !== 'string') continue;
      const prevSig = seen.get(part.id);
      const sig = partSignature(part);
      if (prevSig === sig) continue;
      next.set(part.id, sig);
      const toolLine = describeToolPart(part);
      if (toolLine !== null) lines.push(toolLine);
      const diffLine = describeToolDiff(part);
      if (diffLine !== null) lines.push(diffLine);
      const textLine = describeTextDelta(part, prevSig);
      if (textLine !== null) lines.push(textLine);
    }
  }
  return { lines, seen: next };
};

/**
 * Forked poller: since in-cluster the SSE subscription delivers only
 * `server.connected`/`server.heartbeat` (proven by in-cluster repro — zero
 * session/tool events), it cannot be relied on for progress logging. This
 * polls the server's `listMessages` snapshot on `pollIntervalMs`, diffs it via
 * the pure `diffMessages`, and logs one line per part that's new or changed,
 * plus a running message/part/elapsed-time summary whenever something changed.
 * Runs until the enclosing scope closes (session end or hard timeout) via
 * `forkScoped`; a failed poll is swallowed so a flaky GET never kills the
 * fiber or the session it's merely observing.
 */
const pollProgress = (
  port: OpencodePort,
  server: OpencodeServerHandle,
  sessionId: string,
  pollIntervalMs: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    let seen: ReadonlyMap<string, string> = new Map();
    while (true) {
      yield* Effect.sleep(Duration.millis(pollIntervalMs));
      const messages = yield* Effect.tryPromise(() => port.listMessages(server, sessionId)).pipe(
        Effect.orElseSucceed((): readonly unknown[] => []),
      );
      const diffed = diffMessages(seen, messages);
      seen = diffed.seen;
      for (const line of diffed.lines) yield* Effect.logInfo(line);
      if (diffed.lines.length > 0) {
        const partCount = messages.reduce(
          (n: number, m) => n + (isRecord(m) && Array.isArray(m.parts) ? m.parts.length : 0),
          0,
        );
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        yield* Effect.logInfo(
          `progress: ${messages.length} messages, ${partCount} parts, ${elapsedSec}s elapsed`,
        );
      }
    }
  }).pipe(Effect.ignore);

/**
 * Forked collector: drain the event stream into `sink`, logging each interesting
 * event as it arrives. It exits on `session.idle` or end-of-stream, but is not
 * relied on to do so — `runSession` interrupts it once the prompt resolves (the
 * authoritative turn-complete signal). Stream errors are swallowed — the final
 * assistant info is appended by `runSession` regardless, so a dropped
 * subscription never loses the proof-of-work tokens. Runs under `forkScoped`, so
 * it is also interrupted at scope close if the session fails.
 */
const collectEvents = (
  port: OpencodePort,
  server: OpencodeServerHandle,
  dir: string,
  sessionId: string,
  sink: Array<unknown>,
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
  }).pipe(Effect.ignore);

/**
 * Drive one agent session end-to-end, rolling the events into a `Usage` and
 * surfacing the assistant's reply text. The server is owned by `acquireRelease`
 * so its finalizer (stopServer) runs on success AND failure; the collector runs
 * in a `forkScoped` fiber tied to the same scope. We send the prompt, and once
 * it resolves (turn complete) we interrupt the collector rather than waiting on
 * a `session.idle` event — in-cluster the SSE stream delivers only heartbeats,
 * so awaiting idle stalled every run for the full fallback timeout after the
 * work was already done. We then append the prompt's final assistant info before
 * parsing — guaranteeing non-zero tokens even if the stream dropped the
 * cumulative updates.
 *
 * The whole session is bounded by `timeoutMs` (FIX 2): a genuinely stuck server
 * — where `prompt` itself never resolves — never reaches the interrupt, so the
 * outer `timeoutFail` is the hard backstop. On timeout the scope releases
 * (stopServer aborts the server) and we fail with a typed `OpencodeFailed`,
 * which maps to `AgentFailed` upstream so the box is torn down and retried.
 */
export const runSession = (
  port: OpencodePort,
  params: { readonly dir: string; readonly model: string; readonly prompt: string },
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
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
      const collector = yield* Effect.forkScoped(
        collectEvents(port, server, params.dir, sessionId, events),
      );
      yield* Effect.forkScoped(pollProgress(port, server, sessionId, pollIntervalMs));

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

      // The prompt resolving is the authoritative "turn complete" signal, so the
      // work is done here. Stop the collector rather than waiting on a
      // `session.idle` event: in-cluster the SSE subscription delivers only
      // heartbeats (never idle, never end-of-stream), so awaiting idle stalled
      // every run for the full fallback timeout after the work had finished.
      // Every event that matters for usage/logging has already streamed in
      // (each message's final update lands as that message completes, well
      // before the turn ends), and the final assistant `info` is pushed below.
      yield* Fiber.interrupt(collector);
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
