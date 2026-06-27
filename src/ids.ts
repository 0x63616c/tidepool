import { Schema } from 'effect';
import { customAlphabet } from 'nanoid';

/**
 * Stripe-style prefixed identifiers: `<prefix>_<base62 suffix>`.
 * The same id is the sqlite PK, the CLI display value, and threads through
 * branch / PR / commit. Generation is centralised here; callers never build ids.
 */

// Lowercase base36 — must match the binding mechanical gates (commitlint
// headerPattern + branch convention both allow `tckt_[0-9a-z]+` only). Mixed-case
// ids would fail their own commit/branch gate, so the alphabet is lowercase.
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const suffix = customAlphabet(BASE36, 10);

const branded = <P extends string, B extends string>(prefix: P, brand: B) => {
  const schema = Schema.String.pipe(
    Schema.pattern(new RegExp(`^${prefix}_[0-9a-z]{10}$`)),
    Schema.brand(brand),
  );
  const decode = Schema.decodeSync(schema);
  const make = () => decode(`${prefix}_${suffix()}`);
  return { schema, make };
};

const ticket = branded('tckt', 'TicketId');
const run = branded('run', 'RunId');
const box = branded('box', 'BoxId');
const lease = branded('lease', 'LeaseId');
const pr = branded('pr', 'PrId');

export const TicketId = ticket.schema;
export type TicketId = typeof TicketId.Type;
export const RunId = run.schema;
export type RunId = typeof RunId.Type;
export const BoxId = box.schema;
export type BoxId = typeof BoxId.Type;
export const LeaseId = lease.schema;
export type LeaseId = typeof LeaseId.Type;
export const PrId = pr.schema;
export type PrId = typeof PrId.Type;

export const newTicketId = ticket.make;
export const newRunId = run.make;
export const newBoxId = box.make;
export const newLeaseId = lease.make;
export const newPrId = pr.make;
