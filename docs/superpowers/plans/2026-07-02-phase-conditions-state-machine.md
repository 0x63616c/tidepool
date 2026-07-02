# Phase+conditions state machine → safe parallelism

Design + ticket plan settled 2026-07-02 (grilled session). Goal contract:
[GOAL](./2026-07-02-state-machine-GOAL.md). Facts grounded at `#39723b6`.

## Why

Turning on parallelism (`workers.max > 1`) on the current 7-state machine is unsafe:

1. **Stale-green merges.** Merge gate reads PR checks (`reconciler.ts`) that ran against
   main *as of branch push*; no up-to-date check. Two green PRs can merge and break main
   combined. No post-merge verification exists — `done` never looks at main.
2. **Broken main cascades + mis-charges.** Workers clone fresh main each dispatch; a broken
   main turns every subsequent ticket's CI red, burning *their* attempts.
3. **MergeConflict livelock (reachable at N=1 today).** The 409 bounce to `in_progress`
   leaves `workedAttempt`/`prNumber` intact → resume shortcut skips rework → review agent
   redispatched against stale-green checks → merge → 409 → loop, forever, no attempt counted.
4. **State explosion.** `running` means two things (work/review, disambiguated by
   `prNumber`); `rate_capped` must remember its return state. Every new concern
   (blocked-by, contention, breaker) multiplies flat states.

## Target model (k8s pod idiom: phase + conditions)

- **Phase** — linear, what work remains: `queued → working → reviewing → merging →
  verifying → done | failed`. Rework loops `reviewing → working`. That's the whole machine.
- **Conditions (gates)** — orthogonal, composable, each blocks progress:
  `blocked_by: [tckt_…]`, `rate_capped`, `merge_contention` (rebase budget),
  `needs_human: <reason>`; plus a **global per-target breaker** ("main red").
  Reconciler rule: **advance phase iff gates clear.**
- **Runs first-class** — a run row per dispatch (work/review/repair), finalized
  `succeeded | failed | reaped` + reason. "An agent is running" is derived from an open
  run row; `running` state and inline `workHandle` die. Counters become queries over
  evidence (tenet 8).
- The machine's definition is an **executable transition-table spec**, written red-first:
  *(phase, conditions, world: PR state/checks/poll) → (phase′, conditions′, dispatch?)*.

## Failure taxonomy — three classes, three budgets

| Class | Examples | Budget | Exhausted → |
|---|---|---|---|
| Work quality | review reject, own-CI red, agent crash | `attempts`, cap 3 | `failed` |
| Contention | main moved, update-branch, merge 409 | `rebases`, cap 5, resets per work run; **never** an attempt | `needs_human` (stalled, not failed) |
| Post-merge main red | merge landed, main checks red | **one** fix-forward repair dispatch | `needs_human` + breaker stays open |

## Merge safety decisions

- **Parallelize work, serialize merges.** First up-to-date + green + approved merges.
  Pre-merge gate: `forge.isUpToDate`; behind → `forge.updateBranch` → CI-wait on new head;
  update conflicts → rework dispatch with conflict context.
- **No head-of-line blocking.** A ticket kicked back for rebase releases its merge turn.
  Starvation guard (oldest-ready priority) deferred until observed (tenet 7).
- **`verifying` phase**: `done` only when mergeSha checks on main go green (deploy rides
  free where it's a main workflow). Red → breaker.
- **Circuit breaker (main red)**: freeze all merges + new dispatches; only the repair PR
  may merge; in-flight verdicts deferred (no misattribution). Trigger is "main red",
  cause-agnostic (human pushes included).
- **Fix-forward, cap 1**: repair dispatch gets "your merge landed as <sha>, main red with
  <checks> — fix main." Fails → human. Revert stays a human button, never automatic.

## Blocked-by decisions

- `blocked_by` is a **gate**, not a state. Clears only when dependency reaches `done`
  (verified main). Dependency terminal-bad → `needs_human` gate on the dependent
  (a failed dep says nothing about whether the dependent is still wanted).
- Editable via `tp ticket edit --blocked-by` (new QueueControl mutation seam; field edits
  on non-terminal tickets only — state transitions remain reconciler-only, tenet 3).

## Ticket waves (FIFO order = execution order until blocked-by exists)

File a wave, watch it green, file the next. Every ticket: red-first test AC (tenet 12),
DESIGN.md updated in-wave (tenet 11).

| Wave | Tickets |
|---|---|
| 0 | T1 fix MergeConflict livelock · T2 retries 2→3 |
| 1 | T3 run row per dispatch, full lifecycle |
| 2 | T4 additive `phase`+`conditions` schema, dual-write · **T5 reconciler rewrite (worked locally — exceeds 8-min worker cap)** |
| 3 | T6a up-to-date merge gate · T6b rebase budget · T7a `verifying` phase · T7b breaker · T7c fix-forward |
| 4 | T8 `blocked_by` gate · T9 `tp ticket edit` · T10 `workers.max ≥ 2` + serialization docs |

Feasibility notes (`#39723b6`): `Run` entity/table/API already exist (success-only writes);
state literals concentrated (domain union, one reconciler switch, two constants, ~70 test
assertions); pg has versioned `PgMigrator`, sqlite inline ALTERs — keep in sync; k8s
labels/metrics: zero state coupling; `trace.ts` already derives phases from runs.
