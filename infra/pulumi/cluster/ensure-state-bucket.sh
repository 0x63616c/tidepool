#!/usr/bin/env bash
# Ensure the self-managed Pulumi state bucket exists — the bootstrap seam.
#
# Pulumi's state lives in `tidepool-pulumi-state` (Hetzner Object Storage), but Pulumi
# CANNOT create the bucket its own backend reads from (circular: it needs the state to
# plan the state). So the bucket is the one legitimately un-Pulumi'd resource. Rather
# than a manual `aws s3 mb` a human must remember, this idempotent step recreates it from
# the sops-decrypted S3 keys the deploy job already exports — making a keys-only cold
# start (scorched-earth teardown → CI rebuild) fully hands-free.
#
# Hetzner's Ceph RGW is idempotent on CreateBucket (200 on an already-owned bucket
# in-region — see cnpg.ts), so a normal deploy re-runs this as a no-op. Call shape mirrors
# the Pulumi-managed pg-backups bucket: plain create-bucket, path-style endpoint, nbg1
# region, NO LocationConstraint (RGW rejects the AWS-only constraint body). Fail closed on
# any error that is NOT "already owned" — a real credential/endpoint fault must stop the
# deploy, never silently skip and let `pulumi up` fail against a missing backend.
#
# Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (required — the surviving keys).
#      STATE_BUCKET, S3_ENDPOINT, AWS_REGION override the defaults below.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"
BUCKET="${STATE_BUCKET:-tidepool-pulumi-state}"
ENDPOINT="${S3_ENDPOINT:-https://nbg1.your-objectstorage.com}"
REGION="${AWS_REGION:-nbg1}"

log() { echo "ensure-state-bucket: $*" >&2; }

log "ensuring ${BUCKET} at ${ENDPOINT} (region ${REGION}) ..."
if err=$(aws s3api create-bucket \
	--bucket "${BUCKET}" \
	--endpoint-url "${ENDPOINT}" \
	--region "${REGION}" 2>&1); then
	log "ensured ${BUCKET} (created, or RGW-idempotent adopt)"
	exit 0
fi

# Not a 200 — classify. Only an already-owned/exists conflict is a no-op success; anything
# else (AccessDenied, endpoint unreachable, bad creds) fails the deploy closed.
if echo "${err}" | grep -qiE "BucketAlreadyOwnedByYou|BucketAlreadyExists|already (owned|exists)"; then
	log "${BUCKET} already exists — no-op"
	exit 0
fi

log "FAILED to ensure ${BUCKET}:"
echo "${err}" >&2
exit 1
