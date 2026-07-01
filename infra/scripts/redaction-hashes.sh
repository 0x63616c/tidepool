#!/usr/bin/env bash
# Seal-time redaction-hash generator + entropy gate.
#
# For every secrets/*.enc.yaml, decrypt (sops), take each leaf STRING value, and:
#   1. HASHABILITY — only single-line values within the redactor's token class are hashed; multi-line
#      (PEM) / punctuated (JSON) values are noted and left to the shape-regex + gitleaks passes.
#   2. ENTROPY-GATE — estimated keyspace bits (length x log2 of the char classes present) must be
#      >= MIN_ENTROPY_BITS, else fail. Stops a weak secret's hash from being brute-forced once committed.
#   3. sha256 it and collect the digest.
# The digests are written to .claude/redaction-hashes.json, which the PostToolUse redaction hook reads
# to mask our EXACT known secret values in tool output — catching shapeless tokens (hcloud, S3 secret)
# that pattern/gitleaks scanning cannot.
#
# Plaintext NEVER leaves this process: values are hashed in-memory and never printed. Only digests
# (one-way, safe to commit) are written.
#
# Usage:
#   redaction-hashes.sh          # regenerate .claude/redaction-hashes.json  (the `seal:hashes` script)
#   redaction-hashes.sh --check  # verify entropy + that the committed file is in sync (the `check:secrets` script)
#
# Needs SOPS_AGE_KEY (dev: direnv+keychain). If unset, --check SKIPS with a warning (CI/other machines
# cannot decrypt mainbox/breakglass secrets — the gitleaks CI job is the backstop there).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_DIR="$ROOT/secrets"
OUT="$ROOT/.claude/redaction-hashes.json"
MIN_ENTROPY_BITS=80 # offline-brute-force-infeasible floor; real credentials (incl. ~20-char S3 keys) clear it, weak passphrases fail.

mode="generate"
[ "${1:-}" = "--check" ] && mode="check"

if [ -z "${SOPS_AGE_KEY:-}" ] && [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
  echo "redaction-hashes: SOPS_AGE_KEY unset — skipping (cannot decrypt without the key)." >&2
  exit 0
fi

# Estimated brute-force strength = length * log2(size of the character CLASSES present). This models
# the keyspace an attacker must search. (A per-sample Shannon estimate underrates short high-entropy
# tokens — e.g. a 20-char AKIA-style key — and overrates long structured text, so it's the wrong gate.)
# Reads the value on stdin so it never appears in argv/process list.
entropy_bits() {
  awk '
    {
      s = $0; n = length(s); lo = up = di = sy = 0
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c ~ /[a-z]/) lo = 26
        else if (c ~ /[A-Z]/) up = 26
        else if (c ~ /[0-9]/) di = 10
        else sy = 16
      }
      alpha = lo + up + di + sy
      if (alpha < 2 || n == 0) { print 0; exit }
      printf "%d", n * (log(alpha) / log(2))
      exit
    }'
}

# 1 iff the value is a SINGLE-LINE run entirely within the redactor's token class (so hash-match can
# catch it). Multi-line (PEM) or punctuated (JSON) values return 0 → hashing them is useless.
is_token() {
  awk 'BEGIN { ok = 1 } { if (NR > 1 || $0 !~ /^[A-Za-z0-9+\/._=-]+$/) ok = 0 } END { print ok + 0 }'
}

sha256_stdin() { openssl dgst -sha256 -r | awk '{print $1}'; }

declare -a digests=()
shopt -s nullglob
for f in "$SECRETS_DIR"/*.enc.yaml; do
  # Decrypt to JSON; iterate leaf strings @base64-encoded so multi-line values stay intact (one per
  # line). `sops -d` output stays in this pipeline, never to a tty.
  while IFS= read -r b64; do
    [ -z "$b64" ] && continue
    leaf="$(printf '%s' "$b64" | openssl base64 -A -d 2>/dev/null || true)"
    [ -z "$leaf" ] && continue
    if [ "${#leaf}" -lt 12 ] || [ "$(printf '%s' "$leaf" | is_token)" != 1 ]; then
      echo "redaction-hashes: note — a value in $(basename "$f") is not single-token-hashable (multi-line/punctuation or <12 chars); relies on shape+gitleaks coverage. (value not shown)" >&2
      continue
    fi
    bits="$(printf '%s' "$leaf" | entropy_bits)"
    if [ "$bits" -lt "$MIN_ENTROPY_BITS" ]; then
      echo "redaction-hashes: FAIL — a hashable secret value in $(basename "$f") has only ~${bits} bits keyspace (< ${MIN_ENTROPY_BITS}). Weak secret; rotate to a high-entropy value. (value not shown)" >&2
      exit 1
    fi
    digests+=("$(printf '%s' "$leaf" | sha256_stdin)")
  done < <(sops -d --output-type json "$f" | jq -r '[.. | strings][] | @base64')
done

# Deterministic, deduped digest list.
hashes_json="$(printf '%s\n' "${digests[@]}" | sort -u | jq -R . | jq -s '{algo: "sha256", hashes: .}')"

if [ "$mode" = "check" ]; then
  if [ ! -f "$OUT" ]; then
    echo "redaction-hashes: FAIL — $OUT missing. Run 'bun run seal:hashes'." >&2
    exit 1
  fi
  if ! diff <(jq -S . "$OUT") <(printf '%s' "$hashes_json" | jq -S .) >/dev/null; then
    echo "redaction-hashes: FAIL — $OUT is out of sync with the sealed secrets. Run 'bun run seal:hashes'." >&2
    exit 1
  fi
  echo "redaction-hashes: OK — entropy gate passed, hash list in sync." >&2
else
  printf '%s\n' "$hashes_json" >"$OUT"
  echo "redaction-hashes: wrote $(printf '%s' "$hashes_json" | jq '.hashes | length') digest(s) to $OUT" >&2
fi
