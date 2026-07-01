#!/usr/bin/env bash
# PostToolUse REDACTION guard — mask secrets in a tool's OUTPUT before the model sees it, via
# hookSpecificOutput.updatedToolOutput. Three layered passes over the tool_response strings:
#   1. SHAPE regexes   — high-confidence patterns (AGE keys, PEM private keys, GitHub tokens, sk-ant-).
#   2. KNOWN-VALUE hash — sha256 each output token; redact any whose digest is in
#      .claude/redaction-hashes.json (our exact sealed secrets). Catches SHAPELESS tokens (hcloud,
#      S3 secret) that no pattern/scanner can match. No plaintext/key needed at runtime.
#   3. gitleaks        — breadth net for shapes we didn't hand-code (reuses .gitleaks.toml).
#
# CRITICAL SHAPE NOTE: for BUILT-IN tools (Bash/Read) `updatedToolOutput` MUST be a STRUCTURED OBJECT
# mirroring that tool's result shape — a plain STRING is silently ignored (verified on CC 2.1.197).
# We reuse the original `.tool_response` object and mask strings in place, so the shape always matches.
#
# This is the sole leak guard: it masks secrets in tool OUTPUT before the model sees them. If this
# hook crashes, raw output reaches context — so it fails OPEN by design (never blocks a tool). Real
# containment is elsewhere: outbound-only box + least privilege + rotation on compromise.
set -euo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
HASH_FILE="$ROOT/.claude/redaction-hashes.json"
GITLEAKS_CONFIG="$ROOT/.gitleaks.toml"

input="$(cat)"
orig="$(printf '%s' "$input" | jq -c '.tool_response' 2>/dev/null || echo "null")"
[ "$orig" = "null" ] && exit 0

# ---- Pass 1: shape regexes (jq walk over every string) --------------------------------------------
resp="$(printf '%s' "$orig" | jq -c '
  def redact:
      gsub("AGE-SECRET-KEY-1[0-9A-Za-z]{20,}"; "[REDACTED-AGE-KEY]")
    | gsub("gh[posru]_[0-9A-Za-z]{20,}"; "[REDACTED-GH-TOKEN]")
    | gsub("sk-ant-[0-9A-Za-z_-]{15,}"; "[REDACTED-ANTHROPIC-KEY]")
    | gsub("-----BEGIN[^-]*PRIVATE KEY-----.*?-----END[^-]*PRIVATE KEY-----"; "[REDACTED-PRIVATE-KEY]"; "m");
  walk(if type == "string" then redact else . end)')"

# Candidate tokens from the (already shape-masked) output. Split on whitespace + quotes into fields;
# for each field also emit the part after a `key=`/`key:` prefix (so `TOKEN=<secret>` yields <secret>).
# Keep base64 chars (+/=) inside a token. Filter to runs long enough to be a secret.
# NB: no bash-4 features (mapfile / associative arrays) — Claude Code may invoke this under macOS's
# /bin/bash 3.2, where those fail and the hook would silently skip redaction (fails open).
candidates=()
while IFS= read -r line; do
  [ -n "$line" ] && candidates+=("$line")
done < <(printf '%s' "$resp" | jq -r '[.. | strings] | .[]' 2>/dev/null |
  grep -oE "[^[:space:]\"'\`]+" |
  awk '{ print; n = split($0, a, /[=:]/); for (i = 2; i <= n; i++) print a[i] }' |
  grep -oE '[A-Za-z0-9+/._=-]{12,}' | sort -u || true)

# ---- Pass 2: known-value hash match (membership via grep, not an associative array) ----------------
known_hashes=""
[ -f "$HASH_FILE" ] && known_hashes="$(jq -r '.hashes[]?' "$HASH_FILE" 2>/dev/null || true)"
to_redact=()
if [ -n "$known_hashes" ] && [ "${#candidates[@]}" -gt 0 ]; then
  for tok in "${candidates[@]}"; do
    d="$(printf '%s' "$tok" | openssl dgst -sha256 -r 2>/dev/null | awk '{print $1}')"
    printf '%s\n' "$known_hashes" | grep -qxF "$d" && to_redact+=("$tok")
  done
fi

# ---- Pass 3: gitleaks breadth net (best-effort; never fail the hook) ------------------------------
if command -v gitleaks >/dev/null 2>&1; then
  rep="$(mktemp)"
  printf '%s' "$resp" | jq -r '[.. | strings] | join("\n")' 2>/dev/null |
    gitleaks stdin --no-banner -c "$GITLEAKS_CONFIG" --report-format json --report-path "$rep" >/dev/null 2>&1 || true
  while IFS= read -r sec; do [ -n "$sec" ] && to_redact+=("$sec"); done < <(jq -r '.[].Secret // empty' "$rep" 2>/dev/null || true)
  rm -f "$rep"
fi

# Apply literal redactions for pass 2 + 3 (split/join = literal, regex-safe).
if [ "${#to_redact[@]}" -gt 0 ]; then
  for s in "${to_redact[@]}"; do
    resp="$(printf '%s' "$resp" | jq -c --arg s "$s" 'walk(if type == "string" then (split($s) | join("[REDACTED-SECRET]")) else . end)')"
  done
fi

# Nothing changed → pass through untouched.
[ "$resp" = "$orig" ] && exit 0

jq -cn --argjson u "$resp" '{
  systemMessage: "secret-redactor: masked secret-shaped material from a tool output. If this was a real key, ROTATE it.",
  hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: $u }
}'
exit 0
