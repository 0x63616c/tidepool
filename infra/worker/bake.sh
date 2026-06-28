#!/usr/bin/env bash
# Worker image recipe — the SINGLE SOURCE OF TRUTH for "what's inside a worker".
#
# Two consumers inline this exact recipe so they can never drift:
#   1. cloud-init (src/hetzner-box.ts `workerCloudInit`) reads these command lines
#      and runs them on first boot of a stock ubuntu-24.04 box.
#   2. the prebaked snapshot / local harness (infra/worker/Dockerfile) RUNs this
#      script at build time so the steps are already done before the box boots.
#
# Keep this list to commands only (no shebang/comment/blank lines are inlined by
# cloud-init): every non-comment line below is joined with `; ` into the runcmd.
#
# Deliberately NOT here: `touch /tmp/.tp-ready`. That sentinel is a per-boot
# signal the runner polls before delivering auth — not a baked step. The image
# already has everything installed, but the sentinel must still be created on
# every boot, so it stays in cloud-init only.
#
# HOME is unset in cloud-init's runcmd context and the bun installer needs it
# (bun lands in $HOME/.bun), so export it explicitly. `set -e` fails fast; `-u`
# is omitted because the third-party install scripts reference optional vars.
set -ex
export HOME=/root
curl -fsSL https://bun.sh/install | bash
# bun install also populates the global package cache the runner reuses.
/root/.bun/bin/bun add -g @opencode-ai/sdk@1.17.11
# opencode binary (spawned by createOpencodeServer): the curl installer's -b flag
# is broken ("Binary not found"), so install the npm package the same way as the
# SDK — it ships the binary onto the bun global bin (already on the runner PATH).
/root/.bun/bin/bun add -g opencode-ai@1.17.11
# ensure opencode auth dir exists; JIT auth.json is delivered over SSH at runtime.
mkdir -p /root/.local/share/opencode
