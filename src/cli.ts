#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Args, Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Either, Layer, Option, Schema } from 'effect';
import { AppConfig } from './config.ts';
import { renderDoctor, runDoctor } from './doctor.ts';
import type { RunEvent, Ticket } from './domain.ts';
import { RunId, TicketId } from './ids.ts';
import { settle } from './reconciler.ts';
import { AppConfigLive, LiveStack, SqliteTicketStore } from './runtime.ts';
import { TicketStore } from './services.ts';

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
  Effect.scoped(Effect.provide(effect, SqliteTicketStore));

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
 * `tp run` — seed the slugify ticket (idempotent) and drive the reconciler to a
 * fixpoint against the live adapters. Prints the resulting backlog.
 */
const runCommand = Command.make('run', {}, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const store = yield* TicketStore;
      const repo = config.targets[0].repo;
      const existing = yield* store.list();
      if (!existing.some((t) => t.title === 'add slugify')) {
        yield* store.add({ title: 'add slugify', goal: SEED_GOAL, target: repo });
      }
      yield* settle();
      const after = yield* store.list();
      yield* Console.log(renderTickets(after));
    }).pipe(
      Effect.provide(LiveStack),
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
      Effect.provide(Layer.merge(SqliteTicketStore, AppConfigLive)),
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
  ]),
);

const cli = Command.run(root, { name: 'tp', version: '0.0.0' });

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
