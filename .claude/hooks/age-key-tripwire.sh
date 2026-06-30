#!/usr/bin/env bash
# PostToolUse REDACTION guard — if a tool OUTPUT contains an AGE private key, REPLACE what the model
# sees with a masked version via hookSpecificOutput.updatedToolOutput. This is GENUINE redaction
# (verified against Claude Code hooks docs), not just detection: the model never sees the raw key.
#
# Layered defense:
#   • PreToolUse  sops-leak-guard.sh   — prevent known decrypt-to-stdout vectors BEFORE they run
#   • PostToolUse this script          — redact surprises that slip through, post-execution
# LIMITATION: runs AFTER the tool; if this hook itself crashes/times out, the raw output reaches
# context. So the PreToolUse layer is still the primary shield.
#
# Pattern: age secret keys are Bech32 with the literal prefix AGE-SECRET-KEY-1.
set -euo pipefail

input="$(cat)"
blob="$(printf '%s' "$input" | jq -r '[.. | strings] | join("\n")' 2>/dev/null || printf '%s' "$input")"

if printf '%s' "$blob" | grep -qE 'AGE-SECRET-KEY-1[0-9A-Za-z]{20,}'; then
  masked="$(printf '%s' "$blob" | sed -E 's/AGE-SECRET-KEY-1[0-9A-Za-z]{20,}/[REDACTED-AGE-KEY]/g')"
  jq -cn --arg o "$masked" '{
    systemMessage: "age-key-tripwire: redacted an AGE private key from a tool output — ROTATE the affected key (breakglass/mainbox/ci).",
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: ("⚠ age-key-tripwire redacted an AGE-SECRET-KEY from this output. Rotate the key; do not try to recover the value.\n" + $o)
    }
  }'
  exit 0
fi
exit 0
