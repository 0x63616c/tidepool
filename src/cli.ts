#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect } from 'effect';
import type { Ticket } from './domain.ts';
import { InMemoryTicketStore } from './fakes.ts';
import { TicketStore } from './services.ts';

/**
 * `tp` — the control-plane CLI. Agent-facing (AXI): TOON output, content-first
 * home view, structured errors, definitive empty states. Wired to an in-memory
 * store for now (Phase A); the sqlite-backed store drops in behind the same tag.
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

const lsCommand = Command.make('ls', {}, () =>
  Effect.gen(function* () {
    const store = yield* TicketStore;
    const tickets = yield* store.list();
    yield* Console.log(renderTickets(tickets));
  }),
);

const addCommand = Command.make(
  'add',
  {
    title: Options.text('title'),
    goal: Options.text('goal'),
    target: Options.text('target'),
  },
  ({ goal, target, title }) =>
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

const doctorCommand = Command.make('doctor', {}, () => Console.log('doctor: not yet'));

const homeView = Effect.gen(function* () {
  const store = yield* TicketStore;
  const tickets = yield* store.list();
  yield* Console.log(
    [`bin: ${binPath()}`, `description: ${DESCRIPTION}`, renderTickets(tickets)].join('\n'),
  );
});

const root = Command.make('tp', {}, () => homeView).pipe(
  Command.withSubcommands([lsCommand, ticketCommand, doctorCommand]),
);

const cli = Command.run(root, { name: 'tp', version: '0.0.0' });

cli(process.argv).pipe(
  Effect.provide(InMemoryTicketStore),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
);
