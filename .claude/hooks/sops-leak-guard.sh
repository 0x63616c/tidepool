#!/usr/bin/env bash
# PreToolUse(Bash) guard — block `sops` DECRYPT whose output can reach the model context.
#
# Why: piping `sops -d secret.enc.yaml | grep/cat/head` (or bare `sops -d file`) prints the
# decrypted SECRET VALUE to stdout, which lands in the model's context / transcript. That is
# exactly how a leak happened. CLAUDE.md: "DON'T surface a secret value in chat."
#
# Allowed (decrypt output goes to a file or /dev/null, never stdout):
#   sops -d -o out.yaml secret.enc.yaml
#   sops -d secret.enc.yaml > out.yaml
#   sops -d secret.enc.yaml >/dev/null            # round-trip verify
#   sops -d --extract '["k"]' secret.enc.yaml > file
# Blocked (decrypt output reaches stdout/a pipe the model reads):
#   sops -d secret.enc.yaml
#   sops -d secret.enc.yaml | grep ...
#
# Heuristic + defense-in-depth: it cannot catch every downstream (e.g. `sops -d f > x && cat x`),
# but it kills the direct/common vector. Inspect only the top-level Bash command; trusted scripts
# that decrypt-to-file internally are unaffected (the hook sees the script path, not its body).
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")"
[ -z "$cmd" ] && exit 0

# Invokes sops decrypt? (sops [flags] -d|--decrypt|decrypt)
if printf '%s' "$cmd" | grep -qE '(^|[;&|]|[[:space:]])sops([[:space:]]+-[A-Za-z]+)*[[:space:]]+(-d\b|--decrypt\b|decrypt\b)'; then
  # ANY pipe means the decrypted VALUE is piped downstream into context. `2>/dev/null`
  # only redirects STDERR, so the old "redirect present?" check waved it through — block
  # any single `|` (but not the `||` logical-or operator).
  if printf '%s' "$cmd" | grep -qE '([^|]|^)\|([^|]|$)'; then
    echo "sops-leak-guard: blocked. 'sops -d ... | cmd' pipes the decrypted VALUE into context (2>/dev/null only redirects stderr). For key NAMES, grep the ENCRYPTED file or --extract to a file." >&2
    exit 2
  fi
  # Allow ONLY when STDOUT itself goes to a file or /dev/null (-o/--output, or a `>`/`1>`
  # redirect). `2>FILE` does NOT count — that is stderr, the value still hits stdout.
  if printf '%s' "$cmd" | grep -qE '(-o[[:space:]]|--output[[:space:]=])' \
     || printf '%s' "$cmd" | grep -qE '(^|[[:space:]])1?>[[:space:]]*([^|&;[:space:]]+|/dev/null)'; then
    exit 0
  fi
  echo "sops-leak-guard: blocked. 'sops -d' to stdout can leak secret VALUES. Redirect STDOUT to a file (-o FILE / > FILE) or >/dev/null." >&2
  exit 2
fi
exit 0
