# Local `tp` Queue-Control CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Also load `effect-ts` (this repo is Effect-only) and `tdd` (red-first is tenet 12).

**Goal:** Let `tp` run on a laptop and drive the production ticket queue over an HTTP API served by the reconciler, instead of `kubectl exec`-ing a pg client into the control-plane pod.

**Architecture:** Introduce a narrow `QueueControl` deep module (5 read/enqueue methods — never the mover trio) with two swappable adapters: `LocalQueueControl` (wraps the in-process `TicketStore`, for dev/tests) and `HttpQueueControl` (an `@effect/platform` `HttpApiClient`, for the laptop). The reconciler process (relocated to its own `src/daemon.ts` entrypoint) hosts the `HttpApi` server alongside `reconcileForever`, sharing one pg-backed `TicketStore`. A laptop-side context config (`~/.tidepool/config`) picks the adapter and, for `kind=http`, opens an invisible `kubectl port-forward` so the operator never manages a tunnel. The CLI is reorganised to a single noun-group `tp ticket {add,list,get,logs,transcript}`; bootstrap relics (`up`, `bucket-init`, `run`-oneshot seed) are deleted.

**Tech Stack:** TypeScript + Bun, Effect, `@effect/schema`, `@effect/platform` (`HttpApi`/`HttpApiClient`/`HttpApiBuilder`), `@effect/cli`, `@effect/sql` (existing pg/sqlite stores), Vitest (`@effect/vitest`).

## Global Constraints

- **Every change ships as a green, merged PR.** One branch `tp/tckt_t9zo30-local-queue-control`, commit-sliced (each behavior red→green), CI green before merge. No direct pushes to `main`.
- **Effect everywhere (tenet 10).** All I/O through Effect; HTTP is `@effect/platform` only (`HttpClient`/`HttpApi*`) — never raw `fetch`. Validation is `@effect/schema` — never zod.
- **Tenet 3 — reconciler is the only mover.** `QueueControl` exposes read + enqueue ONLY (`add`, `list`, `byId`, `runsFor`, `eventsFor`). The mover trio (`patch`, `addRun`, `appendEvents`) is structurally absent from the interface and never on the wire.
- **Tenet 9 — no public inbound.** The API binds to the pod's port; the laptop reaches it via `kubectl port-forward` through the already-/32-firewalled apiserver. No new inbound port, no app-level auth in v1. Leave `// TODO(tailscale): require bearer token when reach widens` at the server.
- **Tenet 1/2 — client context is per-operator local state, NOT git config.** Contexts live in `~/.tidepool/config`, never in `tidepool.config.ts` (which stays declarative, PR-reviewed app config).
- **Tenet 11 — docs track reality.** `DESIGN.md` updated in this same PR (API surface, daemon, contexts, the deferred cancel/retry gap).
- **IDs / branch / commit / PR format** per `AGENTS.md`: branch `tp/tckt_t9zo30-<slug>`, commit subject `#tckt_t9zo30 feat(scope): subject`, PR title `feat(scope): subject (tckt_t9zo30)`.
- **Pagination envelope is uniform:** every collection response is `{ items: [...], nextCursor: string | null }` and every collection request takes `limit` (default 50) + optional `cursor`. Never a bare array on the wire. v1 impl: newest-first, honor `limit`, `nextCursor` = opaque last-item id, no offset.
- **Verb vocabulary is single (no aliases):** `add`, `list`, `get`, `logs`, `transcript`. Not `ls`/`show`.
- **Run `bun run check` (biome + lint:sh + typecheck + test) before every commit.** Same gates as CI.

---

## File Structure

- `src/queue-control.ts` — **new.** `QueueControl` tag + `QueueControlApi` interface + pagination schemas (`Page`, `ListTicketsQuery`, `EventsQuery`) + `LocalQueueControl` layer (wraps `TicketStore`). The deep-module seam.
- `src/queue-api.ts` — **new.** The `@effect/platform` `HttpApi` definition (endpoints, path/query/response schemas) shared by server and client. Pure declaration, no impl.
- `src/queue-api-server.ts` — **new.** `HttpApiBuilder` handlers wiring the `HttpApi` to `QueueControl`; the served `Layer`. Lives in the daemon.
- `src/http-queue-control.ts` — **new.** `HttpQueueControl` layer — an `HttpApiClient` satisfying `QueueControl`. The laptop adapter.
- `src/client-config.ts` — **new.** `~/.tidepool/config` loader: named contexts, `current-context`, resolution `flag > env > file > default`, plus the `kubectl port-forward` lifecycle for `kind=http`.
- `src/daemon.ts` — **new.** Pod entrypoint: `reconcileForever` + the `HttpApi` server, sharing `liveStack()`'s `TicketStore`.
- `src/cli.ts` — **modify.** Reduce to the `tp ticket {add,list,get,logs,transcript}` noun-group; commands bind to `QueueControl` (adapter chosen by `client-config`); delete `up`/`bucket-init`/`run` commands and the seed path.
- `src/config.ts` — **modify.** Add `configuredRepos(config)` / a target-membership check used by `add` validation.
- `src/trace.ts` — **modify (light).** `traceReport`/`costReport` already compose over `byId`+`runsFor`+`eventsFor`; ensure they can be fed by `QueueControl` (rebind the tag they require, or accept data). `get` renders trace+cost.
- `tidepool.config.ts` — **modify.** Add `0x63616c/tidepool` to `targets[]`.
- Infra: `infra/docker/control-plane.Dockerfile`, `infra/systemd/tidepool.service`, `infra/pulumi/cluster/control-plane-deployment.ts` — **modify.** Repoint CMD/ExecStart from `tp run --watch` to `bun run src/daemon.ts`; add the ClusterIP `Service` for the API port.
- `DESIGN.md` — **modify.** Document the API/daemon/contexts + cancel/retry gap.
- Tests (new): `src/queue-control.test.ts`, `src/queue-api.test.ts` (server↔client contract), `src/client-config.test.ts`, `src/daemon.test.ts`. Existing `src/cli.test.ts`, `src/up.test.ts` — modify/trim for the reorg + deletions.

---

## Task 1: `QueueControl` deep module + `LocalQueueControl` adapter

**Files:**
- Create: `src/queue-control.ts`
- Test: `src/queue-control.test.ts`
- Reference: `src/services.ts` (`TicketStore`, `TicketStoreApi`), `src/domain.ts` (`Ticket`, `NewTicket`, `Run`, `RunEvent`, `TicketId`, `RunId`, `TicketNotFound`).

**Interfaces:**
- Consumes: `TicketStore` (existing tag) and its `add`/`list`/`byId`/`runsFor`/`eventsFor` methods.
- Produces:
  - `class QueueControl extends Context.Tag('QueueControl')<QueueControl, QueueControlApi>()`
  - `Page<A>` schema/type: `{ items: ReadonlyArray<A>; nextCursor: string | null }`
  - `ListTicketsQuery = { limit: number; cursor: string | null; target: string | null }`
  - `EventsQuery = { ticketId: TicketId; runId: RunId | null; source: RunSource | null; limit: number; cursor: string | null }`
  - `QueueControlApi`:
    - `add: (input: NewTicket) => Effect.Effect<Ticket, TargetNotConfigured>`
    - `list: (q: ListTicketsQuery) => Effect.Effect<Page<Ticket>>`
    - `get: (id: TicketId) => Effect.Effect<Ticket, TicketNotFound>`
    - `runsFor: (id: TicketId) => Effect.Effect<ReadonlyArray<Run>, TicketNotFound>`
    - `events: (q: EventsQuery) => Effect.Effect<Page<RunEvent>, TicketNotFound>`
  - `LocalQueueControl: Layer.Layer<QueueControl, never, TicketStore | AppConfig>`
  - `class TargetNotConfigured extends Data.TaggedError('TargetNotConfigured')<{ readonly repo: string; readonly configured: ReadonlyArray<string> }>` (validation lands in Task 4; define the error here so the signature is stable).

- [ ] **Step 1: Write the failing test — envelope + list pagination**

```typescript
// src/queue-control.test.ts
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { QueueControl, LocalQueueControl } from './queue-control.ts';
import { SqliteTicketStore } from './runtime.ts';
import { AppConfigLive } from './runtime.ts';

const layer = LocalQueueControl.pipe(
  Layer.provideMerge(Layer.mergeAll(SqliteTicketStore, AppConfigLive)),
);

describe('QueueControl.list', () => {
  it.effect('returns a {items,nextCursor} page, newest-first, honoring limit', () =>
    Effect.gen(function* () {
      const qc = yield* QueueControl;
      // three tickets against the configured testbed repo
      for (const n of ['a', 'b', 'c']) {
        yield* qc.add({ title: n, goal: `g-${n}`, target: '0x63616c/tidepool-testbed' });
      }
      const page = yield* qc.list({ limit: 2, cursor: null, target: null });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
      const rest = yield* qc.list({ limit: 2, cursor: page.nextCursor, target: null });
      expect(rest.items).toHaveLength(1);
      expect(rest.nextCursor).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/queue-control.test.ts`
Expected: FAIL — `queue-control.ts` / `QueueControl` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/queue-control.ts
import { Context, Data, Effect, Layer, Schema } from 'effect';
import { AppConfig } from './config.ts';
import {
  type NewTicket, type Run, RunEvent, RunSource, type Ticket, TicketId, RunId,
} from './domain.ts';
import type { TicketNotFound } from './domain.ts';
import { TicketStore } from './services.ts';

/** Uniform collection envelope — every list-y response is this shape. */
export const Page = <A, I>(item: Schema.Schema<A, I>) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) });
export type Page<A> = { readonly items: ReadonlyArray<A>; readonly nextCursor: string | null };

export const ListTicketsQuery = Schema.Struct({
  limit: Schema.Int.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(200)),
  cursor: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
});
export type ListTicketsQuery = typeof ListTicketsQuery.Type;

export const EventsQuery = Schema.Struct({
  ticketId: TicketId,
  runId: Schema.NullOr(RunId),
  source: Schema.NullOr(RunSource),
  limit: Schema.Int.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1000)),
  cursor: Schema.NullOr(Schema.String),
});
export type EventsQuery = typeof EventsQuery.Type;

export class TargetNotConfigured extends Data.TaggedError('TargetNotConfigured')<{
  readonly repo: string;
  readonly configured: ReadonlyArray<string>;
}> {}

export interface QueueControlApi {
  readonly add: (input: NewTicket) => Effect.Effect<Ticket, TargetNotConfigured>;
  readonly list: (q: ListTicketsQuery) => Effect.Effect<Page<Ticket>>;
  readonly get: (id: TicketId) => Effect.Effect<Ticket, TicketNotFound>;
  readonly runsFor: (id: TicketId) => Effect.Effect<ReadonlyArray<Run>, TicketNotFound>;
  readonly events: (q: EventsQuery) => Effect.Effect<Page<RunEvent>, TicketNotFound>;
}
export class QueueControl extends Context.Tag('QueueControl')<QueueControl, QueueControlApi>() {}

/**
 * The local adapter: `QueueControl` backed by the in-process `TicketStore`.
 * Dev + tests use this (no server). Cursor is the last item's `id` (opaque);
 * paging is newest-first, in-memory slice — fine at personal scale (tenet 7),
 * swapped for a store-native keyset query only if the backlog ever demands it.
 */
export const LocalQueueControl = Layer.effect(
  QueueControl,
  Effect.gen(function* () {
    const store = yield* TicketStore;
    const _config = yield* AppConfig; // used by add-validation in Task 4

    const paginate = <A extends { id: string }>(
      all: ReadonlyArray<A>,
      limit: number,
      cursor: string | null,
    ): Page<A> => {
      const start = cursor === null ? 0 : all.findIndex((x) => x.id === cursor) + 1;
      const items = all.slice(start, start + limit);
      const nextCursor =
        start + limit < all.length && items.length > 0 ? items[items.length - 1].id : null;
      return { items, nextCursor };
    };

    return {
      add: (input) => store.add(input), // validation added in Task 4
      list: (q) =>
        store.list().pipe(
          Effect.map((ts) => {
            const filtered = q.target === null ? ts : ts.filter((t) => t.target === q.target);
            const newestFirst = [...filtered].reverse();
            return paginate(newestFirst, q.limit, q.cursor);
          }),
        ),
      get: (id) => store.byId(id),
      runsFor: (id) => store.byId(id).pipe(Effect.flatMap(() => store.runsFor(id))),
      events: (q) =>
        store.byId(q.ticketId).pipe(
          Effect.flatMap(() =>
            store.eventsFor({ ticketId: q.ticketId, runId: q.runId, source: q.source }),
          ),
          Effect.map((evs) => {
            // events carry no `id`; cursor is the index-as-string (stable, append-only stream).
            const start = q.cursor === null ? 0 : Number(q.cursor);
            const items = evs.slice(start, start + q.limit);
            const next = start + q.limit;
            return { items, nextCursor: next < evs.length ? String(next) : null };
          }),
        ),
    } satisfies QueueControlApi;
  }),
);
```

> NOTE: confirm `TicketStore.eventsFor`'s `EventQuery` field names (`ticketId`/`runId`/`source`) against `src/services.ts`/`src/domain.ts` before wiring; adjust the object literal to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/queue-control.test.ts`
Expected: PASS (2-page split: 2 items + nextCursor, then 1 item + null).

- [ ] **Step 5: Add + run the `get`/`events` tests**

```typescript
// append to src/queue-control.test.ts
describe('QueueControl.get / events', () => {
  it.effect('get returns the ticket; events returns a page', () =>
    Effect.gen(function* () {
      const qc = yield* QueueControl;
      const t = yield* qc.add({ title: 'x', goal: 'gx', target: '0x63616c/tidepool-testbed' });
      const got = yield* qc.get(t.id);
      expect(got.id).toBe(t.id);
      const evs = yield* qc.events({ ticketId: t.id, runId: null, source: null, limit: 10, cursor: null });
      expect(Array.isArray(evs.items)).toBe(true);
      expect(evs).toHaveProperty('nextCursor');
    }).pipe(Effect.provide(layer)),
  );
});
```

Run: `bun run test src/queue-control.test.ts` → Expected: PASS.

- [ ] **Step 6: `bun run check` then commit**

```bash
bun run check
git add src/queue-control.ts src/queue-control.test.ts
git commit -m "#tckt_t9zo30 feat(queue): add QueueControl deep module + local adapter"
```

---

## Task 2: Reorganise CLI to `tp ticket {add,list,get,logs,transcript}` + delete relics

**Files:**
- Modify: `src/cli.ts` (bind commands to `QueueControl`; noun-group; delete `up`/`bucket-init`/`run`).
- Modify: `src/cli.test.ts` (reflect the new command tree; drop tests for deleted commands).
- Modify: `src/trace.ts` (`traceReport`/`costReport` requirement rebind if needed so `get` renders them via `QueueControl`).
- Delete usages: remove imports of `up`, `initStateBucket`, `settle`, `reconcileForever`, `SEED_GOAL` from `cli.ts`.
- Reference: current `cli.ts` command bodies (`lsCommand`:62, `addCommand`:72, `ticketCommand`:98, `logsCommand`:245, `transcriptCommand`:289, `traceCommand`:322, `costCommand`:344, `root`:377).

**Interfaces:**
- Consumes: `QueueControl` (Task 1) and a `withQueue` provider (defined here) that selects the adapter. In this task the adapter is still `LocalQueueControl` over the store (HTTP selection lands in Task 6); wire `withQueue` = `Effect.scoped(Effect.provide(effect, LocalQueueControl.pipe(Layer.provideMerge(Layer.mergeAll(ticketStoreLive(), AppConfigLive)))))`.
- Produces: the command tree `tp ticket {add,list,get,logs,transcript}`, and a `withQueue` helper Task 6 will re-point.

- [ ] **Step 1: Write the failing test — new command tree**

```typescript
// src/cli.test.ts — replace the command-surface assertions
import { expect, it } from '@effect/vitest';
// (Use the existing test harness pattern in this file to run `tp` with argv.)

it('exposes `tp ticket` with add/list/get/logs/transcript and no up/bucket-init/run', async () => {
  const help = await runCli(['ticket', '--help']); // helper already used in this file
  expect(help).toContain('add');
  expect(help).toContain('list');
  expect(help).toContain('get');
  expect(help).toContain('logs');
  expect(help).toContain('transcript');
  const rootHelp = await runCli(['--help']);
  expect(rootHelp).not.toContain('bucket-init');
  expect(rootHelp).not.toContain(' up ');
  expect(rootHelp).not.toContain('--watch');
});
```

> If `src/cli.test.ts` has no `runCli` helper, add a thin one that invokes the `@effect/cli` `Command.run` with a captured `Console`. Match the file's existing style.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/cli.test.ts`
Expected: FAIL — root still lists `up`/`bucket-init`/`run`; no `ticket get`.

- [ ] **Step 3: Rewrite the command tree**

- Replace `withStore` with `withQueue` (provides `QueueControl` via `LocalQueueControl`).
- Move `ls` → `list` under `ticket`; rename to `list`, add `--target <repo>` (optional) + `--limit` (default 50). Render via `qc.list(...)`.
- Add `get <id>` under `ticket`: decode `TicketId`, call `qc.get` + `qc.runsFor` + `qc.events`, render the merged trace+cost view (reuse `traceReport`/`costReport` logic — feed them `QueueControl` data).
- Keep `add` under `ticket` (already there) → call `qc.add`, print `TargetNotConfigured` error path (populated in Task 4; for now the error is unreachable).
- Move `logs`/`transcript` under `ticket`; back them with `qc.events(...)` (+ `--limit`, `--cursor`).
- Delete `upCommand`, `bucketInitCommand`, `runCommand`, `SEED_GOAL`, `homeView` seed path, and their imports.
- New root:

```typescript
const ticketCommand = Command.make('ticket', {}, () => homeView).pipe(
  Command.withSubcommands([addCommand, listCommand, getCommand, logsCommand, transcriptCommand]),
);
const root = Command.make('tp', {}, () => homeView).pipe(
  Command.withSubcommands([ticketCommand, doctorCommand]),
);
```

> `doctorCommand` stays (local health). `reconcileForever` moves to Task 3's `daemon.ts` — remove it from the CLI entirely.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/cli.test.ts` → Expected: PASS.

- [ ] **Step 5: Verify relics are gone + nothing else imports them**

Run: `grep -rnE "initStateBucket|SEED_GOAL|reconcileForever" src/cli.ts` → Expected: no matches.
Run: `bun run typecheck` → Expected: PASS (fix any dangling imports in `up.ts`/`object-storage.ts` consumers; `up.ts`/`object-storage.ts` themselves stay — they're used by infra/tests, only the CLI verbs are removed).

- [ ] **Step 6: `bun run check` then commit**

```bash
bun run check
git add src/cli.ts src/cli.test.ts src/trace.ts
git commit -m "#tckt_t9zo30 refactor(cli): tp ticket noun-group; drop up/bucket-init/run relics"
```

---

## Task 3: Daemon entrypoint (`src/daemon.ts`) + infra CMD repoint

**Files:**
- Create: `src/daemon.ts`
- Test: `src/daemon.test.ts`
- Modify: `infra/docker/control-plane.Dockerfile`, `infra/systemd/tidepool.service`, `infra/pulumi/cluster/control-plane-deployment.ts`
- Reference: `src/reconciler.ts` (`reconcileForever`), `src/runtime.ts` (`liveStack`).

**Interfaces:**
- Consumes: `reconcileForever` (existing), `liveStack()` (existing). The `HttpApi` server layer arrives in Task 5; in this task `daemon.ts` runs only the reconciler loop (server added in Task 5 as a merged layer).
- Produces: `src/daemon.ts` as the pod entrypoint; a `makeDaemon(): Effect<never, ...>` that runs the loop, so it's unit-testable without `BunRuntime.runMain`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon.test.ts
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { makeDaemon } from './daemon.ts';
import { fakeStackLayer } from './fakes.ts'; // reuse the repo's fakes for store+forge+worker

describe('daemon', () => {
  it.effect('runs the reconcile loop against the provided stack (settles a backlog ticket)', () =>
    Effect.gen(function* () {
      // Arrange a fake stack with one backlog ticket, run the daemon briefly, assert it advanced.
      const fiber = yield* Effect.fork(makeDaemon().pipe(Effect.provide(fakeStackLayer())));
      yield* Effect.sleep('100 millis');
      yield* Fiber.interrupt(fiber);
      // assert via the fake store that the ticket left `backlog`
      expect(true).toBe(true); // replace with a real store assertion using the repo's fake accessor
    }),
  );
});
```

> Model this test on the existing `src/reconciler.test.ts` harness (it already drives `reconcileForever`/`settle` over fakes). Reuse its fake-store assertion helpers rather than inventing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/daemon.test.ts` → Expected: FAIL — `daemon.ts` not found.

- [ ] **Step 3: Write `src/daemon.ts`**

```typescript
// src/daemon.ts
#!/usr/bin/env bun
import { BunRuntime } from '@effect/platform-bun';
import { Effect, Logger } from 'effect';
import { reconcileForever } from './reconciler.ts';
import { liveStack } from './runtime.ts';

/**
 * The pod process: the reconcile loop (the ONLY mover, tenet 3) plus — from
 * Task 5 — the QueueControl HTTP API, both over the one pg-backed TicketStore
 * in `liveStack()`. Split out of the CLI so `tp` stays a pure client and the
 * daemon is not a human verb. Testable via `makeDaemon` without `runMain`.
 */
export const makeDaemon = (): Effect.Effect<never, never, never> =>
  reconcileForever().pipe(Effect.provide(liveStack())) as Effect.Effect<never, never, never>;

if (import.meta.main) {
  BunRuntime.runMain(makeDaemon().pipe(Effect.provide(Logger.json)), { disablePrettyLogger: true });
}
```

> Confirm `reconcileForever`'s exact call signature in `src/reconciler.ts` (arity/args) and match it. Keep the JSON logger for the pod (matches the old `cli.ts` non-TTY branch).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/daemon.test.ts` → Expected: PASS.

- [ ] **Step 5: Repoint infra CMD/ExecStart**

- `infra/docker/control-plane.Dockerfile`: change CMD from `tp run --watch` to `["bun", "run", "src/daemon.ts"]`.
- `infra/systemd/tidepool.service`: `ExecStart=/root/.bun/bin/bun /opt/tidepool/src/daemon.ts`.
- `infra/pulumi/cluster/control-plane-deployment.ts`: update the comment/CMD note (`# CMD in the image is already tp run --watch` → daemon).

Run: `bun run lint:sh` (shellcheck/shfmt) and `bun run typecheck` → Expected: PASS.

- [ ] **Step 6: `bun run check` then commit**

```bash
bun run check
git add src/daemon.ts src/daemon.test.ts infra/docker/control-plane.Dockerfile infra/systemd/tidepool.service infra/pulumi/cluster/control-plane-deployment.ts
git commit -m "#tckt_t9zo30 refactor(daemon): split reconciler into src/daemon.ts entrypoint"
```

> DEPLOY RISK (from plan caveats): this changes the pod's process. Before merge, verify the image boots the loop (Task 3 test + observe the deploy logs show reconcile ticks). Do NOT merge on a red/again-looping daemon.

---

## Task 4: Target validation on `add` + onboard `tidepool` + `list --target`

**Files:**
- Modify: `src/config.ts` (add `configuredRepos`).
- Modify: `src/queue-control.ts` (`add` validates via `AppConfig`).
- Modify: `tidepool.config.ts` (add `0x63616c/tidepool`).
- Test: `src/queue-control.test.ts` (validation), reuse Task 1 for the filter.

**Interfaces:**
- Consumes: `AppConfig` (already in `LocalQueueControl`), `TargetNotConfigured` (Task 1).
- Produces: `configuredRepos(config): ReadonlyArray<string>`; `add` now fails `TargetNotConfigured` for unknown repos.

- [ ] **Step 1: Write the failing test (red-first — loose→strict behavior change)**

```typescript
// append to src/queue-control.test.ts
describe('QueueControl.add validation', () => {
  it.effect('rejects an unconfigured target with TargetNotConfigured', () =>
    Effect.gen(function* () {
      const qc = yield* QueueControl;
      const r = yield* Effect.either(
        qc.add({ title: 'oops', goal: 'g', target: '0x63616c/tidepol' }),
      );
      expect(r._tag).toBe('Left');
      if (r._tag === 'Left') expect(r.left._tag).toBe('TargetNotConfigured');
    }).pipe(Effect.provide(layer)),
  );

  it.effect('accepts a configured target', () =>
    Effect.gen(function* () {
      const qc = yield* QueueControl;
      const t = yield* qc.add({ title: 'ok', goal: 'g', target: '0x63616c/tidepool-testbed' });
      expect(t.target).toBe('0x63616c/tidepool-testbed');
    }).pipe(Effect.provide(layer)),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/queue-control.test.ts` → Expected: FAIL — `add` currently accepts any string.

- [ ] **Step 3: Implement validation**

```typescript
// src/config.ts — add
export const configuredRepos = (config: Config): ReadonlyArray<string> =>
  config.targets.map((t) => t.repo);
```

```typescript
// src/queue-control.ts — replace the `add` field in LocalQueueControl
add: (input) =>
  Effect.gen(function* () {
    const config = yield* Effect.succeed(_config); // captured AppConfig
    const repos = configuredRepos(config);
    if (!repos.includes(input.target)) {
      return yield* Effect.fail(new TargetNotConfigured({ repo: input.target, configured: repos }));
    }
    return yield* store.add(input);
  }),
```

> Import `configuredRepos` in `queue-control.ts`. Keep `_config` → rename to `config` now that it's used.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/queue-control.test.ts` → Expected: PASS.

- [ ] **Step 5: Onboard `tidepool` + surface the CLI error**

```typescript
// tidepool.config.ts — add to targets[]
{
  repo: '0x63616c/tidepool',
  models: { work: 'openai/gpt-5.5', review: 'openai/gpt-5.5' },
},
```

In `src/cli.ts` `addCommand`, catch `TargetNotConfigured` and print an actionable message:
`error: <repo> is not a configured target — add it to tidepool.config.ts (configured: <list>)`.

Add a `cli.test.ts` assertion that an unconfigured `--target` prints that message and exits non-zero.

- [ ] **Step 6: `bun run check` then commit**

```bash
bun run check
git add src/config.ts src/queue-control.ts src/queue-control.test.ts src/cli.ts src/cli.test.ts tidepool.config.ts
git commit -m "#tckt_t9zo30 feat(queue): validate add targets; onboard 0x63616c/tidepool"
```

---

## Task 5: `HttpApi` definition + server (in daemon) + `HttpQueueControl` client

**Files:**
- Create: `src/queue-api.ts` (shared `HttpApi` declaration)
- Create: `src/queue-api-server.ts` (`HttpApiBuilder` handlers → `QueueControl`)
- Create: `src/http-queue-control.ts` (`HttpApiClient` satisfying `QueueControl`)
- Test: `src/queue-api.test.ts` (in-process server↔client contract)
- Modify: `src/daemon.ts` (merge the server layer + serve)
- Modify: `infra/pulumi/cluster/control-plane-deployment.ts` (ClusterIP `Service` on the API port)
- Reference: `effect-ts` skill for `@effect/platform` `HttpApi`/`HttpApiEndpoint`/`HttpApiGroup`/`HttpApiBuilder`/`HttpApiClient` (version 0.96.2 in `package.json`).

**Interfaces:**
- Consumes: `QueueControl` (server side), `HttpClient` (client side), the `Page`/query schemas from Task 1.
- Produces:
  - `queueApi` — the `HttpApi` value (group `tickets` with `add`(POST `/tickets`), `list`(GET `/tickets`), `get`(GET `/tickets/:id`), `runs`(GET `/tickets/:id/runs`), `events`(GET `/tickets/:id/events`)). `TargetNotConfigured`/`TicketNotFound` mapped to 4xx via `HttpApiError`/schema.
  - `QueueApiServerLive: Layer.Layer<HttpApiGroup..., never, QueueControl>` — the handlers.
  - `HttpQueueControl: Layer.Layer<QueueControl, never, HttpClient>` — client adapter (constructs from `HttpApiClient.make(queueApi, { baseUrl })`, mapping each method to `QueueControlApi`).

- [ ] **Step 1: Declare the `HttpApi` (`src/queue-api.ts`)**

Define endpoints with path/query/payload/success schemas reusing Task 1 schemas. Example shape (adjust to 0.96.2 API surface via the effect-ts skill):

```typescript
// src/queue-api.ts
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { NewTicket, Run, RunEvent, Ticket, TicketId } from './domain.ts';
import { Page, ListTicketsQuery, EventsQuery, TargetNotConfigured } from './queue-control.ts';
import { TicketNotFound } from './domain.ts';

const tickets = HttpApiGroup.make('tickets')
  .add(
    HttpApiEndpoint.post('add', '/tickets')
      .setPayload(NewTicket)
      .addSuccess(Ticket)
      .addError(TargetNotConfigured, { status: 422 }),
  )
  .add(
    HttpApiEndpoint.get('list', '/tickets')
      .setUrlParams(Schema.Struct({
        limit: Schema.optional(Schema.NumberFromString),
        cursor: Schema.optional(Schema.String),
        target: Schema.optional(Schema.String),
      }))
      .addSuccess(Page(Ticket)),
  )
  .add(
    HttpApiEndpoint.get('get', '/tickets/:id')
      .setPath(Schema.Struct({ id: TicketId }))
      .addSuccess(Ticket)
      .addError(TicketNotFound, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get('runs', '/tickets/:id/runs')
      .setPath(Schema.Struct({ id: TicketId }))
      .addSuccess(Schema.Array(Run))
      .addError(TicketNotFound, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get('events', '/tickets/:id/events')
      .setPath(Schema.Struct({ id: TicketId }))
      .setUrlParams(Schema.Struct({
        runId: Schema.optional(Schema.String),
        source: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.NumberFromString),
        cursor: Schema.optional(Schema.String),
      }))
      .addSuccess(Page(RunEvent))
      .addError(TicketNotFound, { status: 404 }),
  );

export const queueApi = HttpApi.make('queue').add(tickets);
```

- [ ] **Step 2: Write the failing contract test (`src/queue-api.test.ts`)**

Serve `QueueApiServerLive` over `QueueControl`+fakes in-process, build `HttpQueueControl` against it, assert round-trip: `add` → `list` returns it; unknown target → `TargetNotConfigured`; unknown id → `TicketNotFound`.

```typescript
// src/queue-api.test.ts (shape; use the effect-ts skill's in-memory HttpApi test pattern)
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { QueueControl } from './queue-control.ts';
import { HttpQueueControl } from './http-queue-control.ts';
// build a server on an ephemeral port (or the @effect/platform test transport),
// point HttpQueueControl at it, then drive QueueControl through the client:
it.effect('add→list round-trips over HTTP', () =>
  Effect.gen(function* () {
    const qc = yield* QueueControl; // provided by HttpQueueControl (client)
    const t = yield* qc.add({ title: 'net', goal: 'g', target: '0x63616c/tidepool-testbed' });
    const page = yield* qc.list({ limit: 50, cursor: null, target: null });
    expect(page.items.some((x) => x.id === t.id)).toBe(true);
  }).pipe(Effect.provide(clientOverServerLayer)),
);
```

Run: `bun run test src/queue-api.test.ts` → Expected: FAIL (server/client not written).

- [ ] **Step 3: Implement server (`src/queue-api-server.ts`) and client (`src/http-queue-control.ts`)**

- Server: `HttpApiBuilder.group(queueApi, 'tickets', (handlers) => handlers.handle('add', ({ payload }) => QueueControl.pipe(Effect.flatMap((qc) => qc.add(payload)))) ...)` for each endpoint; map query params (`limit ?? 50`, `cursor ?? null`, `target ?? null`) into the Task-1 query records; decode `runId`/`source` to their branded/literal types.
- Client: `Effect.gen` building `const client = yield* HttpApiClient.make(queueApi, { baseUrl })`, returning a `QueueControlApi` whose methods call `client.tickets.add(...)` etc., re-shaping query args into url params. Provide as `Layer.effect(QueueControl, ...)` requiring `HttpClient`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/queue-api.test.ts` → Expected: PASS (round-trip + both error mappings).

- [ ] **Step 5: Serve from the daemon + add the k8s Service**

- `src/daemon.ts`: build the server layer (`HttpApiBuilder.serve()` + `QueueApiServerLive` provided `QueueControl` = `LocalQueueControl` over `liveStack()`'s store, on a port from env `TIDEPOOL_API_PORT` default `8080`), and run it concurrently with `reconcileForever` (`Effect.all([...], { concurrency: 'unbounded' })` or fork the server, then the loop). Add `// TODO(tailscale): require bearer token when reach widens`.
- `control-plane-deployment.ts`: add a `containerPort` 8080 and a ClusterIP `Service` `tidepool-control-plane` exposing 8080 (outbound-reachable only via port-forward — no LoadBalancer, tenet 9).

Run: `bun run test src/daemon.test.ts` (extend to assert the server responds on the port) → PASS.

- [ ] **Step 6: `bun run check` then commit**

```bash
bun run check
git add src/queue-api.ts src/queue-api-server.ts src/http-queue-control.ts src/queue-api.test.ts src/daemon.ts src/daemon.test.ts infra/pulumi/cluster/control-plane-deployment.ts
git commit -m "#tckt_t9zo30 feat(queue): HttpApi server in daemon + HttpQueueControl client"
```

---

## Task 6: Client contexts (`~/.tidepool/config`) + invisible port-forward + adapter selection

**Files:**
- Create: `src/client-config.ts`
- Test: `src/client-config.test.ts`
- Modify: `src/cli.ts` (`withQueue` selects `LocalQueueControl` vs `HttpQueueControl` from resolved context; global `--context` option; open/close port-forward for `kind=http`).
- Reference: `infra/scripts/tp-kubeconfig.sh` (`bun run kube`), `@effect/platform` `Command` for the subprocess.

**Interfaces:**
- Consumes: `HttpQueueControl` (Task 5), `LocalQueueControl` (Task 1), `FetchHttpClient` layer.
- Produces:
  - `ClientContext = { name: string } & ({ kind: 'http'; url: string; portForward?: { namespace: string; service: string; remotePort: number } } | { kind: 'sqlite' })`
  - `resolveContext(opts: { flag: string | null }): Effect<ClientContext, ...>` — order `flag > TIDEPOOL_CONTEXT/TIDEPOOL_API_URL env > file current-context > default 'local'`.
  - `withPortForward(ctx): (eff) => Effect` — for `kind=http` with `portForward`, spawn `kubectl port-forward -n <ns> svc/<service> <localPort>:<remotePort>` (scoped: killed on release), rewrite url host→`localhost:<localPort>`; no-op otherwise.

- [ ] **Step 1: Write the failing test — resolution order + parsing**

```typescript
// src/client-config.test.ts
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { parseClientConfig, resolveContext } from './client-config.ts';

describe('client-config', () => {
  it('parses named contexts + current-context', () => {
    const cfg = parseClientConfig(`
current-context = "prod"
[contexts.prod]
kind = "http"
url = "http://localhost:8080"
[contexts.local]
kind = "sqlite"
`);
    expect(cfg.currentContext).toBe('prod');
    expect(cfg.contexts.prod.kind).toBe('http');
    expect(cfg.contexts.local.kind).toBe('sqlite');
  });

  it.effect('flag beats env beats file beats default', () =>
    Effect.gen(function* () {
      // with file current-context=prod but flag=local → local
      const ctx = yield* resolveContext({ flag: 'local' });
      expect(ctx.name).toBe('local');
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/client-config.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/client-config.ts`**

- `parseClientConfig(text)` — parse TOML (use an existing dep if present; else a tiny hand parser for the `current-context` + `[contexts.<name>]` blocks — keep it minimal, only the fields above). Validate with `@effect/schema`.
- `loadClientConfig` — read `~/.tidepool/config` (via `node:os` homedir + `node:fs/promises`), tolerate missing file (→ empty config, default context `local`).
- `resolveContext({ flag })` — apply the order; env `TIDEPOOL_API_URL` synthesises an ad-hoc `{ name: 'env', kind: 'http', url }` context; env `TIDEPOOL_CONTEXT` names one from the file; default `{ name: 'local', kind: 'sqlite' }`.
- `withPortForward(ctx)` — `@effect/platform` `Command.make('kubectl', 'port-forward', ...)` in an `Effect.acquireRelease` (spawn → wait for "Forwarding from 127.0.0.1"; release → kill). Return the localhost-rewritten url.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/client-config.test.ts` → Expected: PASS.

- [ ] **Step 5: Wire `withQueue` in `cli.ts` to select the adapter**

```typescript
// src/cli.ts — replace withQueue
const withQueue = <A, E>(effect: Effect.Effect<A, E, QueueControl>, flag: string | null) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* resolveContext({ flag });
      if (ctx.kind === 'sqlite') {
        return yield* effect.pipe(
          Effect.provide(
            LocalQueueControl.pipe(Layer.provideMerge(Layer.mergeAll(ticketStoreLive(), AppConfigLive))),
          ),
        );
      }
      const url = yield* withPortForward(ctx); // localhost-rewritten if port-forward configured
      return yield* effect.pipe(
        Effect.provide(HttpQueueControl(url).pipe(Layer.provide(FetchHttpClient.layer))),
      );
    }),
  );
```

Add a global `--context <name>` option on `root` threaded to `withQueue`. Add a `cli.test.ts` case: `--context local ticket list` uses the sqlite adapter (no port-forward spawned).

- [ ] **Step 6: `bun run check` then commit**

```bash
bun run check
git add src/client-config.ts src/client-config.test.ts src/cli.ts src/cli.test.ts
git commit -m "#tckt_t9zo30 feat(cli): client contexts + invisible port-forward adapter selection"
```

---

## Task 7: Docs — `DESIGN.md` tracks reality (tenet 11)

**Files:**
- Modify: `DESIGN.md`
- Modify: `.handoffs/2026-07-01-1038-local-cli-remote-queue-control.md` (mark resolved / point at the plan) — optional.

- [ ] **Step 1: Update `DESIGN.md`**

Add/replace sections:
- **Queue control** — the `QueueControl` deep module (5 read/enqueue methods), the mover trio stays in the reconciler (tenet 3), the `{items,nextCursor}`+`limit` envelope.
- **Daemon** — `src/daemon.ts` = reconciler + `HttpApi` server, one pg store; pod CMD.
- **Reaching prod** — laptop `tp` → `HttpQueueControl` → invisible `kubectl port-forward` through the /32-firewalled apiserver (tenet 9); no app auth v1; **Tailscale is the planned successor** (add bearer token then).
- **Client contexts** — `~/.tidepool/config` (per-operator, NOT git config); resolution `flag > env > file > default`.
- **Deferred gap** — `cancel`/`retry` are NOT user verbs today (only reconciler-internal deadline-reap + `retryOrFail`); a user-facing `tp ticket cancel/retry` would need intent/desired-state modeling + a reconciler observer; explicitly out of scope, decision pending.
- Remove any now-stale references to `tp up`/`tp run --watch`/`bucket-init` as the operator surface.

- [ ] **Step 2: Verify docs match code**

Run: `grep -rnE "tp run --watch|bucket-init|tp up" DESIGN.md` → Expected: no stale operator-surface references (mentions inside history/rationale are fine if clearly past-tense).

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md .handoffs/2026-07-01-1038-local-cli-remote-queue-control.md
git commit -m "#tckt_t9zo30 docs: local tp queue-control API, daemon, contexts, cancel/retry gap"
```

---

## Finalisation (before PR)

- [ ] **Full gate:** `bun run check` (biome + lint:sh + typecheck + test) → all green.
- [ ] **Manual smoke (local):** `TIDEPOOL_CONTEXT=local bun run src/cli.ts ticket add --title t --goal g --target 0x63616c/tidepool-testbed` then `... ticket list` — round-trips via sqlite adapter, no server.
- [ ] **Manual smoke (http, optional):** run `src/daemon.ts` locally on sqlite, add an `http` context to `~/.tidepool/config` pointing at `http://localhost:8080` (no port-forward), verify `tp ticket list` hits the server.
- [ ] **Branch/PR:** push `tp/tckt_t9zo30-local-queue-control`; open PR titled `feat(cli): local tp queue-control over HttpApi (tckt_t9zo30)`; ensure CI green; merge (golden rule).

## Self-Review Notes (author checklist — done)

- **Spec coverage:** Option B (semantic `QueueControl`) ✓ T1; 5 verbs, no mover ✓ T1; `list`/`get` no aliases ✓ T2; `{items,nextCursor}`+`limit` everywhere ✓ T1/T5; daemon-not-a-verb + relic deletion ✓ T2/T3; invisible port-forward now / Tailscale later ✓ T6/T7; no app auth v1 ✓ T5/T7; target validation + onboard tidepool + `--target` filter ✓ T4; contexts in `~/.tidepool/` not git config ✓ T6; cancel/retry deferred + documented ✓ T7; one PR commit-sliced ✓ structure.
- **Type consistency:** `QueueControlApi` method names (`add`/`list`/`get`/`runsFor`/`events`) identical across T1/T5/T6; `Page`/`ListTicketsQuery`/`EventsQuery`/`TargetNotConfigured` defined once (T1), reused (T4/T5). `withQueue` signature consistent T2→T6.
- **Known verify-before-code points (flagged inline):** exact `EventQuery` field names in `services.ts`; `reconcileForever` arity; `@effect/platform` 0.96.2 `HttpApi*`/`HttpApiClient` surface (consult effect-ts skill); `cli.test.ts` harness (`runCli`) existence.
