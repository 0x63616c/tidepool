#!/usr/bin/env bash
# materialize-secrets.sh — turn the sops-encrypted bundle into the on-box runtime
# layout the control plane reads. Runs as the systemd ExecStartPre on the main box.
#
# Tenet 9 (secrets stay home): the age master key NEVER leaves the box. This is
# the one place the bundle is decrypted, JIT, into 0600 files on local disk.
#
# Idempotent: every output is a full overwrite of a private file, so re-running
# (every service (re)start) just refreshes the layout — safe to call repeatedly.
set -euo pipefail

REPO="${TIDEPOOL_REPO_DIR:-/opt/tidepool}"
ENC="$REPO/secrets/tidepool.enc.yaml"
BOOT="${TIDEPOOL_BOOTSTRAP_DIR:-/root/.tidepool/bootstrap}"
ENV_DIR=/etc/tidepool
ENV_FILE="$ENV_DIR/env"
DB_PATH="${TIDEPOOL_DB_PATH:-/mnt/tidepool/tidepool.sqlite}"

# sops decrypts with the box's age master key. The systemd unit's
# ConditionPathExists guards on this same file, so this script only ever runs
# once the operator has delivered the key.
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$BOOT/age-mainbox.key}"

# All secret material is written 0600; new files inherit that via umask.
umask 077
mkdir -p "$BOOT"
chmod 700 "$BOOT"
mkdir -p "$ENV_DIR"
chmod 755 "$ENV_DIR"

# Pull a single top-level key out of the encrypted bundle (decrypt in memory).
extract() { sops -d --extract "[\"$1\"]" "$ENC"; }

# 1. Hetzner token — worker provisioning (src/hetzner-box.ts).
extract hcloud_token >"$BOOT/hcloud_token"
chmod 600 "$BOOT/hcloud_token"

# 2. opencode auth.json — the agent subscription credential.
extract opencode_auth_json >"$BOOT/opencode-auth.json"
chmod 600 "$BOOT/opencode-auth.json"

# 3. Shared SSH key to reach workers, plus its derived public half.
extract ssh_worker_private_key >"$BOOT/ssh-tidepool"
chmod 600 "$BOOT/ssh-tidepool"
ssh-keygen -y -f "$BOOT/ssh-tidepool" >"$BOOT/ssh-tidepool.pub"
chmod 644 "$BOOT/ssh-tidepool.pub"

# 4. systemd EnvironmentFile — runtime config + the secrets the process reads
#    directly from its environment.
{
  echo "TIDEPOOL_DB_PATH=$DB_PATH"
  echo "HCLOUD_TOKEN=$(extract hcloud_token)"
  echo "GITHUB_TOKEN=$(extract github_token)"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "materialize-secrets: refreshed $BOOT layout + $ENV_FILE"
