import { assert, describe, it } from '@effect/vitest';
import { Either, Schema } from 'effect';
import { BoxId, newBoxId, newPrId, newRunId, newTicketId, PrId, RunId, TicketId } from './ids.ts';

/**
 * Characterization of the id module's public contract: every generated id is a
 * lowercase base36 `<prefix>_<10 chars>` string, each constructor stamps its own
 * prefix, the brand schema rejects malformed/uppercase ids, and ids are unique.
 */

describe('ids', () => {
  const cases = [
    { prefix: 'tckt', make: newTicketId, schema: TicketId },
    { prefix: 'run', make: newRunId, schema: RunId },
    { prefix: 'box', make: newBoxId, schema: BoxId },
    { prefix: 'pr', make: newPrId, schema: PrId },
  ] as const;

  for (const { prefix, make } of cases) {
    it(`${prefix} ids match ^${prefix}_[0-9a-z]{10}$ (lowercase base36)`, () => {
      const id = make();
      assert.match(id, new RegExp(`^${prefix}_[0-9a-z]{10}$`));
    });
  }

  it('each constructor stamps its own prefix', () => {
    assert.isTrue(newTicketId().startsWith('tckt_'));
    assert.isTrue(newRunId().startsWith('run_'));
    assert.isTrue(newBoxId().startsWith('box_'));
    assert.isTrue(newPrId().startsWith('pr_'));
  });

  it('the brand schema rejects an id with the wrong prefix', () => {
    assert.isTrue(Either.isLeft(Schema.decodeUnknownEither(TicketId)('run_abcdefghij')));
  });

  it('the brand schema rejects an uppercase suffix (not base36)', () => {
    assert.isTrue(Either.isLeft(Schema.decodeUnknownEither(TicketId)('tckt_ABCDEFGHIJ')));
  });

  it('the brand schema rejects a wrong-length suffix', () => {
    assert.isTrue(Either.isLeft(Schema.decodeUnknownEither(TicketId)('tckt_abc')));
  });

  it('the brand schema accepts a well-formed id', () => {
    assert.isTrue(Either.isRight(Schema.decodeUnknownEither(TicketId)('tckt_abcdefghij')));
  });

  it('ids are unique across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newTicketId()));
    assert.strictEqual(ids.size, 100);
  });
});
