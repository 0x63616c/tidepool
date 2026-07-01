#!/usr/bin/env bash
# PreToolUse(Bash) guard — reduce the blast radius of secret-printing commands BEFORE they run.
#
# NOT a sandbox. It inspects only the top-level command string, so a determined agent can still leak
# (write-a-script-then-run-it, ${!indirect} name construction, encode-then-print). The real containment
# is least-privilege (don't put the key in the env) + egress control + rotation. This raises the cost
# of the common/naive leak and the obvious exfil vectors.
#
# Model: deny/ask on any command that READS a known secret env var (directly `$VAR`, or via an
# env-access idiom: printenv/ENVIRON[]/os.environ[]/getenv) — not an enumerated printer list.
#   • DENY  — reads a known secret var AND sends it somewhere visible/outbound (a leaky/exfil tool,
#             a pipe, or a stdout device); bare `sops -d`/exec to stdout.
#   • ASK   — reads a known secret var with no obvious sink; broad `*_TOKEN/_KEY/_SECRET` var to a
#             sink; `sops -d | tool`; `sops exec-*`; full env dumps.
#   • ALLOW — assignment that doesn't read a secret; `sops -d` to a real file / /dev/null.
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")"
[ -z "$cmd" ] && exit 0

deny() {
  echo "secret-command-guard: BLOCKED — $1 Never send secret material to a printer/pipe/network; derive to a file/hash instead." >&2
  exit 2
}
ask() {
  jq -cn --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
  exit 0
}
match() { printf '%s' "$cmd" | grep -Eq "$1"; }

# Known in-env secrets (deny-tier) and the broad heuristic name pattern (ask-tier).
KNOWN='(SOPS_AGE_KEY|SOPS_AGE_KEY_FILE|HCLOUD_TOKEN|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|ANTHROPIC_API_KEY|PULUMI_CONFIG_PASSPHRASE)'
BROAD='\$\{?[A-Z][A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b'
# Commands that make data visible (stdout) or send it off-box.
LEAKY='(echo|printf|print|printenv|cat|tee|head|tail|xxd|base64|base32|od|hexdump|strings|sed|awk|gawk|perl|python3?|ruby|node|dd|curl|wget|nc|ncat|socat|ssh|scp|sftp|tftp|mail|mailx|sendmail)'

# READS a known secret var: literal `$VAR`/`${VAR}`, or an env-access idiom naming it (catches
# `printenv VAR`, `$(printenv VAR)`, awk ENVIRON["VAR"], python os.environ["VAR"], getenv("VAR")).
reads_known=false
if match "\\\$\\{?${KNOWN}\\b" || match "(printenv|ENVIRON|environ|getenv|ENV)[^A-Za-z0-9_]{0,4}[\"']?${KNOWN}\\b"; then
  reads_known=true
fi

# Sinks: a leaky/exfil command token (word-bounded so `base64<<<` counts), a pipe, or a stdout device.
has_sink=false
if match "(^|[^A-Za-z0-9_])${LEAKY}([^A-Za-z0-9_]|\$)" ||
  match '([^|]|^)\|([^|]|$)' ||
  match '>[[:space:]]*(/dev/stdout|/dev/fd/|/proc/self/fd/1|/dev/tty)'; then
  has_sink=true
fi

if [ "$reads_known" = true ]; then
  if [ "$has_sink" = true ]; then
    deny "reads a known secret env var and pipes/prints/exfiltrates it."
  fi
  ask "reads a known secret env var. Approve only if the value is not being printed, logged, or sent off-box."
fi

# ---- sops decrypt / exec ---------------------------------------------------------------------------
if match '(^|[;&|(`]|[[:space:]])sops([[:space:]]+-[A-Za-z]+)*[[:space:]]+(-d\b|--decrypt\b|decrypt\b)'; then
  match '([^|]|^)\|([^|]|$)' && ask "sops -d piped into another command. Approve ONLY if the pipe target emits a hash/public value, never the raw secret."
  # Allow ONLY when stdout goes to a real file / /dev/null — NOT a stdout device masquerading as a file.
  if match '(-o[[:space:]]|--output[[:space:]=]|(^|[[:space:]])1?>[[:space:]]*)(/dev/stdout|/dev/fd/|/proc/self/fd/[012]|/dev/tty|-)([[:space:]]|$)'; then
    deny "'sops -d' to a stdout device leaks the secret. Redirect to a real file."
  fi
  if match '(-o[[:space:]]|--output[[:space:]=])' || match '(^|[[:space:]])1?>[[:space:]]*([^|&;[:space:]]+|/dev/null)'; then
    exit 0
  fi
  deny "'sops -d' to stdout can leak the secret VALUE. Redirect to a real file (-o FILE / > FILE) or >/dev/null."
fi
if match '(^|[;&|(`]|[[:space:]])sops([[:space:]]+-[A-Za-z]+)*[[:space:]]+(exec-env|exec-file)\b'; then
  ask "sops exec-env/exec-file runs a child process with decrypted secrets in its environment. Approve only if the child cannot print/exfiltrate them."
fi

# ---- ASK: broad secret-shaped var to a sink, or a full env dump -----------------------------------
if [ "$has_sink" = true ] && match "$BROAD"; then
  ask "a secret-shaped variable (*_TOKEN/_KEY/_SECRET) is piped/printed/sent. Approve only if it is not sensitive."
fi
if match '(^|[;&|]|[[:space:]])(env|printenv|export[[:space:]]+-p|set)[[:space:]]*($|[|>;])'; then
  ask "dumps the full environment, which may include secret vars. Approve only if you know none are set."
fi

exit 0
