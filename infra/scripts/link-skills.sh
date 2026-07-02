#!/usr/bin/env bash
# Link first-party skills into the agent-discovery dir.
#
# External skills are vendored into `.agents/skills/` by the `skills` CLI (see
# SKILLS.md); `.claude/skills` is a symlink into it so Claude Code + opencode
# auto-discover them. First-party skills live in the TRACKED `skills/` dir (they
# are product source, not regenerable third-party installs) — this symlinks each
# into `.agents/skills/` alongside the vendored ones. `.agents/` is gitignored,
# so the links are a local, idempotent, regenerable artifact.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

mkdir -p .agents/skills

linked=0
for dir in skills/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # ../../ walks from .agents/skills/<name> back to the repo root.
  ln -sfn "../../skills/$name" ".agents/skills/$name"
  echo "linked skills/$name -> .agents/skills/$name"
  linked=$((linked + 1))
done

echo "done: $linked first-party skill(s) linked into .agents/skills"
