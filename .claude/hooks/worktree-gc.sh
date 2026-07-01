#!/usr/bin/env bash
# SessionStart GC — reclaim finished LOCAL worktrees under .claude/worktrees/. A worktree is removed
# only if ALL hold: its branch matches `worktree-*` (the native EnterWorktree form), its tree is clean,
# it is not the current session's worktree, and either its HEAD is merged into `main` OR its upstream
# branch is gone (the PR squash-merged and the remote branch was deleted). Dirty, unpushed-and-unmerged,
# or non-`worktree-*` trees are always kept.
#
# LOCAL Claude Code DX only (the opencode worker owns its own boxes/worktrees; no-op in-cluster).
# Best-effort: ALWAYS exits 0 — a GC hiccup must never block a session from starting.
set -uo pipefail

[ -n "${KUBERNETES_SERVICE_HOST:-}" ] && exit 0

input="$(cat 2>/dev/null || true)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -n "$cwd" ] || cwd="$PWD"
git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The .claude/worktrees/ dir lives under the MAIN worktree (first `worktree list` entry).
main_wt="$(git -C "$cwd" worktree list --porcelain 2>/dev/null |
  awk '/^worktree /{print substr($0, 10); exit}')"
[ -n "$main_wt" ] || exit 0
wt_root="$main_wt/.claude/worktrees"

# git's canonical path for the current session's worktree (matches `worktree list` output, which the
# raw `cwd` may not — e.g. macOS /var vs /private/var symlinks). Used to never GC the active worktree.
self="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")"

# Prune deleted remote branches so upstream-gone detection (`[gone]`) is accurate. Offline is fine.
git -C "$cwd" fetch --prune --quiet >/dev/null 2>&1 || true

removed=""
path=""
branch=""
# `< <(...)` runs the loop in THIS shell (not a subshell), so `removed` survives the loop.
while IFS= read -r line; do
  case "$line" in
    "worktree "*) path="${line#worktree }" ;;
    "branch "*) branch="${line#branch refs/heads/}" ;;
    "")
      # End of a worktree record — decide on (path, branch).
      if [ -n "$path" ] && [ -n "$branch" ]; then
        keep=""
        case "$path" in "$wt_root"/*) : ;; *) keep=1 ;; esac # only under .claude/worktrees/
        case "$branch" in worktree-*) : ;; *) keep=1 ;; esac # only native local branches
        [ "$path" = "$self" ] && keep=1                      # never the active session
        if [ -z "$keep" ] && [ -z "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
          merged=""
          gone=""
          git -C "$path" merge-base --is-ancestor HEAD main 2>/dev/null && merged=1
          git -C "$path" status -sb 2>/dev/null | head -1 | grep -q '\[gone\]' && gone=1
          if [ -n "$merged" ] || [ -n "$gone" ]; then
            git -C "$cwd" worktree remove "$path" 2>/dev/null && removed="$removed $path"
          fi
        fi
      fi
      path=""
      branch=""
      ;;
  esac
done < <(
  git -C "$cwd" worktree list --porcelain 2>/dev/null
  printf '\n'
)

git -C "$cwd" worktree prune >/dev/null 2>&1 || true

if [ -n "$removed" ]; then
  jq -cn --arg m "worktree-gc removed:$removed" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $m}}'
fi
exit 0
