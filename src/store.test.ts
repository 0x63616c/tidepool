import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { makeInMemoryStore } from './fakes.ts';
import { makeSqliteStore } from './sqlite-store.ts';
import { type StoreMedium, storeContract } from './store-contract.ts';

/**
 * The locked `TicketStore` contract, run against BOTH backings: the Ref fake and
 * the real sqlite store. Same behaviours, same assertions — the only difference
 * is durability, which the reopen test exercises directly.
 */

const inMemoryMedium = Effect.gen(function* () {
  const store = yield* makeInMemoryStore;
  return { open: Effect.succeed(store) } satisfies StoreMedium;
});

const sqliteMedium = Effect.sync(() => {
  const path = join(tmpdir(), `tp-store-${Math.random().toString(36).slice(2)}.sqlite`);
  return { open: makeSqliteStore(path) } satisfies StoreMedium;
});

storeContract('InMemoryStore', inMemoryMedium);
storeContract('SqliteStore', sqliteMedium);
