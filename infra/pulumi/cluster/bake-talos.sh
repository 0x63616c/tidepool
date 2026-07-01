#!/usr/bin/env bash
# Bake a Talos snapshot on Hetzner from a committed Image Factory schematic.
#
# Hetzner has NO image-from-URL API, so `hcloud-upload-image` boots a THROWAWAY
# rescue server, streams the raw image onto its disk, snapshots it, then deletes
# the server (a few cents, ~2 min). That throwaway server is a LIVE billable
# resource, so this script runs ONLY at `pulumi up` (via a command.local.Command),
# NEVER at `pulumi preview`. It is idempotent: if a snapshot already exists for
# this exact (talos-version, schematic-id), it is reused and NOTHING is created.
#
# Emits ONLY the numeric snapshot/image id on stdout (Pulumi captures it as the
# node `image`). All human-readable progress goes to stderr.
#
# Env: HCLOUD_TOKEN (required), TALOS_VERSION, SCHEMATIC_FILE.
set -euo pipefail

log() { echo "bake-talos: $*" >&2; }

: "${HCLOUD_TOKEN:?HCLOUD_TOKEN required}"
TALOS_VERSION="${TALOS_VERSION:?TALOS_VERSION required}"
SCHEMATIC_FILE="${SCHEMATIC_FILE:?SCHEMATIC_FILE required}"
ARCH="${ARCH:-x86}"
LOCATION="${LOCATION:-nbg1}"

# 1) Resolve the schematic id (sha256 the factory computes over the schematic).
log "resolving schematic id from ${SCHEMATIC_FILE} ..."
SCHEMATIC_ID=$(
	curl -fsSL -X POST --data-binary @"${SCHEMATIC_FILE}" \
		https://factory.talos.dev/schematics | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p'
)
[ -n "${SCHEMATIC_ID}" ] || {
	log "FAILED to resolve schematic id"
	exit 1
}
SHORT="${SCHEMATIC_ID:0:12}"
log "schematic id=${SCHEMATIC_ID}"

# 2) Reuse an existing snapshot for this (version, schematic) if present (idempotent).
SELECTOR="os=talos,talos-version=${TALOS_VERSION},schematic=${SHORT}"
EXISTING=$(hcloud image list --type snapshot --selector "${SELECTOR}" \
	-o noheader -o columns=id 2>/dev/null | head -1 || true)
if [ -n "${EXISTING}" ]; then
	log "reusing existing snapshot ${EXISTING} (selector ${SELECTOR})"
	echo "${EXISTING}"
	exit 0
fi

# 3) Bake. hcloud-upload-image creates + destroys the throwaway server itself.
IMAGE_URL="https://factory.talos.dev/image/${SCHEMATIC_ID}/${TALOS_VERSION}/hcloud-amd64.raw.xz"
log "baking snapshot from ${IMAGE_URL} (this creates a THROWAWAY server, ~2 min) ..."
hcloud-upload-image upload \
	--image-url "${IMAGE_URL}" \
	--architecture "${ARCH}" \
	--compression xz \
	--location "${LOCATION}" \
	--description "talos-${TALOS_VERSION}-${SHORT}" \
	--labels "${SELECTOR//,/ }" >&2

# 4) Emit the resulting snapshot id.
SNAP=$(hcloud image list --type snapshot --selector "${SELECTOR}" \
	-o noheader -o columns=id 2>/dev/null | head -1)
[ -n "${SNAP}" ] || {
	log "FAILED: snapshot not found after bake"
	exit 1
}
log "baked snapshot ${SNAP}"
echo "${SNAP}"
