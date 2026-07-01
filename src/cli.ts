#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Args, Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Either, Layer, Logger, Option, Schema } from 'effect';
import { AppConfig } from './config.ts';
import { renderDoctor, runDoctor } from './doctor.ts';
import type { RunEvent, Ticket } from './domain.ts';
import { RunId, TicketId } from './ids.ts';
import { reconcileForever, settle } from './reconciler.ts';
import { AppConfigLive, liveStack, ticketStoreLive } from './runtime.ts';
import { type AgentWorker, type Forge, TicketStore } from './services.ts';
import { costReport, traceReport } from './trace.ts';

/**
 * `tp` — the control-plane CLI. Agent-facing (AXI): TOON output, content-first
 * home view, structured errors, definitive empty states. Backed by the durable
 * sqlite store; `tp run` drives the real reconciler against live adapters.
 */

const DESCRIPTION = 'Tidepool control plane — manage the ticket backlog';

const SEED_GOAL =
  "add slugify(s: string): string in src/string.ts — lowercases, trims, spaces→'-', strips chars that aren't [a-z0-9-], collapses repeated '-'. Has a vitest spec covering those cases.";

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
    'help[2]:',
    '  Run `tp run` to drive the backlog to done',
    '  Run `tp ticket add --title "..." --goal "..." --target "<owner/repo>"` to add one',
  ].join('\n');
};

/** Provide the durable store (scoped) to a store-only command. */
const withStore = <A, E>(effect: Effect.Effect<A, E, TicketStore>): Effect.Effect<A, E> =>
  Effect.scoped(Effect.provide(effect, ticketStoreLive()));

const lsCommand = Command.make('ls', {}, () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* TicketStore;
      const tickets = yield* store.list();
      yield* Console.log(renderTickets(tickets));
    }),
  ),
);

const addCommand = Command.make(
  'add',
  {
    title: Options.text('title'),
    goal: Options.text('goal'),
    target: Options.text('target'),
  },
  ({ goal, target, title }) =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TicketStore;
        const ticket = yield* store.add({ title, goal, target });
        yield* Console.log(
          [
            `ticket: created ${ticket.id}`,
            `  title: ${ticket.title}`,
            `  target: ${ticket.target}`,
            `  state: ${ticket.state}`,
            'help[1]:',
            '  Run `tp ls` to list the backlog',
          ].join('\n'),
        );
      }),
    ),
);

const ticketCommand = Command.make('ticket', {}, () =>
  Console.log(
    [
      'ticket: pick a subcommand',
      'help[1]:',
      '  Run `tp ticket add --title "..." --goal "..." --target "<owner/repo>"`',
    ].join('\n'),
  ),
).pipe(Command.withSubcommands([addCommand]));

/**
 * The body of `tp run`, parameterised by `--watch` so the wiring is unit-testable
 * without the live stack:
 *   - watch:  run the always-on `reconcileForever` loop (the systemd daemon path).
 *             No demo seed — the box drives whatever real backlog the store holds.
 *   - oneshot: seed the slugify demo ticket (idempotent) and `settle` once, then
 *             print the backlog. The original local-dev behaviour, unchanged.
 */
export const runProgram = (
  watch: boolean,
): Effect.Effect<void, never, TicketStore | Forge | AgentWorker | AppConfig> =>
  Effect.gen(function* () {
    const store = yield* TicketStore;
    if (watch) {
      yield* reconcileForever();
      return;
    }
    const config = yield* AppConfig;
    const repo = config.targets[0].repo;
    const existing = yield* store.list();
    if (!existing.some((t) => t.title === 'add slugify')) {
      yield* store.add({ title: 'add slugify', goal: SEED_GOAL, target: repo });
    }
    yield* settle();
    const after = yield* store.list();
    yield* Console.log(renderTickets(after));
  });

/**
 * `tp run` — drive the reconciler against the live adapters. One-shot by default
 * (seed + settle to a fixpoint); `--watch` runs the forever loop for the daemon.
 */
const runCommand = Command.make('run', { watch: Options.boolean('watch') }, ({ watch }) =>
  Effect.scoped(
    runProgram(watch).pipe(
      Effect.provide(liveStack()),
      Effect.catchAll((e) =>
        Console.log(`error: tp run failed\n  reason: ${String(e)}`).pipe(
          Effect.zipRight(Effect.sync(() => process.exit(1))),
        ),
      ),
    ),
  ),
);

/** `tp doctor` — the terminal check. Exits 1 on FAIL so CI/agents can gate on it. */
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

// ── tp logs / tp transcript — the observability read path ────────────────────

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

/**
 * `tp logs <ticket>` / `tp logs --run <run_id>` — read the durable event stream.
 * The opencode transcript blob is excluded from the ticket view by default (it's
 * large); `tp transcript <run_id>` prints it. Scoping to `--run` shows everything.
 */
const logsCommand = Command.make(
  'logs',
  {
    ticket: Args.text({ name: 'ticket' }).pipe(Args.optional),
    run: Options.text('run').pipe(Options.optional),
  },
  ({ run, ticket }) =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TicketStore;
        if (Option.isSome(run)) {
          const decoded = decodeRunId(run.value);
          if (Either.isLeft(decoded))
            return yield* usageError(`not a run id: ${run.value}`, 'tp logs --run run_…');
          const events = yield* store.eventsFor({ runId: decoded.right });
          return yield* Console.log(renderEvents(events, `run ${run.value}`));
        }
        if (Option.isSome(ticket)) {
          const decoded = decodeTicketId(ticket.value);
          if (Either.isLeft(decoded))
            return yield* usageError(`not a ticket id: ${ticket.value}`, 'tp logs tckt_…');
          const all = yield* store.eventsFor({ ticketId: decoded.right });
          const shown = all.filter((e) => e.source !== 'opencode');
          const hidden = all.length - shown.length;
          const hints = [
            'help[2]:',
            ...(hidden > 0
              ? [`  ${hidden} opencode transcript event(s) hidden — run \`tp transcript <run_id>\``]
              : ['  Run `tp transcript <run_id>` to read an opencode transcript']),
            '  Run `tp logs --run <run_id>` to scope to a single run',
          ];
          return yield* Console.log(
            [renderEvents(shown, `ticket ${ticket.value}`), ...hints].join('\n'),
          );
        }
        return yield* usageError(
          'provide a ticket id or --run',
          'tp logs <ticket> | tp logs --run <run_id>',
        );
      }),
    ),
);

/** `tp transcript <run_id>` — parse the opencode capture for a run and pretty-print it. */
const transcriptCommand = Command.make(
  'transcript',
  { run: Args.text({ name: 'run_id' }) },
  ({ run }) =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TicketStore;
        const decoded = decodeRunId(run);
        if (Either.isLeft(decoded))
          return yield* usageError(`not a run id: ${run}`, 'tp transcript run_…');
        const events = yield* store.eventsFor({ runId: decoded.right, source: 'opencode' });
        if (events.length === 0)
          return yield* Console.log(`transcript: 0 transcript events found for run ${run}`);
        const blocks = events.map((e) => {
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

// ── tp trace / tp cost — the observability rollup path ───────────────────────

/**
 * `tp trace <ticket>` — reconstruct a ticket's lifecycle as a ts-ordered timeline
 * (phases + run events + inter-event durations) over the runs/run_events the
 * reconciler persisted. Definitive empty + not-found states.
 */
const traceCommand = Command.make(
  'trace',
  { ticket: Args.text({ name: 'ticket' }) },
  ({ ticket }) =>
    withStore(
      Effect.gen(function* () {
        const decoded = decodeTicketId(ticket);
        if (Either.isLeft(decoded))
          return yield* usageError(`not a ticket id: ${ticket}`, 'tp trace tckt_…');
        return yield* traceReport(decoded.right).pipe(
          Effect.flatMap(Console.log),
          Effect.catchTag('TicketNotFound', () => notFound(`ticket ${ticket}`, 'tp ls')),
        );
      }),
    ),
);

/**
 * `tp cost [<ticket>]` — aggregate token usage + wall-time per run / ticket /
 * model. Scoped to one ticket or, with no arg, across the whole backlog. Reports
 * tokens-only (no dollar cost until a price map exists).
 */
const costCommand = Command.make(
  'cost',
  { ticket: Args.text({ name: 'ticket' }).pipe(Args.optional) },
  ({ ticket }) =>
    withStore(
      Effect.gen(function* () {
        let scope = Option.none<TicketId>();
        if (Option.isSome(ticket)) {
          const decoded = decodeTicketId(ticket.value);
          if (Either.isLeft(decoded))
            return yield* usageError(`not a ticket id: ${ticket.value}`, 'tp cost tckt_…');
          scope = Option.some(decoded.right);
        }
        return yield* costReport(scope).pipe(
          Effect.flatMap(Console.log),
          Effect.catchTag('TicketNotFound', () =>
            notFound(`ticket ${Option.getOrElse(ticket, () => '')}`, 'tp ls'),
          ),
        );
      }),
    ),
);

const homeView = withStore(
  Effect.gen(function* () {
    const store = yield* TicketStore;
    const tickets = yield* store.list();
    yield* Console.log(
      [`bin: ${binPath()}`, `description: ${DESCRIPTION}`, renderTickets(tickets)].join('\n'),
    );
  }),
);

const root = Command.make('tp', {}, () => homeView).pipe(
  Command.withSubcommands([
    lsCommand,
    ticketCommand,
    runCommand,
    doctorCommand,
    logsCommand,
    transcriptCommand,
    traceCommand,
    costCommand,
  ]),
);

const cli = Command.run(root, { name: 'tp', version: '0.0.0' });

// Guard the runMain side effect so the module is importable by unit tests
// (e.g. `runProgram`) without launching the CLI.
if (import.meta.main) {
  const program = cli(process.argv).pipe(Effect.provide(BunContext.layer));
  // Structured JSON logs when not attached to a terminal (i.e. the in-cluster
  // control-plane daemon, where a log aggregator ingests stdout); keep the pretty
  // logger for interactive human use.
  if (process.stdout.isTTY) {
    BunRuntime.runMain(program);
  } else {
    BunRuntime.runMain(program.pipe(Effect.provide(Logger.json)), { disablePrettyLogger: true });
  }
}
