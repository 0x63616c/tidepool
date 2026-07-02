#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Args, Command, Options } from '@effect/cli';
import { FetchHttpClient, FileSystem } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Either, Layer, Logger, Option, Schema } from 'effect';
import {
  type ClientConfig,
  type ClientConfigError,
  type ClientContext,
  clientConfigPath,
  contextByName,
  contextNames,
  deleteContext,
  describeContext,
  isSerializableValue,
  isValidContextName,
  loadClientConfig,
  type PortForwardError,
  resolveBaseUrl,
  resolveContext,
  setCurrentContext,
  upsertContext,
  writeClientConfig,
} from './client-config.ts';
import { renderDoctor, runDoctor } from './doctor.ts';
import type { NewTicket, RunEvent, Ticket } from './domain.ts';
import { HttpQueueControl } from './http-queue-control.ts';
import { RunId, TicketId } from './ids.ts';
import { LocalQueueControl, QueueControl, type TargetNotConfigured } from './queue-control.ts';
import { AppConfigLive, ticketStoreLive } from './runtime.ts';
import { renderTicketCost, renderTicketHeader, renderTrace } from './trace.ts';

/**
 * `tp` — the control-plane CLI. A pure queue-control CLIENT: every ticket verb
 * speaks the narrow `QueueControl` seam (read + enqueue only), never the store or
 * the reconciler's mover methods (tenet 3). The adapter behind the tag is chosen
 * at the entrypoint — the in-process `LocalQueueControl` for dev, and (later) an
 * `HttpQueueControl` pointed at the daemon for driving prod from a laptop. The
 * reconciler daemon lives in `src/daemon.ts`, not here — `tp` is not the mover.
 */

const DESCRIPTION = 'Tidepool control plane — manage the ticket backlog';

const binPath = (): string => {
  const exe = process.argv[1] ?? 'tp';
  const home = homedir();
  return exe.startsWith(home) ? `~${exe.slice(home.length)}` : exe;
};

/** Render tickets as a TOON block with a total count + next-step hints. */
const renderTickets = (tickets: ReadonlyArray<Ticket>): string => {
  if (tickets.length === 0) {
    return [
      'tickets: 0 tickets found',
      'help[1]:',
      '  Run `tp ticket add --title "..." --body "..." --target "<owner/repo>"` to add one',
    ].join('\n');
  }
  const rows = tickets.map((t) => `  ${t.id},${t.state},${t.target},${t.title}`);
  return [
    `tickets[${tickets.length}]{id,state,target,title}:`,
    ...rows,
    'help[1]:',
    '  Run `tp ticket add --title "..." --body "..." --target "<owner/repo>"` to add one',
  ].join('\n');
};

/**
 * Provide the `QueueControl` adapter (scoped) selected by the active client
 * context (`--context` flag > env > `~/.tidepool/config` > built-in `local`):
 * `sqlite` → the in-process store (dev); `http` → the daemon over HTTP, opening
 * an invisible `kubectl port-forward` first if the context declares one. The CLI
 * command never knows which adapter it got (deep module, tenet 4).
 */
const withQueue = <A, E>(
  flag: string | null,
  effect: Effect.Effect<A, E, QueueControl | BunContext.BunContext>,
): Effect.Effect<A, E | ClientConfigError | PortForwardError, BunContext.BunContext> =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadClientConfig;
      const ctx = yield* resolveContext(config, { flag });
      if (ctx.kind === 'sqlite') {
        return yield* effect.pipe(
          Effect.provide(
            LocalQueueControl.pipe(Layer.provide(Layer.merge(ticketStoreLive(), AppConfigLive))),
          ),
        );
      }
      const url = yield* resolveBaseUrl(ctx);
      return yield* effect.pipe(
        Effect.provide(HttpQueueControl(url).pipe(Layer.provide(FetchHttpClient.layer))),
      );
    }),
  );

/** The `--context` override, shared by every ticket verb. */
const contextOption = Options.text('context').pipe(Options.optional);
const flagOf = (context: Option.Option<string>): string | null => Option.getOrNull(context);

/** A one-line banner naming the backend a command is about to hit (AXI §9). */
const contextLine = (
  flag: string | null,
): Effect.Effect<string, ClientConfigError, FileSystem.FileSystem> =>
  loadClientConfig.pipe(
    Effect.flatMap((c) => resolveContext(c, { flag })),
    Effect.map((ctx) => `context: ${ctx.name} — ${describeContext(ctx)}`),
  );

// ── actions: thin Effects over QueueControl, returned as rendered strings so
//    they are unit-testable without driving the CLI runtime or a real store ────

/** `tp ticket add` — enqueue a ticket. Fails `TargetNotConfigured` for unknown repos. */
export const addAction = (
  input: NewTicket,
): Effect.Effect<string, TargetNotConfigured, QueueControl> =>
  Effect.gen(function* () {
    const qc = yield* QueueControl;
    const ticket = yield* qc.add(input);
    return [
      `ticket: created ${ticket.id}`,
      `  title: ${ticket.title}`,
      `  target: ${ticket.target}`,
      `  state: ${ticket.state}`,
      'help[1]:',
      '  Run `tp ticket list` to list the backlog',
    ].join('\n');
  });

/** `tp ticket list` — the backlog, optionally filtered by target repo. */
export const listAction = (opts: {
  readonly target: string | null;
  readonly limit: number;
}): Effect.Effect<string, never, QueueControl> =>
  Effect.gen(function* () {
    const qc = yield* QueueControl;
    const page = yield* qc.list({ limit: opts.limit, cursor: null, target: opts.target });
    const breakers = (yield* qc.breakers()).filter(
      (b) => b.isOpen && (opts.target === null || b.target === opts.target),
    );
    const body = renderTickets(page.items);
    const breakerLines = breakers.map(
      (b) =>
        `breaker: OPEN target=${b.target} reason=${b.reason ?? '-'} sha=${b.sha ?? '-'} since=${b.since}`,
    );
    const rendered = breakerLines.length === 0 ? body : [...breakerLines, body].join('\n');
    return page.nextCursor === null
      ? rendered
      : `${rendered}\nmore: ${page.items.length} shown — raise --limit to see the rest`;
  });

/** `tp ticket get <id>` — the merged lifecycle + cost detail view for one ticket. */
export const getAction = (
  id: TicketId,
  full = false,
): Effect.Effect<string, import('./domain.ts').TicketNotFound, QueueControl> =>
  Effect.gen(function* () {
    const qc = yield* QueueControl;
    const ticket = yield* qc.get(id);
    const runs = yield* qc.runsFor(id);
    const events = yield* qc.events({
      ticketId: id,
      runId: null,
      source: null,
      limit: 1000,
      cursor: null,
    });
    return [
      renderTicketHeader(ticket, { full }),
      renderTrace(ticket, runs, events.items),
      renderTicketCost(id, runs),
    ].join('\n');
  });

// ── rendering helpers for the observability read path ────────────────────────

const LINE_LIMIT = 500;
const decodeTicketId = Schema.decodeUnknownEither(TicketId);
const decodeRunId = Schema.decodeUnknownEither(RunId);

/** Collapse to one line, neutralise quotes, truncate with a definitive marker. */
const previewLine = (line: string): string => {
  const flat = line.replace(/\r?\n/g, ' ').replaceAll('"', "'");
  return flat.length > LINE_LIMIT
    ? `${flat.slice(0, LINE_LIMIT)}… (truncated, ${flat.length} chars total)`
    : flat;
};

/** TOON table of events; a definitive zero-state when empty. */
const renderEvents = (events: ReadonlyArray<RunEvent>, scope: string): string => {
  if (events.length === 0) return `events: 0 events found for ${scope}`;
  const rows = events.map((e) => `  ${e.source},${e.level ?? '-'},"${previewLine(e.line)}"`);
  return [`events[${events.length}]{source,level,line}:`, ...rows].join('\n');
};

/** Print a structured usage error and exit 2 (AXI: errors on stdout, actionable). */
const usageError = (line: string, help: string) =>
  Console.log([`error: ${line}`, `help: ${help}`].join('\n')).pipe(
    Effect.zipRight(Effect.sync(() => process.exit(2))),
  );

/** Print a definitive not-found and exit 1 (the intent genuinely can't be met). */
const notFound = (what: string, help: string) =>
  Console.log([`error: ${what} not found`, `help: ${help}`].join('\n')).pipe(
    Effect.zipRight(Effect.sync(() => process.exit(1))),
  );

// ── tp ticket subcommands ────────────────────────────────────────────────────

const ADD_HELP =
  'tp ticket add --title "..." --target "<owner/repo>" (--body "..." | --body-file <path|->)';

/** Where a ticket's markdown body comes from once the flags are resolved. */
export type BodySource =
  | { readonly kind: 'inline'; readonly value: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'stdin' };

/**
 * Resolve the mutually-exclusive `--body` / `--body-file` inputs to a single
 * source (AXI §6: exactly one required, structured error, never an interactive
 * prompt). `--body-file -` reads stdin. Pure + exported so the xor rules are
 * unit-tested without touching the filesystem.
 */
export const chooseBodySource = (opts: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
}): Either.Either<BodySource, string> => {
  if (Option.isSome(opts.body) && Option.isSome(opts.bodyFile))
    return Either.left('pass either --body or --body-file, not both');
  if (Option.isSome(opts.body)) return Either.right({ kind: 'inline', value: opts.body.value });
  if (Option.isSome(opts.bodyFile)) {
    const path = opts.bodyFile.value;
    return Either.right(path === '-' ? { kind: 'stdin' } : { kind: 'file', path });
  }
  return Either.left('a ticket needs a body: pass --body or --body-file');
};

/** Read the chosen body source to its string, exiting 2 on an unreadable file. */
const resolveBody = (src: BodySource): Effect.Effect<string, never, FileSystem.FileSystem> => {
  switch (src.kind) {
    case 'inline':
      return Effect.succeed(src.value);
    case 'stdin':
      return Effect.promise(() => Bun.stdin.text());
    case 'file':
      return FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(src.path)),
        Effect.catchAll(() =>
          usageError(`could not read --body-file ${src.path}`, ADD_HELP).pipe(Effect.as('')),
        ),
      );
  }
};

const addCommand = Command.make(
  'add',
  {
    title: Options.text('title'),
    body: Options.text('body').pipe(Options.optional),
    bodyFile: Options.text('body-file').pipe(Options.optional),
    target: Options.text('target'),
    context: contextOption,
  },
  ({ body, bodyFile, context, target, title }) => {
    const src = chooseBodySource({ body, bodyFile });
    if (Either.isLeft(src)) return usageError(src.left, ADD_HELP);
    return withQueue(
      flagOf(context),
      Effect.gen(function* () {
        const resolved = yield* resolveBody(src.right);
        return yield* addAction({ title, body: resolved, target }).pipe(
          Effect.flatMap(Console.log),
          Effect.catchTag('TargetNotConfigured', (e) =>
            Console.log(
              [
                `error: ${e.repo} is not a configured target`,
                `help: add it to tidepool.config.ts (configured: ${e.configured.join(', ')})`,
              ].join('\n'),
            ).pipe(Effect.zipRight(Effect.sync(() => process.exit(1)))),
          ),
        );
      }),
    );
  },
);

const listCommand = Command.make(
  'list',
  {
    target: Options.text('target').pipe(Options.optional),
    limit: Options.integer('limit').pipe(Options.withDefault(50)),
    context: contextOption,
  },
  ({ context, limit, target }) => {
    const flag = flagOf(context);
    return withQueue(
      flag,
      Effect.gen(function* () {
        const line = yield* contextLine(flag);
        const body = yield* listAction({ target: Option.getOrNull(target), limit });
        yield* Console.log(`${line}\n${body}`);
      }),
    );
  },
);

const getCommand = Command.make(
  'get',
  { ticket: Args.text({ name: 'ticket' }), full: Options.boolean('full'), context: contextOption },
  ({ context, full, ticket }) =>
    withQueue(
      flagOf(context),
      Effect.gen(function* () {
        const decoded = decodeTicketId(ticket);
        if (Either.isLeft(decoded))
          return yield* usageError(`not a ticket id: ${ticket}`, 'tp ticket get tckt_…');
        return yield* getAction(decoded.right, full).pipe(
          Effect.flatMap(Console.log),
          Effect.catchTag('TicketNotFound', () => notFound(`ticket ${ticket}`, 'tp ticket list')),
        );
      }),
    ),
);

/**
 * `tp ticket logs <ticket>` / `--run <run_id>` — read the durable event stream.
 * The opencode transcript blob is excluded from the ticket view by default (it's
 * large); `tp ticket transcript <run_id>` prints it. Scoping to `--run` shows all.
 */
const logsCommand = Command.make(
  'logs',
  {
    ticket: Args.text({ name: 'ticket' }).pipe(Args.optional),
    run: Options.text('run').pipe(Options.optional),
    context: contextOption,
  },
  ({ context, run, ticket }) =>
    withQueue(
      flagOf(context),
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        if (Option.isSome(run)) {
          const decoded = decodeRunId(run.value);
          if (Either.isLeft(decoded))
            return yield* usageError(`not a run id: ${run.value}`, 'tp ticket logs --run run_…');
          const page = yield* qc.events({
            ticketId: null,
            runId: decoded.right,
            source: null,
            limit: 1000,
            cursor: null,
          });
          return yield* Console.log(renderEvents(page.items, `run ${run.value}`));
        }
        if (Option.isSome(ticket)) {
          const decoded = decodeTicketId(ticket.value);
          if (Either.isLeft(decoded))
            return yield* usageError(`not a ticket id: ${ticket.value}`, 'tp ticket logs tckt_…');
          return yield* qc
            .events({
              ticketId: decoded.right,
              runId: null,
              source: null,
              limit: 1000,
              cursor: null,
            })
            .pipe(
              Effect.flatMap((page) => {
                const shown = page.items.filter((e) => e.source !== 'opencode');
                const hidden = page.items.length - shown.length;
                const hints = [
                  'help[2]:',
                  ...(hidden > 0
                    ? [
                        `  ${hidden} opencode transcript event(s) hidden — run \`tp ticket transcript <run_id>\``,
                      ]
                    : ['  Run `tp ticket transcript <run_id>` to read an opencode transcript']),
                  '  Run `tp ticket logs --run <run_id>` to scope to a single run',
                ];
                return Console.log(
                  [renderEvents(shown, `ticket ${ticket.value}`), ...hints].join('\n'),
                );
              }),
              Effect.catchTag('TicketNotFound', () =>
                notFound(`ticket ${ticket.value}`, 'tp ticket list'),
              ),
            );
        }
        return yield* usageError(
          'provide a ticket id or --run',
          'tp ticket logs <ticket> | tp ticket logs --run <run_id>',
        );
      }),
    ),
);

/** `tp ticket transcript <run_id>` — parse the opencode capture for a run and pretty-print it. */
const transcriptCommand = Command.make(
  'transcript',
  { run: Args.text({ name: 'run_id' }), context: contextOption },
  ({ context, run }) =>
    withQueue(
      flagOf(context),
      Effect.gen(function* () {
        const qc = yield* QueueControl;
        const decoded = decodeRunId(run);
        if (Either.isLeft(decoded))
          return yield* usageError(`not a run id: ${run}`, 'tp ticket transcript run_…');
        const page = yield* qc.events({
          ticketId: null,
          runId: decoded.right,
          source: 'opencode',
          limit: 1000,
          cursor: null,
        });
        if (page.items.length === 0)
          return yield* Console.log(`transcript: 0 transcript events found for run ${run}`);
        const blocks = page.items.map((e) => {
          // A capture line should be JSON, but a truncated/plain line must not
          // crash the whole command — fall back to printing it raw.
          let parsed: unknown;
          try {
            parsed = JSON.parse(e.line);
          } catch {
            return [`transcript: run ${run} (unparseable line)`, e.line].join('\n');
          }
          const entries = Array.isArray(parsed) ? parsed.length : 1;
          return [
            `transcript: run ${run} (${entries} entries)`,
            JSON.stringify(parsed, null, 2),
          ].join('\n');
        });
        return yield* Console.log(blocks.join('\n'));
      }),
    ),
);

const ticketCommand = Command.make('ticket', {}, () =>
  Console.log(
    ['ticket: pick a subcommand', 'help[1]:', '  add | list | get | logs | transcript'].join('\n'),
  ),
).pipe(
  Command.withSubcommands([addCommand, listCommand, getCommand, logsCommand, transcriptCommand]),
);

// ── tp context: manage which backend tp drives (kubectl-style) ───────────────

/** Resolve the active context (no per-invocation flag) for display. */
const activeContext = Effect.gen(function* () {
  const config = yield* loadClientConfig;
  return { config, ctx: yield* resolveContext(config, { flag: null }) };
});

/** `tp context list` — all contexts + which is the current default. */
const contextListCommand = Command.make('list', {}, () =>
  activeContext.pipe(
    Effect.flatMap(({ config, ctx }) => {
      const rows = contextNames(config).map((name) => {
        const c = contextByName(config, name);
        const kind = c?.kind ?? 'sqlite';
        const target = c ? describeContext(c) : 'sqlite (local store)';
        return `  ${name},${kind},"${target}",${name === ctx.name ? '*' : ''}`;
      });
      return Console.log(
        [
          `contexts[${rows.length}]{name,kind,target,current}:`,
          ...rows,
          'help[2]:',
          '  Run `tp context use <name>` to set the default backend',
          '  Run `tp context set <name> --url <url>` (or --service/--namespace) to add/edit one',
        ].join('\n'),
      );
    }),
  ),
);

/** `tp context current` — the active backend and how it was resolved. */
const contextCurrentCommand = Command.make('current', {}, () =>
  activeContext.pipe(
    Effect.flatMap(({ ctx }) => {
      const source =
        process.env.TIDEPOOL_API_URL !== undefined && process.env.TIDEPOOL_API_URL.length > 0
          ? 'env TIDEPOOL_API_URL'
          : process.env.TIDEPOOL_CONTEXT !== undefined
            ? 'env TIDEPOOL_CONTEXT'
            : `${clientConfigPath()} current-context (or built-in default)`;
      return Console.log(
        [
          `context: ${ctx.name}`,
          `  kind: ${ctx.kind}`,
          `  target: ${describeContext(ctx)}`,
          `  source: ${source}`,
        ].join('\n'),
      );
    }),
  ),
);

/** `tp context use <name>` — set the default context (idempotent). */
const contextUseCommand = Command.make('use', { name: Args.text({ name: 'name' }) }, ({ name }) =>
  loadClientConfig.pipe(
    Effect.flatMap((config) => {
      if (contextByName(config, name) === null)
        return usageError(
          `no such context: ${name}`,
          'tp context list | tp context set <name> --url <url>',
        );
      if (config.currentContext === name)
        return Console.log(`context: already defaulting to ${name} (no-op)`);
      return writeClientConfig(setCurrentContext(config, name)).pipe(
        Effect.zipRight(Console.log(`context: default set to ${name}`)),
      );
    }),
  ),
);

/** `tp context set <name>` — create or edit a context. */
const contextSetCommand = Command.make(
  'set',
  {
    name: Args.text({ name: 'name' }),
    kind: Options.choice('kind', ['http', 'sqlite']).pipe(Options.withDefault('http' as const)),
    url: Options.text('url').pipe(Options.optional),
    namespace: Options.text('namespace').pipe(Options.optional),
    service: Options.text('service').pipe(Options.optional),
    remotePort: Options.integer('remote-port').pipe(Options.withDefault(8080)),
  },
  ({ kind, name, namespace, remotePort, service, url }) =>
    loadClientConfig.pipe(
      Effect.flatMap((config): Effect.Effect<void, ClientConfigError, FileSystem.FileSystem> => {
        // Name must survive the `[contexts.<name>]` grammar (else it vanishes on reload).
        if (!isValidContextName(name))
          return usageError(
            `invalid context name: ${name}`,
            'names may contain only letters, digits, - and _',
          );
        if (Option.isSome(url) && !isSerializableValue(url.value))
          return usageError(
            '--url may not contain quotes or newlines',
            'tp context set <name> --url http://host:8080',
          );
        const pf = Option.isSome(namespace) && Option.isSome(service);
        if (kind === 'sqlite') {
          if (Option.isSome(url) || pf)
            return usageError(
              'a sqlite context takes no --url / --namespace / --service',
              'tp context set local --kind sqlite',
            );
          return writeSet(config, { name, kind: 'sqlite' }, name);
        }
        // http: exactly one of {--url} or {--namespace + --service}, never both.
        if (Option.isSome(url) && pf)
          return usageError(
            'use either --url OR --namespace/--service (a port-forward), not both',
            'tp context set prod --namespace core --service reconciler',
          );
        if (pf && Option.isSome(namespace) && Option.isSome(service)) {
          const ctx: ClientContext = {
            // The local side is always ephemeral (resolved fresh per command —
            // see resolveBaseUrl), so this url is never read for a port-forward
            // context; it's a placeholder to satisfy the schema.
            name,
            kind: 'http',
            url: `http://127.0.0.1:${remotePort}`,
            portForward: { namespace: namespace.value, service: service.value, remotePort },
          };
          return writeSet(config, ctx, name);
        }
        if (Option.isSome(url))
          return writeSet(config, { name, kind: 'http', url: url.value }, name);
        return usageError(
          'an http context needs --url, or --namespace + --service for a port-forward',
          'tp context set prod --namespace core --service reconciler  |  tp context set staging --url http://host:8080',
        );
      }),
    ),
);

/** Shared write-and-confirm for `context set`. */
const writeSet = (
  config: ClientConfig,
  ctx: ClientContext,
  name: string,
): Effect.Effect<void, ClientConfigError, FileSystem.FileSystem> =>
  writeClientConfig(upsertContext(config, ctx)).pipe(
    Effect.zipRight(
      Console.log(
        [
          `context: saved ${name} (${describeContext(ctx)})`,
          'help[1]:',
          `  Run \`tp context use ${name}\` to make it the default`,
        ].join('\n'),
      ),
    ),
  );

/** `tp context delete <name>` — remove a context (idempotent). */
const contextDeleteCommand = Command.make(
  'delete',
  { name: Args.text({ name: 'name' }) },
  ({ name }) =>
    loadClientConfig.pipe(
      Effect.flatMap((config) => {
        if (config.contexts[name] === undefined)
          return Console.log(`context: ${name} not found (no-op)`);
        const cleared = config.currentContext === name;
        return writeClientConfig(deleteContext(config, name)).pipe(
          Effect.zipRight(
            Console.log(
              cleared
                ? `context: deleted ${name} (was the default — now falls back to built-in local)`
                : `context: deleted ${name}`,
            ),
          ),
        );
      }),
    ),
);

const contextCommand = Command.make('context', {}, () =>
  Console.log(
    [
      'context: pick a subcommand',
      'help[1]:',
      '  list | current | use <name> | set <name> … | delete <name>',
    ].join('\n'),
  ),
).pipe(
  Command.withSubcommands([
    contextListCommand,
    contextCurrentCommand,
    contextUseCommand,
    contextSetCommand,
    contextDeleteCommand,
  ]),
);

/** `tp doctor` — the terminal health check. Exits 1 on FAIL so CI/agents can gate. */
const doctorCommand = Command.make('doctor', {}, () =>
  Effect.scoped(
    runDoctor.pipe(
      Effect.provide(Layer.merge(ticketStoreLive(), AppConfigLive)),
      Effect.flatMap((verdict) =>
        Console.log(renderDoctor(verdict)).pipe(
          Effect.zipRight(verdict.ok ? Effect.void : Effect.sync(() => process.exit(1))),
        ),
      ),
    ),
  ),
);

/**
 * No-args home view (AXI §8/§10): identify the tool, show the ACTIVE backend so
 * it's obvious whether tp is driving local or prod, then the live backlog, then
 * a few next-step hints — including how to switch context.
 */
const homeView = Effect.gen(function* () {
  const { ctx } = yield* activeContext;
  const tickets = yield* withQueue(null, listAction({ target: null, limit: 50 }));
  yield* Console.log(
    [
      `bin: ${binPath()}`,
      `description: ${DESCRIPTION}`,
      `context: ${ctx.name} — ${describeContext(ctx)}`,
      tickets,
      'help[2]:',
      '  Run `tp context list` to see backends; `tp context use <name>` to switch the default',
      '  Add `--context <name>` to any command to target a backend for one call',
    ].join('\n'),
  );
});

const root = Command.make('tp', {}, () => homeView).pipe(
  Command.withSubcommands([ticketCommand, contextCommand, doctorCommand]),
);

const cli = Command.run(root, { name: 'tp', version: '0.0.0' });

/** Render a clean AXI failure on stdout and exit 1 (never leak a raw stack). */
const renderFailure = (label: string, help: string) =>
  Console.log([`error: ${label}`, `help: ${help}`].join('\n')).pipe(
    Effect.zipRight(Effect.sync(() => process.exit(1))),
  );

// Guard the runMain side effect so the module is importable by unit tests without
// launching the CLI.
if (import.meta.main) {
  const guarded = cli(process.argv).pipe(
    // Domain errors that escaped a command → actionable one-liners, not stacks.
    Effect.catchTags({
      // The local side is ephemeral (kubectl/OS-assigned), so "address already
      // in use" should never come from our own prior forward — but guard
      // defensively rather than blaming the VPN when it's actually a port
      // fight with some unrelated process.
      PortForwardError: (e) =>
        /address already in use/i.test(e.message)
          ? renderFailure(
              `port-forward failed: ${e.message}`,
              'the local port kubectl picked is already taken by another process — retry the command',
            )
          : renderFailure(
              `port-forward failed: ${e.message}`,
              'check the VPN + `tp context current`, or use `tp --context local`',
            ),
      ClientConfigError: (e) =>
        renderFailure(
          `config error: ${e.message}`,
          'inspect ~/.tidepool/config or run `tp context list`',
        ),
    }),
    // Transport/connection failures reach here as defects — render them cleanly.
    Effect.catchAllDefect((d) =>
      renderFailure(
        `cannot reach the backend (${String(d).split('\n')[0]})`,
        'is the daemon deployed and the tunnel/VPN up? try `tp --context local`',
      ),
    ),
  );
  const program = guarded.pipe(Effect.provide(BunContext.layer));
  // Structured JSON logs when not attached to a terminal; pretty logger otherwise.
  if (process.stdout.isTTY) {
    BunRuntime.runMain(program);
  } else {
    BunRuntime.runMain(program.pipe(Effect.provide(Logger.json)), { disablePrettyLogger: true });
  }
}
