# Shared base image — bun + opencode + git. Both tidepool images (control-plane,
# agent-worker) build FROM this, so the expensive apt + opencode install is done
# once and cached. This is the container analogue of infra/worker/bake.sh (the
# Hetzner-box recipe); it installs the SAME opencode packages at the SAME pinned
# versions so "runs in the image" tracks "ran on the box". Repo-agnostic on
# purpose: no app source here, only the toolchain.
#
#   docker build -f infra/docker/base.Dockerfile -t tidepool-base:latest .
FROM oven/bun:1.2

# Run as root so the bun global bin + opencode auth dir land under /root, matching
# the box layout the runner expects.
USER root
ENV HOME=/root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    unzip \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# opencode: the SDK (imported by the runner) + the binary (spawned by
# createOpencodeServer). Same packages/versions as infra/worker/bake.sh so the
# two consumers can never drift.
RUN bun add -g @opencode-ai/sdk@1.17.11 opencode-ai@1.17.11

# Put the bun global bin (where `bun add -g` links opencode) on PATH, and create
# opencode's auth dir. The auth.json itself is delivered at RUNTIME via a mounted
# /secrets volume — never baked in (no secret in an image).
ENV PATH="/root/.bun/bin:${PATH}"
RUN mkdir -p /root/.local/share/opencode
