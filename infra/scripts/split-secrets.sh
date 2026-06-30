#!/usr/bin/env bash
# split-secrets.sh — ONE-SHOT migration: explode secrets/tidepool.enc.yaml into
# one encrypted file per secret (renamed + commented). Safe to re-run; it
# overwrites the per-file outputs and only deletes the old blob once all
# fidelity checks pass.
#
# Run locally with the breakglass key, or on the box with the mainbox key:
#   SOPS_AGE_KEY_FILE=<(op read "op://<vault>/tidepool/age-breakglass-key") \
#     bash infra/scripts/split-secrets.sh
#
# Requires: sops, age, ssh-keygen on PATH, and a key that can decrypt the blob.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OLD="$REPO/secrets/tidepool.enc.yaml"
SEC="$REPO/secrets"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT          # plaintext temp dir shredded on exit
umask 077

[ -f "$OLD" ] || { echo "no $OLD (already migrated?)"; exit 1; }

# Decrypt one old top-level key and re-encrypt it as its own per-file secret.
#   $1 = old key name  $2 = new file/key name  $3 = comment-block file
emit() {
  local old="$1" new="$2" cmt="$3"
  # byte-fidelity: pipe the scalar straight to a temp file (NO $() — preserves newlines)
  sops -d --extract "[\"$old\"]" "$OLD" >"$TMP/$new.val"
  # build plaintext yaml: comment block + literal-block scalar (| keeps one trailing \n)
  {
    cat "$cmt"
    printf '%s: |\n' "$new"
    sed 's/^/  /' "$TMP/$new.val"
  } >"$TMP/$new.yaml"
  # encrypt in place — path_regex in .sops.yaml selects the recipient set
  cp "$TMP/$new.yaml" "$SEC/$new.enc.yaml"
  sops -e -i "$SEC/$new.enc.yaml"
  echo "  ✓ $SEC/$new.enc.yaml"
}

# --- encrypted comment blocks (sealed alongside each value) ---
cat >"$TMP/c_hcloud" <<'EOF'
# Hetzner Cloud API token. Consumer: control plane provisions worker boxes
# (src/hetzner-box.ts); (future) Pulumi-in-CI. rotate: regen in Hetzner console,
# sops edit, redeploy, revoke old. owner: calum
EOF
cat >"$TMP/c_github" <<'EOF'
# GitHub PAT for the reconciler/Forge (clone, push branches, open/merge PRs).
# CI does NOT use this — it has its own native GITHUB_TOKEN. rotate: regen PAT,
# sops edit, redeploy, revoke old. Prefer a GitHub App token long-term. owner: calum
EOF
cat >"$TMP/c_opencode" <<'EOF'
# opencode auth.json — the AgentRunner subscription credential (@opencode-ai/sdk).
# Consumer: AgentRunner on the main box. rotate: re-run opencode auth, sops edit.
# owner: calum
EOF
cat >"$TMP/c_ssh" <<'EOF'
# Single shared Tidepool fleet SSH identity (ed25519, infra/bootstrap/collect.sh).
# PUBLIC half = Hetzner key "tidepool" (SSH_KEY_ID 114362250), in root@authorized_keys
# on the MAIN box AND every worker. PRIVATE half: control plane SSHes out to workers
# (src/agent-runner.ts) AND operator SSHes into all boxes. NOT worker-specific.
# rotate: regen on box, sops updatekeys, redeploy authorized_keys. owner: calum
EOF

echo "splitting $OLD ..."
emit hcloud_token           hcloud_api_token           "$TMP/c_hcloud"
emit github_token           forge_github_token         "$TMP/c_github"
emit opencode_auth_json     runner_opencode_auth_json  "$TMP/c_opencode"
emit ssh_worker_private_key ssh_tidepool_private_key   "$TMP/c_ssh"

# --- fidelity gate: SSH key must still derive the SAME public key ---
echo "verifying ssh key fidelity ..."
sops -d --extract '["ssh_tidepool_private_key"]' \
  "$SEC/ssh_tidepool_private_key.enc.yaml" >"$TMP/ssh.new"
chmod 600 "$TMP/ssh.new"
NEWPUB="$(ssh-keygen -y -f "$TMP/ssh.new" | awk '{print $1, $2}')"
OLDPUB="$(sops -d --extract '["ssh_worker_private_key"]' "$OLD" \
  | ssh-keygen -y -f /dev/stdin | awk '{print $1, $2}')"
[ "$NEWPUB" = "$OLDPUB" ] || {
  echo "FATAL: ssh pubkey mismatch — NOT deleting old blob"; exit 1;
}
echo "  ✓ ssh pubkey matches ($NEWPUB)"

# --- all checks passed: remove the old blob ---
rm -f "$OLD"
echo "done. removed $OLD. review 'git status', then commit the per-file secrets."
