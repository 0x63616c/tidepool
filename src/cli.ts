#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Layer } from 'effect';
import { AppConfig } from './config.ts';
import { renderDoctor, runDoctor } from './doctor.ts';
import type { Ticket } from './domain.ts';
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
  Command.withSubcommands([lsCommand, ticketCommand, runCommand, doctorCommand]),
);

const cli = Command.run(root, { name: 'tp', version: '0.0.0' });

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
