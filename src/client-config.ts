import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, type CommandExecutor, FileSystem } from '@effect/platform';
import { Data, Deferred, Duration, Effect, Schema, type Scope, Stream } from 'effect';

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
 *   [contexts.local]
 *   kind = "sqlite"
 *
 * The local side of the forward is always ephemeral (kubectl picks a free
 * port; there is no `local-port` field) — that's what makes concurrent `tp`
 * invocations, and orphaned tunnels from a killed prior one, harmless.
 */

export const PortForward = Schema.Struct({
  namespace: Schema.String,
  service: Schema.String,
  remotePort: Schema.Number,
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

/** Strip a trailing `# comment`, but never one that sits inside a quoted value. */
const stripComment = (line: string): string => {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' || ch === "'") inQuote = !inQuote;
    else if (ch === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
};

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
    const trimmed = stripComment(line).trim();
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

// ── config management (kubectl-style: the CLI owns ~/.tidepool/config) ─────────

/** Every context name known to the config plus the always-present built-in `local`. */
export const contextNames = (config: ClientConfig): ReadonlyArray<string> => {
  const names = new Set<string>([DEFAULT_CONTEXT.name, ...Object.keys(config.contexts)]);
  return [...names].sort();
};

/** Look up a context by name, falling back to the built-in `local` (sqlite). */
export const contextByName = (config: ClientConfig, name: string): ClientContext | null =>
  config.contexts[name] ?? (name === DEFAULT_CONTEXT.name ? DEFAULT_CONTEXT : null);

/** One-line human description of a context's backend target. */
export const describeContext = (ctx: ClientContext): string =>
  ctx.kind === 'sqlite'
    ? 'sqlite (local store)'
    : ctx.portForward !== undefined
      ? `http → port-forward ${ctx.portForward.namespace}/${ctx.portForward.service}:${ctx.portForward.remotePort}`
      : `http → ${ctx.url}`;

/** Add or replace a context (edit is upsert-by-name). Pure. */
export const upsertContext = (config: ClientConfig, ctx: ClientContext): ClientConfig => ({
  ...config,
  contexts: { ...config.contexts, [ctx.name]: ctx },
});

/**
 * Remove a context. If it was the current default, the default is cleared (so
 * resolution falls back to built-in `local`) rather than left dangling. Pure.
 */
export const deleteContext = (config: ClientConfig, name: string): ClientConfig => {
  const { [name]: _removed, ...rest } = config.contexts;
  return {
    currentContext: config.currentContext === name ? null : config.currentContext,
    contexts: rest,
  };
};

/** Set the default context. Pure — the caller validates the name exists first. */
export const setCurrentContext = (config: ClientConfig, name: string): ClientConfig => ({
  ...config,
  currentContext: name,
});

/** Serialize back to the on-disk format, round-trippable by `parseClientConfig`. */
export const serializeClientConfig = (config: ClientConfig): string => {
  const lines: string[] = [];
  if (config.currentContext !== null)
    lines.push(`current-context = "${config.currentContext}"`, '');
  for (const name of Object.keys(config.contexts).sort()) {
    const ctx = config.contexts[name];
    if (ctx === undefined) continue;
    lines.push(`[contexts.${name}]`, `kind = "${ctx.kind}"`);
    if (ctx.kind === 'http') {
      lines.push(`url = "${ctx.url}"`);
      if (ctx.portForward !== undefined) {
        lines.push(
          `namespace = "${ctx.portForward.namespace}"`,
          `service = "${ctx.portForward.service}"`,
          `remote-port = ${ctx.portForward.remotePort}`,
        );
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
};

/** The absolute path of the client config file (`~/.tidepool/config`). */
export const clientConfigPath = (): string => join(homedir(), '.tidepool', 'config');

/** Context names must round-trip through the section grammar `[contexts.<name>]`. */
export const isValidContextName = (name: string): boolean => /^[\w-]+$/.test(name);

/** A serialized string value must not contain a quote/newline (the format can't escape them). */
export const isSerializableValue = (v: string): boolean => !/["'\r\n]/.test(v);

/**
 * Write the config to `~/.tidepool/config`, creating the directory if needed.
 * Atomic: serialize to a temp file then rename over the target, so a crash mid-
 * write can never leave a half-written config that loses the operator's backends.
 */
export const writeClientConfig = (
  config: ClientConfig,
): Effect.Effect<void, ClientConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = join(homedir(), '.tidepool');
    const path = clientConfigPath();
    const tmp = `${path}.tmp`;
    const fail = (e: unknown) => new ClientConfigError({ message: String(e) });
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(fail));
    yield* fs.writeFileString(tmp, serializeClientConfig(config)).pipe(Effect.mapError(fail));
    yield* fs.rename(tmp, path).pipe(Effect.mapError(fail));
  });

/** Matches kubectl's readiness line, e.g. `Forwarding from 127.0.0.1:54321 -> 8080`. */
const FORWARDING_RE = /Forwarding from [^\s:]+:(\d+) ->/;

/**
 * Establish the base URL for an http context, opening an invisible
 * `kubectl port-forward` first when the context declares one — the operator never
 * runs the tunnel by hand. Scoped: the forward is killed when the scope closes
 * (i.e. when the one-shot command finishes). Reaches the pod through the
 * /32-firewalled apiserver, so nothing new is exposed (tenet 9).
 *
 * The local side is always ephemeral (`:<remotePort>`, local side 0 — kubectl/the
 * OS picks a free port) rather than a fixed configured port: a fixed port meant
 * (a) an orphaned forward from a non-graceful prior exit (Ctrl-C, killed
 * terminal — the scope finalizer that kills kubectl never runs) permanently
 * squats on it, and (b) two concurrent `tp` invocations always collided. Both
 * are moot once every invocation gets its own free port. The actual bound port
 * is parsed out of kubectl's own "Forwarding from" stdout line — it is the only
 * source of truth for what the OS actually assigned.
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
    `:${pf.remotePort}`,
  );
  return Effect.gen(function* () {
    const proc = yield* Command.start(cmd).pipe(
      Effect.mapError((e) => new PortForwardError({ message: String(e) })),
    );
    const boundPort = yield* Deferred.make<number>();
    // CRITICAL: keep draining kubectl's stdout for the whole tunnel lifetime.
    // kubectl logs a line per proxied connection ("Handling connection for …");
    // if we stop reading, its stdout pipe fills / closes and kubectl dies with
    // SIGPIPE exactly when the first request arrives ("socket closed
    // unexpectedly"). A forked drain that never ends avoids that, and extracts
    // the actually-bound local port off the "Forwarding from" line.
    yield* proc.stdout
      .pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((l) => {
          const port = FORWARDING_RE.exec(l)?.[1];
          return port !== undefined ? Deferred.succeed(boundPort, Number(port)) : Effect.void;
        }),
      )
      .pipe(Effect.forkScoped);
    // Ready when the tunnel binds; fail fast if kubectl exits first (bad svc,
    // RBAC, VPN down) or nothing binds within the deadline.
    const port = yield* Deferred.await(boundPort).pipe(
      Effect.raceFirst(
        proc.exitCode.pipe(
          Effect.mapError((e) => new PortForwardError({ message: String(e) })),
          Effect.flatMap((code) =>
            Effect.fail(
              new PortForwardError({
                message: `kubectl port-forward exited (code ${code}) before the tunnel was ready — is the VPN up and the service present?`,
              }),
            ),
          ),
        ),
      ),
      Effect.timeoutFail({
        duration: Duration.seconds(10),
        onTimeout: () =>
          new PortForwardError({ message: 'timed out opening kubectl port-forward' }),
      }),
    );
    return `http://127.0.0.1:${port}`;
  });
};
