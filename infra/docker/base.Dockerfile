# Shared base image — bun + opencode + git. Both tidepool images (control-plane,
# agent-worker) build FROM this, so the expensive apt + opencode install is done
# once and cached. This Dockerfile is the sole definition of the base image's
# toolchain (opencode SDK + binary at pinned versions); the per-image Dockerfiles
# add the app source. Repo-agnostic on purpose: no app source here, only the
# toolchain.
#
#   docker build -f infra/docker/base.Dockerfile -t tidepool-base:latest .
FROM oven/bun:1.2

# Run as root so the bun global bin + opencode auth dir land under /root, matching
# the layout the runner expects.
USER root
ENV HOME=/root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    unzip \
    ca-certificates \
    shellcheck \
  && rm -rf /var/lib/apt/lists/*

# shfmt: same pinned version CI installs (.github/workflows/ci.yml), so agents'
# local `bun run check` (lint:sh) matches CI exactly.
RUN curl -sSfL https://github.com/mvdan/sh/releases/download/v3.10.0/shfmt_v3.10.0_linux_amd64 -o /usr/local/bin/shfmt \
  && chmod +x /usr/local/bin/shfmt

# opencode: the SDK (imported by the runner) + the binary (spawned by
# createOpencodeServer), at pinned versions.
RUN bun add -g @opencode-ai/sdk@1.17.11 opencode-ai@1.17.11

# Put the bun global bin (where `bun add -g` links opencode) on PATH, and create
# opencode's auth dir. The auth.json itself is delivered at RUNTIME via a mounted
# /secrets volume — never baked in (no secret in an image).
ENV PATH="/root/.bun/bin:${PATH}"
RUN mkdir -p /root/.local/share/opencode
