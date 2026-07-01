import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, type CommandExecutor, FileSystem } from '@effect/platform';
import { Data, Duration, Effect, Option, Schema, type Scope, Stream } from 'effect';

/**
 * Client contexts — how `tp` (on a laptop) picks which backend to drive. This is
 * PER-OPERATOR local state ("which queue is MY laptop pointed at right now"), so
 * it lives in `~/.tidepool/config`, never in the git-tracked `tidepool.config.ts`
 * (tenet 1/2 — that file is declarative shared app config). Modelled on
 * kubectl/hcloud named contexts: a `current-context` plus `[contexts.<name>]`.
 *
 *   current-context = "prod"
 *   [contexts.prod]
 *   kind = "http"
 *   url = "http://127.0.0.1:8080"
 *   # optional: auto-open an invisible kubectl port-forward instead of a manual one
 *   namespace = "core"
 *   service = "reconciler"
 *   remote-port = 8080
 *   local-port = 8080
 *   [contexts.local]
 *   kind = "sqlite"
 */

export const PortForward = Schema.Struct({
  namespace: Schema.String,
  service: Schema.String,
  remotePort: Schema.Number,
  localPort: Schema.Number,
});
export type PortForward = typeof PortForward.Type;

export const ClientContext = Schema.Union(
  Schema.Struct({ name: Schema.String, kind: Schema.Literal('sqlite') }),
  Schema.Struct({
    name: Schema.String,
    kind: Schema.Literal('http'),
    url: Schema.String,
    portForward: Schema.optional(PortForward),
  }),
);
export type ClientContext = typeof ClientContext.Type;

export interface ClientConfig {
  readonly currentContext: string | null;
  readonly contexts: Record<string, ClientContext>;
}

/** The always-available built-in: the in-process sqlite store, for dev. */
export const DEFAULT_CONTEXT: ClientContext = { name: 'local', kind: 'sqlite' };

export class ClientConfigError extends Data.TaggedError('ClientConfigError')<{
  readonly message: string;
}> {}

export class PortForwardError extends Data.TaggedError('PortForwardError')<{
  readonly message: string;
}> {}

const stripQuotes = (v: string): string => v.replace(/^["']|["']$/g, '');

/** Parse a port field, falling back on missing/non-numeric input (no silent NaN). */
const portNum = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : fallback;
};

/**
 * Parse the minimal `current-context` + `[contexts.<name>]` INI/TOML subset we
 * support. Deliberately tiny (no dependency) — only the keys above. Unknown keys
 * are ignored; a malformed context surfaces as a `ClientConfigError` at build.
 */
export const parseClientConfig = (text: string): ClientConfig => {
  let currentContext: string | null = null;
  const raw: Record<string, Record<string, string>> = {};
  let section: string | null = null;

  for (const line of text.split('\n')) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (trimmed.length === 0) continue;
    const sectionMatch = trimmed.match(/^\[contexts\.([\w-]+)\]$/);
    if (sectionMatch?.[1] !== undefined) {
      section = sectionMatch[1];
      raw[section] = {};
      continue;
    }
    const kv = trimmed.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (kv?.[1] === undefined || kv[2] === undefined) continue;
    const key = kv[1];
    const value = stripQuotes(kv[2].trim());
    if (section === null) {
      if (key === 'current-context') currentContext = value;
      continue;
    }
    const bucket = raw[section];
    if (bucket !== undefined) bucket[key] = value;
  }

  const contexts: Record<string, ClientContext> = {};
  for (const [name, fields] of Object.entries(raw)) {
    if (fields.kind === 'sqlite') {
      contexts[name] = { name, kind: 'sqlite' };
    } else if (fields.kind === 'http' && fields.url !== undefined) {
      const pf =
        fields.namespace !== undefined && fields.service !== undefined
          ? {
              namespace: fields.namespace,
              service: fields.service,
              remotePort: portNum(fields['remote-port'], 8080),
              localPort: portNum(fields['local-port'] ?? fields['remote-port'], 8080),
            }
          : undefined;
      contexts[name] = { name, kind: 'http', url: fields.url, ...(pf ? { portForward: pf } : {}) };
    }
  }
  return { currentContext, contexts };
};

/** Load `~/.tidepool/config`; a missing file is not an error (→ empty config). */
export const loadClientConfig: Effect.Effect<
  ClientConfig,
  ClientConfigError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(homedir(), '.tidepool', 'config');
  const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { currentContext: null, contexts: {} };
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((e) => new ClientConfigError({ message: String(e) })));
  return parseClientConfig(text);
});

/**
 * Resolve the active context. Precedence (highest first): explicit `--context`
 * flag > `TIDEPOOL_API_URL` env (ad-hoc http) > `TIDEPOOL_CONTEXT` env > file
 * `current-context` > the built-in `local` (sqlite). Pure over its inputs + env
 * so it is unit-testable.
 */
export const resolveContext = (
  config: ClientConfig,
  opts: { readonly flag: string | null },
): Effect.Effect<ClientContext, ClientConfigError> =>
  Effect.gen(function* () {
    const named = (name: string): ClientContext | null =>
      name === 'local' && config.contexts.local === undefined
        ? DEFAULT_CONTEXT
        : (config.contexts[name] ?? null);

    if (opts.flag !== null) {
      const ctx = named(opts.flag);
      if (ctx === null)
        return yield* Effect.fail(
          new ClientConfigError({ message: `no such context: ${opts.flag}` }),
        );
      return ctx;
    }
    const apiUrl = process.env.TIDEPOOL_API_URL;
    if (apiUrl !== undefined && apiUrl.length > 0)
      return { name: 'env', kind: 'http', url: apiUrl };
    const envName = process.env.TIDEPOOL_CONTEXT;
    const chosen = envName ?? config.currentContext ?? 'local';
    const ctx = named(chosen);
    if (ctx === null)
      return yield* Effect.fail(new ClientConfigError({ message: `no such context: ${chosen}` }));
    return ctx;
  });

/**
 * Establish the base URL for an http context, opening an invisible
 * `kubectl port-forward` first when the context declares one — the operator never
 * runs the tunnel by hand. Scoped: the forward is killed when the scope closes
 * (i.e. when the one-shot command finishes). Reaches the pod through the
 * /32-firewalled apiserver, so nothing new is exposed (tenet 9).
 */
export const resolveBaseUrl = (
  ctx: Extract<ClientContext, { kind: 'http' }>,
): Effect.Effect<string, PortForwardError, CommandExecutor.CommandExecutor | Scope.Scope> => {
  const pf = ctx.portForward;
  if (pf === undefined) return Effect.succeed(ctx.url);
  const cmd = Command.make(
    'kubectl',
    'port-forward',
    '-n',
    pf.namespace,
    `svc/${pf.service}`,
    `${pf.localPort}:${pf.remotePort}`,
  );
  const ready = 'Forwarding from';
  return Command.start(cmd).pipe(
    Effect.mapError((e) => new PortForwardError({ message: String(e) })),
    Effect.flatMap((proc) =>
      proc.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.takeUntil((l) => l.includes(ready)),
        // The LAST line before the stream ends: the readiness line if the tunnel
        // came up, or something else if kubectl died first (service missing, RBAC).
        Stream.runLast,
        Effect.timeoutFail({
          duration: Duration.seconds(8),
          onTimeout: () =>
            new PortForwardError({ message: 'timed out opening kubectl port-forward' }),
        }),
        Effect.flatMap((last) =>
          Option.match(last, {
            onSome: (l) =>
              l.includes(ready)
                ? Effect.void
                : Effect.fail(
                    new PortForwardError({
                      message: `kubectl port-forward exited before ready: ${l}`,
                    }),
                  ),
            onNone: () =>
              Effect.fail(
                new PortForwardError({
                  message: 'kubectl port-forward exited before the tunnel was ready',
                }),
              ),
          }),
        ),
        Effect.mapError((e) =>
          e instanceof PortForwardError ? e : new PortForwardError({ message: String(e) }),
        ),
      ),
    ),
    Effect.as(`http://127.0.0.1:${pf.localPort}`),
  );
};
