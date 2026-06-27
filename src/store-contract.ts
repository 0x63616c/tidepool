import { assert, describe, it } from '@effect/vitest';
import { Effect, type Scope } from 'effect';
import type { TicketStoreApi } from './services.ts';

/**
 * Shared `TicketStore` contract. Any backing (Ref fake, sqlite) must satisfy the
 * SAME behaviours, so the suite is parameterised over a `StoreMedium` — a durable
 * medium that can be `open`ed repeatedly. Reopening models a process restart:
 * for the Ref fake `open` returns the one live store; for sqlite it reconnects to
 * the same file. Either way, data written before a reopen must survive it.
 */

export interface StoreMedium {
  /** Open a store over this medium. Repeated opens share the same durable state. */
  readonly open: Effect.Effect<TicketStoreApi, never, Scope.Scope>;
}

const newTicket = { title: 'Add slugify', goal: 'add slugify(s)', target: 't/repo' };

export const storeContract = (name: string, makeMedium: Effect.Effect<StoreMedium>): void => {
  describe(name, () => {
    it.effect('add → byId returns the stored ticket', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const medium = yield* makeMedium;
          const store = yield* medium.open;
          const created = yield* store.add(newTicket);
          const fetched = yield* store.byId(created.id);
          assert.deepStrictEqual(fetched, created);
        }),
      ),
    );
  });
};
