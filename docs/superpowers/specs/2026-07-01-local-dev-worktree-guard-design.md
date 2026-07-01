# Local Claude Code DX: forced worktrees + main-write guard + session GC

**Ticket:** `tckt_2hh7e3`
**Date:** 2026-07-01
**Branch:** `worktree-calum+dx-worktree-guard`

## Problem

Local Claude Code development currently lets an agent commit/merge on `main` in the
primary working tree, and leaves merged worktrees lying around. We want local dev to be
isolated by construction: never mutate `main`, always work in a worktree, and clean up
worktrees whose PR has already landed. The AGENTS.md standards are written for *both*
local and remote agents with no line drawn between them, which blurs whose job worktree
lifecycle is.

## Goals

1. **Block `main` writes locally.** An agent (or human) cannot `git commit`/`merge`/`push`
   while `HEAD == main`. They are pushed into a worktree first.
2. **Force a worktree for all local work.** Achieved by (1): the only way to commit is from
   a worktree branch.
3. **Session-start GC.** On Claude Code session start, remove *local-dev* worktrees under
   `.claude/worktrees/` (branch `worktree-*`) whose branch is merged to `main` **or** whose
   upstream was deleted (squash-merge), and that are clean. Never touch dirty or unmerged
   trees, or worktrees on any other branch.
4. **PR-only merges to `main`.** Already enforced server-side by GitHub branch protection;
   this spec adds local defense-in-depth, not a new server control.
5. **Draw the local/remote line in the docs.** Make explicit that these controls are
   *local Claude Code only*; the remote tidepool worker owns its own boxes/worktrees.

## Non-goals

- No treehouse CLI or any new worktree dependency. Native `EnterWorktree`/`ExitWorktree`
  remains the local mechanism (tenet 10, one way; no undeclared global-npm prereq).
- No change to commitlint / the `#tckt_` commit-subject gate.
- No machine-enforced branch-name gate (matches how `tp/` is convention-only today).
- No branch renaming — the native `worktree-*` branch name is taken as-is (zero friction).
- No change to remote worker behavior.

## Key facts established during design

- **The differentiator needs no env flag.** `.claude/` hooks fire *only* under local Claude
  Code. The remote runner is opencode via `@opencode-ai/sdk` (DESIGN.md:16,30) and manages
  its own box + worktree. Cheap insurance: hooks no-op when `KUBERNETES_SERVICE_HOST` is set,
  so if Claude Code is ever run inside a box it does nothing.
- **No branch-name gate exists.** commitlint enforces the `#tckt_` commit *subject*; nothing
  checks branch names. `tp/` is doc-only convention today, so the local prefix is a free
  convention.
- **Native `EnterWorktree` naming — taken as-is, no rename.** It creates a branch
  `worktree-<name>`, replacing `/` with `+` (e.g. worktree name `calum/dx-worktree-guard` →
  branch `worktree-calum+dx-worktree-guard`). We adopt this native form directly: no
  `git branch -m` step, zero friction. Naming the worktree `calum/<slug>` yields
  `worktree-calum+<slug>`, carrying the author while staying under the `worktree-*` local
  marker. The guard keys off `HEAD == main` (branch-name independent); GC keys off the
  `worktree-*` prefix + merge/upstream status.
- **PRs squash-merge**, so GitHub auto-deletes the branch and git ancestry reports "not
  merged." GC must treat *upstream-gone* as a removal signal, not just ancestry-merged.

## Design

### Component 1 — `.claude/hooks/main-guard.sh` (PreToolUse, Bash matcher)

Bash 3.2-safe, styled like `.claude/hooks/secret-redactor.sh`. Reads the hook JSON on stdin,
extracts `tool_input.command`.

- No-op (allow) if `KUBERNETES_SERVICE_HOST` is set.
- No-op (allow) if the command is not a git mutation. Match `git … commit`, `git … merge`,
  `git … push` (tolerating leading env/`cd`; the `-C`/`--git-dir` forms are out of scope —
  match the common `git <sub>` shape; a determined bypass is not the threat model, forgetful
  agents are).
- If it *is* such a command and `git symbolic-ref --quiet --short HEAD` == `main`
  (i.e. the primary tree on main), **deny**: emit the PreToolUse deny decision with a reason:
  > "Commits/merges/pushes on `main` are blocked locally. Run `EnterWorktree` (name it
  > `calum/<slug>`) and commit on the `worktree-calum+<slug>` branch. Merges to `main` land
  > via PR only."
- Otherwise allow.

Denial mechanism: emit the documented PreToolUse JSON
(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`)
on stdout and exit 0. (Exit-2-on-stderr is the fallback shape; JSON is preferred and testable.)

### Component 2 — `.claude/hooks/worktree-gc.sh` (SessionStart)

Bash 3.2-safe, best-effort, **always exits 0** (must never block a session start).

- No-op if `KUBERNETES_SERVICE_HOST` is set.
- `git fetch --prune --quiet` (best-effort; ignore failure — offline is fine).
- For each worktree path under `.claude/worktrees/` (from `git worktree list --porcelain`):
  - Skip the primary worktree and the *current* session's worktree.
  - **Skip unless the branch matches `worktree-*`** (the native local-dev form). Anything else
    parked under `.claude/worktrees/` is left untouched.
  - Skip if dirty: any output from `git -C <wt> status --porcelain`.
  - Skip if it has commits not merged to `main` **and** its upstream still exists
    (unpushed real work).
  - Remove (`git worktree remove <wt>`) if **clean AND** (`git merge-base --is-ancestor <branch> main`
    succeeds **OR** the branch's upstream is gone — `git rev-parse --abbrev-ref <branch>@{upstream}`
    fails after prune / `git branch -vv` marks it `: gone]`).
- Finally `git worktree prune` to clear stale registrations.
- Emit a one-line summary of what was removed (SessionStart additionalContext / stdout).

### Component 3 — `.claude/settings.json`

Add SessionStart → `worktree-gc.sh`. Add PreToolUse Bash → `main-guard.sh` (a second entry
alongside the existing `secret-redactor` PostToolUse; PreToolUse is a distinct block).

### Component 4 — `lefthook.yml` pre-commit `no-main-commit`

Universal git-level backstop (catches human, CLI, any agent — not just Claude Code):

```yaml
no-main-commit:
  run: test "$(git branch --show-current)" != main
```

Safe universally: worker commits on `tp/*`, humans/agents never intend to commit on `main`,
CI does not commit. `LEFTHOOK=0` is the documented escape hatch for any legitimate exception.

### Component 5 — Branch convention (doc-only)

- **Local (Claude Code):** `worktree-calum+<short-slug>` — the native `EnterWorktree` output
  when the worktree is named `calum/<short-slug>`. No rename.
- **Remote (worker):** `tp/<tckt_id>-<short-slug>` — unchanged.

Visually distinct and machine-distinguishable: `worktree-*` (local) vs `tp/*` (remote).
Documented, not machine-enforced — matching how `tp/` works today.

### Component 6 — Tests (`src/dx-hooks.test.ts`, tenet 12: written first, must fail first)

Mirrors `src/secret-hooks.test.ts` (spawns the shell script, feeds stdin, asserts stdout/exit).

- **main-guard:** blocks `git commit`/`git merge`/`git push` when a fake repo is on `main`
  (assert deny JSON); allows the same commands on a `worktree-calum+x` branch; allows a
  non-git command on `main`; no-ops (allows) when `KUBERNETES_SERVICE_HOST` is set.
- **worktree-gc:** in a throwaway repo with worktrees — removes a merged+clean `worktree-*`
  worktree; keeps a dirty worktree; keeps an unmerged+upstream-present worktree; removes an
  upstream-gone+clean worktree; **keeps a merged+clean worktree on a non-`worktree-*` branch**
  (e.g. `feature/x`); exits 0 even when `git fetch` cannot reach a remote.

Each test is committed and shown red before the script exists, then green after (reviewer
confirms the red).

### Component 7 — Docs

- **AGENTS.md:** new **"Local vs remote dev"** section stating the split — local Claude Code
  hooks force a worktree, block `main` writes, and GC merged worktrees, using `worktree-*`
  branches (native `EnterWorktree`, named `calum/<slug>`); the remote worker (opencode) owns
  box + worktree lifecycle and uses `tp/*`. Update the Branches standard to list both prefixes
  and their scope. Note the new lefthook `no-main-commit` gate under "Local quality gates."
- **DESIGN.md / HANDOFF.md:** touch only if they assert something now contradicted (expected:
  a one-line pointer to the local DX controls; no architectural change).

## Risks / edge cases

- **Guard false-negative (bypass):** an agent could `git -C … commit` or script around the
  matcher. Accepted — threat model is a forgetful agent, not an adversary; the lefthook gate
  and branch protection are the real backstops.
- **GC removing wanted work:** mitigated by the clean-AND-(merged-OR-gone) gate; unpushed or
  dirty trees are always kept. Worst case a user re-creates a worktree.
- **Offline session start:** `git fetch --prune` fails → upstream-gone detection degrades to
  ancestry-merged only; GC still exits 0. Acceptable.
- **Multiple local agents (cmux teammates):** each self-creates its own worktree; GC skips the
  current session's worktree and any dirty tree, so a peer's active worktree is never removed
  (it's dirty or has unpushed commits, or is simply not merged yet).

## Acceptance

`bun run check` green; the two hooks exercised by `src/dx-hooks.test.ts` (red-before-green
shown); docs updated in the same PR; ships as a merged PR from `worktree-calum+dx-worktree-guard`.
