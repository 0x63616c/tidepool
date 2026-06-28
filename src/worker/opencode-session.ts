import { Data, Deferred, Effect } from 'effect';
import type { Usage } from '../domain.ts';
import { parseUsage } from './usage.ts';

/**
 * The opencode session seam. `runSession` is a deep module: it owns the embedded
 * server's lifecycle and the event-collector fiber, and exposes one narrow front
 * — given a dir/model/prompt, drive a full agent session and return a `Usage`.
 * The opencode SDK's types stop at the `OpencodePort`; above it everything is
 * plain records + Effect, so the orchestration is testable against a fake port
 * (no server, no network), exactly like `forge`'s `GithubRest`.
 */

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
  /** Send a prompt; resolves with the final assistant message info. */
  readonly prompt: (server: OpencodeServerHandle, params: PromptParams) => Promise<unknown>;
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
  Effect.tryPromise(async () => {
    for await (const ev of port.subscribeEvents(server, dir)) {
      sink.push(ev);
      if (isSessionIdle(ev, sessionId)) break;
    }
  }).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(done, undefined)));

/**
 * Drive one agent session end-to-end and roll the events into a `Usage`. The
 * server is owned by `acquireRelease` so its finalizer (stopServer) runs on
 * success AND failure; the collector runs in a `forkScoped` fiber tied to the
 * same scope. We send the prompt, wait for idle (bounded by a generous timeout
 * so a missing idle event can't hang the runner), then append the prompt's final
 * assistant info before parsing — guaranteeing non-zero tokens even if the
 * stream dropped the cumulative updates.
 */
export const runSession = (
  port: OpencodePort,
  params: { readonly dir: string; readonly model: string; readonly prompt: string },
): Effect.Effect<Usage, OpencodeFailed, never> =>
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

      const info = yield* Effect.tryPromise({
        try: () =>
          port.prompt(server, {
            sessionId,
            dir: params.dir,
            model: params.model,
            prompt: params.prompt,
          }),
        catch: fail('prompt'),
      });

      yield* Deferred.await(done).pipe(Effect.timeout('10 minutes'), Effect.ignore);
      events.push({ type: 'message.updated', properties: { info } });
      yield* Effect.logInfo('opencode session complete');
      return parseUsage(events);
    }),
  );
