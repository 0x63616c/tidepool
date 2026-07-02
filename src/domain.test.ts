import { assert, describe, it } from '@effect/vitest';
import { Either, Schema } from 'effect';
import {
  AgentFailed,
  BoxFailed,
  ForgeError,
  isTerminal,
  MergeConflict,
  RateCapped,
  Run,
  RunEvent,
  Ticket,
  TicketNotFound,
  type TicketState,
  Usage,
} from './domain.ts';

/**
 * Characterization of the domain model: which states are terminal, what the
 * Usage/Ticket/Run schemas accept and reject, and that the typed errors carry
 * the fields the reconciler reads off them.
 */

describe('isTerminal', () => {
  const terminal: ReadonlyArray<TicketState> = ['done', 'failed'];
  const live: ReadonlyArray<TicketState> = ['backlog', 'in_progress', 'review', 'rate_capped'];

  for (const s of terminal) {
    it(`${s} is terminal`, () => assert.isTrue(isTerminal(s)));
  }
  for (const s of live) {
    it(`${s} is not terminal`, () => assert.isFalse(isTerminal(s)));
  }
});

describe('Usage schema', () => {
  const valid = { model: 'm', tokensIn: 10, tokensOut: 5, wallTimeSec: 1 };

  it('decodes a valid usage record', () => {
    assert.isTrue(Either.isRight(Schema.decodeUnknownEither(Usage)(valid)));
  });

  it('rejects negative tokensIn', () => {
    assert.isTrue(Either.isLeft(Schema.decodeUnknownEither(Usage)({ ...valid, tokensIn: -1 })));
  });

  it('rejects a non-integer token count', () => {
    assert.isTrue(Either.isLeft(Schema.decodeUnknownEither(Usage)({ ...valid, tokensOut: 1.5 })));
  });
});

const validTicket = {
  id: 'tckt_abcdefghij',
  title: 't',
  body: 'g',
  target: 'r/repo',
  state: 'backlog',
  branch: null,
  prNumber: null,
  prId: null,
  mergeSha: null,
  attempts: 0,
  workedAttempt: null,
  reason: null,
  workHandle: null,
  dispatchedAt: null,
};

describe('Ticket schema', () => {
  it('decodes a valid ticket', () => {
    assert.isTrue(Either.isRight(Schema.decodeUnknownEither(Ticket)(validTicket)));
  });

  it('rejects an unknown state literal', () => {
    assert.isTrue(
      Either.isLeft(Schema.decodeUnknownEither(Ticket)({ ...validTicket, state: 'merging' })),
    );
  });

  it('rejects a malformed id', () => {
    assert.isTrue(
      Either.isLeft(Schema.decodeUnknownEither(Ticket)({ ...validTicket, id: 'nope_abcdefghij' })),
    );
  });

  it('rejects negative attempts', () => {
    assert.isTrue(
      Either.isLeft(Schema.decodeUnknownEither(Ticket)({ ...validTicket, attempts: -1 })),
    );
  });

  it('accepts a non-null reason', () => {
    assert.isTrue(
      Either.isRight(Schema.decodeUnknownEither(Ticket)({ ...validTicket, reason: 'rate-capped' })),
    );
  });
});

describe('RunEvent schema', () => {
  const validEvent = {
    ticketId: 'tckt_abcdefghij',
    runId: 'run_abcdefghij',
    boxId: 'box_abcdefghij',
    source: 'opencode',
    ts: 1700000000000,
    level: null,
    line: '{"type":"message"}',
  };

  it('decodes a valid event (null run/box/level allowed)', () => {
    assert.isTrue(Either.isRight(Schema.decodeUnknownEither(RunEvent)(validEvent)));
    assert.isTrue(
      Either.isRight(
        Schema.decodeUnknownEither(RunEvent)({
          ...validEvent,
          runId: null,
          boxId: null,
          source: 'control-plane',
          level: 'error',
        }),
      ),
    );
  });

  it('rejects an unknown source', () => {
    assert.isTrue(
      Either.isLeft(Schema.decodeUnknownEither(RunEvent)({ ...validEvent, source: 'syslog' })),
    );
  });

  it('rejects an unknown level', () => {
    assert.isTrue(
      Either.isLeft(Schema.decodeUnknownEither(RunEvent)({ ...validEvent, level: 'fatal' })),
    );
  });
});

describe('Run schema', () => {
  const validRun = {
    id: 'run_abcdefghij',
    ticketId: 'tckt_abcdefghij',
    kind: 'work',
    status: 'succeeded',
    reason: null,
    dispatchedAt: 100,
    finishedAt: 200,
    boxId: null,
    boxProvider: null,
    usage: { model: 'm', tokensIn: 10, tokensOut: 5, wallTimeSec: 1 },
  };

  it('decodes a valid run', () => {
    assert.isTrue(Either.isRight(Schema.decodeUnknownEither(Run)(validRun)));
  });

  it('rejects an unknown kind', () => {
    assert.isTrue(Either.isLeft(Schema.decodeUnknownEither(Run)({ ...validRun, kind: 'deploy' })));
  });
});

describe('typed errors carry their fields', () => {
  it('ForgeError carries op + reason', () => {
    const e = new ForgeError({ op: 'merge', reason: 'boom' });
    assert.strictEqual(e._tag, 'ForgeError');
    assert.strictEqual(e.op, 'merge');
    assert.strictEqual(e.reason, 'boom');
  });

  it('MergeConflict carries prNumber', () => {
    const e = new MergeConflict({ prNumber: 7 });
    assert.strictEqual(e._tag, 'MergeConflict');
    assert.strictEqual(e.prNumber, 7);
  });

  it('TicketNotFound carries id', () => {
    const e = new TicketNotFound({ id: 'tckt_abcdefghij' });
    assert.strictEqual(e._tag, 'TicketNotFound');
    assert.strictEqual(e.id, 'tckt_abcdefghij');
  });

  it('RateCapped carries an optional retryAfterSec', () => {
    assert.strictEqual(new RateCapped({}).retryAfterSec, undefined);
    assert.strictEqual(new RateCapped({ retryAfterSec: 30 }).retryAfterSec, 30);
  });

  it('AgentFailed and BoxFailed carry reason', () => {
    assert.strictEqual(new AgentFailed({ reason: 'crash' }).reason, 'crash');
    assert.strictEqual(new BoxFailed({ reason: 'capacity' }).reason, 'capacity');
  });
});
