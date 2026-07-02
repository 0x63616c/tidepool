# GOAL — phase+conditions state machine live in prod, parallelism on

Design + waves: [plan](./2026-07-02-phase-conditions-state-machine.md). Every condition
below must be proven **in the transcript** (command output surfaced, not asserted).

## End state

1. **Merged.** Every wave-0→4 ticket in the plan is a merged PR with green CI. Each PR's
   `bun run check` exits 0, surfaced; test output shows **0 skipped**; no test deleted or
   weakened to pass.
2. **TDD evidence.** Every behavior PR shows its new test failing (red) before the
   implementation exists — failing run quoted in transcript or PR description. The
   reconciler transition-table spec suite covers every designed
   (phase × condition × world) row and passes with 0 skipped.
3. **Deployed.** Prod reconciler is running the post-refactor code: deployed image/commit
   sha surfaced (kubectl or equivalent) and equal to the merged sha. Prod tickets carry
   `phase` + `conditions`; the runs ledger has a row per dispatch with terminal outcomes —
   real prod query output surfaced.
4. **Logging.** For a real prod ticket, `tp ticket logs` (or events query) output is
   surfaced showing every phase transition and every condition set/clear as events.
5. **Prod validation.** ≥1 real ticket driven `queued → working → reviewing → merging →
   verifying → done` on the new machine in prod, with its mergeSha checks on main green —
   each transition evidenced in surfaced logs.
6. **Parallelism proven.** `workers.max ≥ 2` live in prod; two tickets observed in
   `working` with overlapping timestamps (surfaced); ≥1 update-branch/rebase event logged
   at the merge gate; both tickets reach `done`; main never red during the window — or
   the breaker fired and recovered via fix-forward, evidenced either way.
7. **Failure lanes proven (test-level).** Surfaced passing tests for: merge conflict →
   rework dispatch (no review-agent loop), contention budget exhausted → `needs_human`,
   main red → merges + new dispatches frozen.

## Boundaries (must not move)

- All changes via PRs — zero direct pushes to `main`.
- No edits to `secrets/**` or `.github/workflows/**`.
- No gate loosened (lefthook, CI, commitlint) to get green.
- `DESIGN.md` updated to describe the new machine in the same waves — stale docs = not done.
- No second source of truth: when `phase`+`conditions` become authoritative, the old
  `state` column is removed or mechanically derived, never dual-authoritative.
