#!/usr/bin/env bash
# PreToolUse guard (Bash matcher) — block `git commit`/`merge`/`push` while the target tree is on
# `main`, forcing local work into a worktree. This is LOCAL Claude Code DX only: the remote tidepool
# worker runs opencode (never sees `.claude/` hooks) and manages its own box + worktree, so it is
# unaffected. Cheap insurance: no-op in-cluster.
#
# Fails OPEN — any error allows the command. A guard that blocked every Bash call on the slightest
# hiccup would be worse than the risk it guards. The real backstops are the lefthook `no-main-commit`
# gate and GitHub branch protection; this hook is the fast, friendly nudge. The threat model is a
# forgetful agent, not an adversary: a `git -C <other> commit` bypass is knowingly out of scope.
set -uo pipefail

# In-cluster insurance: if Claude Code is ever run inside a box, do nothing.
[ -n "${KUBERNETES_SERVICE_HOST:-}" ] && exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] || exit 0

# Is this a mutating git command? Allow optional global flags between `git` and the subcommand
# (e.g. `git -c user.name=x commit`, `git --no-pager push`). Loose by design — a determined bypass
# is out of scope; the common `git <sub>` shape is what we catch.
printf '%s' "$cmd" |
  grep -Eq 'git([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+(commit|merge|push)([[:space:]]|$)' ||
  exit 0

# Only block when the target tree's HEAD is `main`. In a worktree, HEAD is `worktree-*`, so commits
# there sail through — which is exactly the point.
branch="$(git -C "$cwd" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[ "$branch" = "main" ] || exit 0

jq -cn '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Commits/merges/pushes on `main` are blocked locally. Run EnterWorktree (name it calum/<slug>) and commit on the resulting worktree-calum+<slug> branch. Merges to `main` land via PR only."
  }
}'
exit 0
