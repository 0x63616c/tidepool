# agent-worker image — the ephemeral k8s Job that runs one work OR review agent.
# Builds FROM the shared base; adds the app source + deps. The entrypoint reads
# /app/config.json (mounted by the Job), dispatches on `kind`, and prints one
# RunnerResult/ReviewRunnerResult line to stdout, which the control plane's `poll`
# harvests. Creds arrive at RUNTIME via a mounted /secrets volume (copied to
# opencode's auth path by the entrypoint) — never baked in.
#
#   docker build -f infra/docker/agent-worker.Dockerfile -t tidepool-agent-worker .
ARG BASE_IMAGE=tidepool-base:latest
FROM ${BASE_IMAGE}

WORKDIR /app

# Install deps first (cached until the manifest changes), then copy source.
# --ignore-scripts: the `prepare` hook is dev-only (lefthook install) and there's
# no .git in the image; skipping lifecycle scripts is also the safer default for a
# production image.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

# One binary, two kinds — the config's `kind` selects work vs review.
ENTRYPOINT ["bun", "run", "src/worker/agent-worker.ts"]
