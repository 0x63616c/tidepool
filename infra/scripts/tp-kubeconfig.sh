#!/usr/bin/env bash
# tp-kubeconfig.sh — fetch the live cluster kubeconfig into ~/.kube so `kubectl`
# works locally. The kubeconfig is a *secret output* of the `tidepool-cluster`
# Pulumi stack, so getting it means: decrypt the S3 state creds + config
# passphrase (sops), log in to the S3 state backend, and read the stack output.
# This wraps that sequence — same backend URL + secrets CI uses (.github/
# workflows/infra.yml), so there is one way to reach the stack (tenet 10).
#
# Tenet 9 (secrets stay home): the age master key never leaves your machine.
# Secret material is only ever held in this process's env or written 0600 to
# the kubeconfig — never printed.
#
# Reachability: the apiserver (:6443) is firewalled to the operator admin /32
# (NordVPN dedicated static IP). Off that IP, the fetch still succeeds but
# `kubectl` calls time out — connect the VPN first.
#
# Idempotent: overwrites the kubeconfig on every run.
set -euo pipefail

# Repo root, whatever the cwd — this script lives at infra/scripts/.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS="$REPO/secrets"
CLUSTER_DIR="$REPO/infra/pulumi/cluster"
STACK="production"

# Where the kubeconfig lands. Self-named cluster/context = `tidepool` /
# `admin@tidepool`, so no extra `kubectl config set-context` is needed.
KUBECONFIG_OUT="${TIDEPOOL_KUBECONFIG:-$HOME/.kube/tidepool.yaml}"

# S3 state backend — must match .github/workflows/infra.yml exactly.
BACKEND_URL='s3://tidepool-pulumi-state?endpoint=nbg1.your-objectstorage.com&s3ForcePathStyle=true&region=nbg1'

# Anything secret is written 0600; the kubeconfig inherits this via umask.
umask 077

# Decrypt one per-file secret (file name == top-level key == secret name).
sec() { sops -d --extract "[\"$1\"]" "$SECRETS/$1.enc.yaml"; }

# Feed the S3 backend + stack decryption from sops — never touches disk unmasked.
# hetzner_s3_credentials holds two keys (access_key_id, secret_access_key), so
# extract each explicitly rather than via sec().
export PULUMI_BACKEND_URL="$BACKEND_URL"
AWS_ACCESS_KEY_ID="$(sops -d --extract '["access_key_id"]' "$SECRETS/hetzner_s3_credentials.enc.yaml")"
AWS_SECRET_ACCESS_KEY="$(sops -d --extract '["secret_access_key"]' "$SECRETS/hetzner_s3_credentials.enc.yaml")"
PULUMI_CONFIG_PASSPHRASE="$(sec pulumi_config_passphrase)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY PULUMI_CONFIG_PASSPHRASE

# Log in to the state backend (its checksum WARN on S3 reads is harmless noise).
pulumi login "$PULUMI_BACKEND_URL" >/dev/null 2>&1

cd "$CLUSTER_DIR"
pulumi stack select "$STACK" >/dev/null 2>&1

mkdir -p "$(dirname "$KUBECONFIG_OUT")"
pulumi stack output kubeconfig --show-secrets >"$KUBECONFIG_OUT"
chmod 600 "$KUBECONFIG_OUT"

# Pin the control-plane namespace into the context so `kubectl get pods` targets
# `tidepool` (not `default`) whenever this context is active — no --namespace to
# remember. Re-applied on every refresh since we rewrite the file wholesale.
kubectl --kubeconfig "$KUBECONFIG_OUT" config set-context admin@tidepool \
  --namespace tidepool >/dev/null

echo "tp-kubeconfig: wrote $KUBECONFIG_OUT (context admin@tidepool, namespace tidepool)"
echo "  use it: export KUBECONFIG=$KUBECONFIG_OUT   # then: kubectl get nodes"
echo "  (apiserver :6443 is firewalled to the admin /32 — connect the VPN first)"
