# control-plane image — the one always-on reconciler. Runs `tp run --watch`
# (the reconcileForever loop, src/cli.ts). Builds FROM the shared base; adds the
# app source + its dependencies. It never dispatches agents itself (that's the
# agent-worker Job), but shares the base for one toolchain.
#
#   docker build -f infra/docker/control-plane.Dockerfile -t tidepool-control-plane .
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

# The always-on reconcile loop. Config/secrets/datastore are provided at runtime
# (k8s wiring lands in a later PR); override the command for a one-shot smoke.
CMD ["bun", "run", "src/cli.ts", "run", "--watch"]
