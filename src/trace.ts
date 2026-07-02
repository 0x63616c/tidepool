import { Effect, Option } from 'effect';
import type { Run, RunEvent, Ticket, TicketNotFound } from './domain.ts';
import type { TicketId } from './ids.ts';
import { TicketStore } from './services.ts';

/**
 * `tp trace` / `tp cost` — the read path over the data the reconciler already
 * persists (runs + run_events; tenet 1, one durable store). `trace` reconstructs
 * a ticket's lifecycle as a ts-ordered timeline with phase labels and inter-event
 * durations; `cost` rolls token usage up per run / ticket / model. Pure renderers
 * over the store seam — no Hetzner/opencode types leak in, and there are no prices
 * (we report tokens + wall-time only until a price map exists).
 *
 * Both return a ready-to-print TOON block (AXI): minimal schemas, definitive empty
 * states, contextual next-step hints. The CLI is a thin shell that logs the string.
 */

const PREVIEW = 120;

/** Collapse to one line, neutralise quotes, truncate with a definitive marker. */
const preview = (line: string): string => {
  const flat = line.replace(/\r?\n/g, ' ').replaceAll('"', "'");
  return flat.length > PREVIEW
    ? `${flat.slice(0, PREVIEW)}… (+${flat.length - PREVIEW} chars)`
    : flat;
};

/** Round to 3 dp so summed floats don't render as 0.30000000000000004. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ── trace ────────────────────────────────────────────────────────────────────

/**
 * Which lifecycle phase an event belongs to. Work-run captures are the
 * `in_progress` phase, review-run captures the `review` phase, and a
 * control-plane error is the `failed` transition. Events we can't attribute to a
 * run fall back to their raw source.
 */
const phaseOf = (e: RunEvent, runs: ReadonlyArray<Run>): string => {
  if (e.source === 'control-plane') return e.level === 'error' ? 'failed' : 'control-plane';
  const owner = e.runId === null ? undefined : runs.find((r) => r.id === e.runId);
  if (owner === undefined) return e.source;
  return owner.kind === 'work' ? 'in_progress' : 'review';
};

const renderRuns = (runs: ReadonlyArray<Run>): string => {
  if (runs.length === 0) return 'runs: 0 runs recorded';
  const rows = runs.map(
    (r) =>
      `  ${r.id},${r.kind},${r.boxId ?? '-'},${r.boxProvider ?? '-'},${r.usage.tokensIn},${r.usage.tokensOut},${r.usage.wallTimeSec}`,
  );
  return [
    `runs[${runs.length}]{run_id,kind,box_id,provider,tokens_in,tokens_out,wall_time_sec}:`,
    ...rows,
  ].join('\n');
};

const renderTimeline = (events: ReadonlyArray<RunEvent>, runs: ReadonlyArray<Run>): string => {
  if (events.length === 0) return 'timeline: 0 events recorded';
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  let prev: number | undefined;
  let first: number | undefined;
  let last = 0;
  const rows = sorted.map((e) => {
    const dt = prev === undefined ? 0 : e.ts - prev;
    prev = e.ts;
    if (first === undefined) first = e.ts;
    last = e.ts;
    return `  ${dt},${phaseOf(e, runs)},${e.source},${e.level ?? '-'},${e.runId ?? '-'},"${preview(e.line)}"`;
  });
  const span = last - (first ?? 0);
  return [
    `timeline[${sorted.length}]{dt_ms,phase,source,level,run,line}:`,
    ...rows,
    `span_ms: ${span}`,
  ].join('\n');
};

/** Pure trace renderer — reused by `tp ticket get` (fed from QueueControl data). */
export const renderTrace = (
  ticket: Ticket,
  runs: ReadonlyArray<Run>,
  events: ReadonlyArray<RunEvent>,
): string => {
  const head = [
    `trace: ticket ${ticket.id}`,
    `  state: ${ticket.state}`,
    `  attempts: ${ticket.attempts}`,
    `  reason: ${ticket.reason ?? '-'}`,
  ];
  if (runs.length === 0 && events.length === 0) {
    return [
      `trace: ticket ${ticket.id} has no runs or events yet`,
      `  state: ${ticket.state}`,
    ].join('\n');
  }
  return [
    ...head,
    renderRuns(runs),
    renderTimeline(events, runs),
    'help[2]:',
    `  Run \`tp ticket logs ${ticket.id}\` to read the raw event stream`,
    '  Run `tp ticket transcript <run_id>` to read an opencode transcript',
  ].join('\n');
};

/**
 * Reconstruct a ticket's lifecycle: its current state + recorded runs + the
 * ts-ordered event timeline with inter-event durations. Fails `TicketNotFound`
 * if the id isn't in the store.
 */
export const traceReport = Effect.fn('traceReport')(function* (ticketId: TicketId) {
  const store = yield* TicketStore;
  const ticket = yield* store.byId(ticketId);
  const runs = yield* store.runsFor(ticketId);
  const events = yield* store.eventsFor({ ticketId });
  return renderTrace(ticket, runs, events);
}) satisfies (id: TicketId) => Effect.Effect<string, TicketNotFound, TicketStore>;

// ── cost ───────────────────────────────────────────────────────────────────

interface Tally {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  wallTimeSec: number;
}

const emptyTally = (): Tally => ({ runs: 0, tokensIn: 0, tokensOut: 0, wallTimeSec: 0 });

const add = (t: Tally, r: Run): Tally => ({
  runs: t.runs + 1,
  tokensIn: t.tokensIn + r.usage.tokensIn,
  tokensOut: t.tokensOut + r.usage.tokensOut,
  wallTimeSec: t.wallTimeSec + r.usage.wallTimeSec,
});

const totalOf = (runs: ReadonlyArray<Run>): Tally => runs.reduce(add, emptyTally());

/** Group runs by model, preserving first-seen order. */
const byModel = (runs: ReadonlyArray<Run>): ReadonlyArray<readonly [string, Tally]> => {
  const order: string[] = [];
  const map = new Map<string, Tally>();
  for (const r of runs) {
    const key = r.usage.model;
    if (!map.has(key)) {
      map.set(key, emptyTally());
      order.push(key);
    }
    map.set(key, add(map.get(key) ?? emptyTally(), r));
  }
  return order.map((m) => [m, map.get(m) ?? emptyTally()] as const);
};

const COST_HEADER = 'cost: tokens-only — no price map configured (no dollar cost available)';

const tallyRow = (label: string, t: Tally): string =>
  `  ${label},${t.runs},${t.tokensIn},${t.tokensOut},${round3(t.wallTimeSec)}`;

const renderModels = (runs: ReadonlyArray<Run>): string => {
  const models = byModel(runs);
  return [
    `models[${models.length}]{model,runs,tokens_in,tokens_out,wall_time_sec}:`,
    ...models.map(([m, t]) => tallyRow(m, t)),
  ].join('\n');
};

const renderTotal = (t: Tally): string =>
  `total{runs,tokens_in,tokens_out,wall_time_sec}: ${t.runs},${t.tokensIn},${t.tokensOut},${round3(t.wallTimeSec)}`;

/** Pure per-ticket cost renderer — reused by `tp ticket get`. */
export const renderTicketCost = (ticketId: TicketId, runs: ReadonlyArray<Run>): string => {
  if (runs.length === 0) return `cost: ticket ${ticketId} has no runs yet`;
  const rows = runs.map(
    (r) =>
      `  ${r.id},${r.kind},${r.usage.model},${r.usage.tokensIn},${r.usage.tokensOut},${r.usage.wallTimeSec}`,
  );
  return [
    `${COST_HEADER}`,
    `  ticket: ${ticketId}`,
    `runs[${runs.length}]{run_id,kind,model,tokens_in,tokens_out,wall_time_sec}:`,
    ...rows,
    renderModels(runs),
    renderTotal(totalOf(runs)),
  ].join('\n');
};

interface TicketRuns {
  readonly ticket: TicketId;
  readonly runs: ReadonlyArray<Run>;
}

const renderGlobalCost = (perTicket: ReadonlyArray<TicketRuns>): string => {
  const withRuns = perTicket.filter((p) => p.runs.length > 0);
  const allRuns = perTicket.flatMap((p) => p.runs);
  if (allRuns.length === 0) {
    return `cost: 0 runs found (${perTicket.length} ticket(s), none have runs yet)`;
  }
  return [
    `${COST_HEADER}`,
    `tickets[${withRuns.length}]{ticket,runs,tokens_in,tokens_out,wall_time_sec}:`,
    ...withRuns.map((p) => tallyRow(p.ticket, totalOf(p.runs))),
    renderModels(allRuns),
    renderTotal(totalOf(allRuns)),
    'help[1]:',
    '  Run `tp ticket get <ticket>` to break a single ticket down by run',
  ].join('\n');
};

/**
 * Aggregate token usage + wall-time. Scoped to one ticket (per-run breakdown) or,
 * with `Option.none`, across the whole backlog (per-ticket + per-model rollup).
 * Never invents a dollar cost — there is no price map yet. Fails `TicketNotFound`
 * when a scoped ticket id isn't in the store.
 */
export const costReport = Effect.fn('costReport')(function* (scope: Option.Option<TicketId>) {
  const store = yield* TicketStore;
  if (Option.isSome(scope)) {
    const ticket = yield* store.byId(scope.value);
    const runs = yield* store.runsFor(ticket.id);
    return renderTicketCost(ticket.id, runs);
  }
  const tickets = yield* store.list();
  const perTicket = yield* Effect.forEach(tickets, (t) =>
    Effect.map(store.runsFor(t.id), (runs) => ({ ticket: t.id, runs })),
  );
  return renderGlobalCost(perTicket);
}) satisfies (scope: Option.Option<TicketId>) => Effect.Effect<string, TicketNotFound, TicketStore>;
