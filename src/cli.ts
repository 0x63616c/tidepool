#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Args, Command, Options } from '@effect/cli';
import { FetchHttpClient } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Either, Layer, Logger, Option, Schema } from 'effect';
import {
  type ClientConfigError,
  loadClientConfig,
  type PortForwardError,
  resolveBaseUrl,
  resolveContext,
} from './client-config.ts';
import { renderDoctor, runDoctor } from './doctor.ts';
import type { NewTicket, RunEvent, Ticket } from './domain.ts';
import { HttpQueueControl } from './http-queue-control.ts';
import { RunId, TicketId } from './ids.ts';
import { LocalQueueControl, QueueControl, type TargetNotConfigured } from './queue-control.ts';
import { AppConfigLive, ticketStoreLive } from './runtime.ts';
import { renderTicketCost, renderTrace } from './trace.ts';

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
      '  Run `tp ticket add --title "..." --goal "..." --target "<owner/repo>"` to add one',
    ].join('\n');
  }
  const rows = tickets.map((t) => `  ${t.id},${t.title},${t.state},${t.target}`);
  return [
    `tickets[${tickets.length}]{id,title,state,target}:`,
    ...rows,
    'help[1]:',
    '  Run `tp ticket add --title "..." --goal "..." --target "<owner/repo>"` to add one',
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
  effect: Effect.Effect<A, E, QueueControl>,
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
    const body = renderTickets(page.items);
    return page.nextCursor === null
      ? body
      : `${body}\nmore: ${page.items.length} shown — raise --limit to see the rest`;
  });

/** `tp ticket get <id>` — the merged lifecycle + cost detail view for one ticket. */
export const getAction = (
  id: TicketId,
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
    return [renderTrace(ticket, runs, events.items), renderTicketCost(id, runs)].join('\n');
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

const addCommand = Command.make(
  'add',
  {
    title: Options.text('title'),
    goal: Options.text('goal'),
    target: Options.text('target'),
    context: contextOption,
  },
  ({ context, goal, target, title }) =>
    withQueue(
      flagOf(context),
      addAction({ title, goal, target }).pipe(
        Effect.flatMap(Console.log),
        Effect.catchTag('TargetNotConfigured', (e) =>
          Console.log(
            [
              `error: ${e.repo} is not a configured target`,
              `help: add it to tidepool.config.ts (configured: ${e.configured.join(', ')})`,
            ].join('\n'),
          ).pipe(Effect.zipRight(Effect.sync(() => process.exit(1)))),
        ),
      ),
    ),
);

const listCommand = Command.make(
  'list',
  {
    target: Options.text('target').pipe(Options.optional),
    limit: Options.integer('limit').pipe(Options.withDefault(50)),
    context: contextOption,
  },
  ({ context, limit, target }) =>
    withQueue(
      flagOf(context),
      listAction({ target: Option.getOrNull(target), limit }).pipe(Effect.flatMap(Console.log)),
    ),
);

const getCommand = Command.make(
  'get',
  { ticket: Args.text({ name: 'ticket' }), context: contextOption },
  ({ context, ticket }) =>
    withQueue(
      flagOf(context),
      Effect.gen(function* () {
        const decoded = decodeTicketId(ticket);
        if (Either.isLeft(decoded))
          return yield* usageError(`not a ticket id: ${ticket}`, 'tp ticket get tckt_…');
        return yield* getAction(decoded.right).pipe(
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
          const parsed: unknown = JSON.parse(e.line);
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

const homeView = withQueue(
  null,
  listAction({ target: null, limit: 50 }).pipe(
    Effect.flatMap((tickets) =>
      Console.log([`bin: ${binPath()}`, `description: ${DESCRIPTION}`, tickets].join('\n')),
    ),
  ),
);

const root = Command.make('tp', {}, () => homeView).pipe(
  Command.withSubcommands([ticketCommand, doctorCommand]),
);

const cli = Command.run(root, { name: 'tp', version: '0.0.0' });

// Guard the runMain side effect so the module is importable by unit tests without
// launching the CLI.
if (import.meta.main) {
  const program = cli(process.argv).pipe(Effect.provide(BunContext.layer));
  // Structured JSON logs when not attached to a terminal; pretty logger otherwise.
  if (process.stdout.isTTY) {
    BunRuntime.runMain(program);
  } else {
    BunRuntime.runMain(program.pipe(Effect.provide(Logger.json)), { disablePrettyLogger: true });
  }
}
