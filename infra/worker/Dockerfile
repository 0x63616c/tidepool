# Local worker harness image — the #9 local artifact that MIRRORS the cloud
# snapshot. It RUNs the exact same bake.sh recipe the Hetzner snapshot is baked
# from (single source of truth), so "works locally" means "works on the box".
#
# This is NOT built in CI yet; it is authored here to stay in lockstep with
# bake.sh. The cloud path bakes bake.sh into a Hetzner snapshot; this path bakes
# the identical steps into a local Docker image plus an sshd so the runner can
# reach it over SSH exactly as it reaches a real worker.
#
#   docker build -f infra/worker/Dockerfile -t tidepool-worker .
#
# Stock base matches the cloud image (ubuntu-24.04). The packages installed here
# mirror cloud-init's `packages: [git, curl, unzip]` (plus ca-certificates for
# TLS and openssh-server for the SSH front door cloud-init gets for free).
FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    unzip \
    ca-certificates \
    openssh-server \
  && rm -rf /var/lib/apt/lists/*

# Bake the worker recipe — identical steps to the cloud snapshot. Everything the
# runner needs (bun, opencode SDK + binary, auth dir) is present after this RUN.
COPY infra/worker/bake.sh /usr/local/share/tidepool/bake.sh
RUN bash /usr/local/share/tidepool/bake.sh

# SSH front door. The runner delivers JIT auth.json and drives work over SSH, so
# the local harness must accept root SSH the same way a freshly-booted worker
# does (key-based; the public key is injected at `docker run` time, not baked).
RUN mkdir -p /var/run/sshd /root/.ssh \
  && chmod 700 /root/.ssh

EXPOSE 22

# Foreground sshd keeps the container alive as a stand-in worker box.
CMD ["/usr/sbin/sshd", "-D", "-e"]
