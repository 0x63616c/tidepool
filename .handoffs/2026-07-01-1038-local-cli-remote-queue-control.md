# Handoff — local `tp` CLI driving prod (remote "queue control")

**Focus for next session:** discuss + implement running the `tp` CLI **locally, pointed at
production**, instead of `kubectl exec`-ing into the control-plane pod. The user wants the CLI to be
the driver's seat for the queue ("queue control"), not a pod-exec chore.

## Context: what works now (don't re-derive)

The autonomous loop is fully proven on live pg/k8s as of 2026-07-01 — see memory
`e2e-autonomous-loop-proven.md` and `dispatch-tls-ca-trust.md`. Ticket → worker → PR → CI → review →
autonomous merge all work. Auto-deploy CD is live (merge → build → resolve digest → apply → reroll).

Today a ticket is created only by exec-ing into the pod:
```
kubectl exec deploy/tidepool-control-plane -- bun run src/cli.ts ticket add \
  --title "..." --goal "..." --target 0x63616c/tidepool-testbed
```
`tp ticket add/ls/trace/logs/transcript` are in `src/cli.ts`. The reconciler daemon
(`reconcileForever`, `src/reconciler.ts`) runs in-pod and claims tickets from the store every 30s.

## Why exec-in-pod today

The CLI is a **Postgres client**: `TIDEPOOL_DB_DRIVER=pg` + `TIDEPOOL_PG_URL=<dsn>` →
`makePgTicketStore` (`src/runtime.ts`, `src/pg-store.ts`). Postgres is CNPG, in-cluster only (no
public inbound — tenet 9). So the only place the DSN resolves is inside a pod that has the secret.

Concrete facts for either approach:
- CNPG cluster `tidepool-pg`, namespace `tidepool`. Read-write Service: `tidepool-pg-rw` (port 5432).
- DSN lives in k8s Secret `tidepool-pg-app`, key `uri` (see `PG_APP_SECRET` / `PG_URL_SECRET_KEY` in
  `infra/pulumi/cluster/control-plane-deployment.ts`). Its host is the in-cluster service name.
- kubectl access: `bun run kube` (`infra/scripts/tp-kubeconfig.sh`); apiserver firewalled to the
  operator admin /32 (NordVPN static IP).

## The design decision to make (discuss first)

**Option A — local CLI as pg client over `kubectl port-forward` (fast path).**
`kubectl port-forward -n tidepool svc/tidepool-pg-rw 5432:5432`, pull the DSN from
`tidepool-pg-app` (rewrite host → `localhost`), `TIDEPOOL_DB_DRIVER=pg`, run `tp` locally. Wrap it in
a helper (e.g. `bun run tp -- ticket add …` that sets up the forward + DSN). Pros: minimal, reuses
the CLI-as-pg-client design, no new server. Cons: laptop holds the pg DSN + writes the DB directly
(consistent with today — the CLI already is the writer — but no API/validation seam); port-forward
must be running.

**Option B — control-plane HTTP API + thin CLI client (recommended for real "queue control").**
The control-plane exposes an authenticated HTTP API (`@effect/platform` `HttpApi`) for ticket ops
(add / ls / trace / cancel / logs); `tp` becomes a client (`HttpClient`) hitting it. Reach it via
`kubectl port-forward svc/tidepool-control-plane` (outbound-initiated → still **no public inbound**,
honours tenet 9) or, later, a /32-firewalled ingress like the apiserver. Pros: proper deep-module
seam, no DB creds on the laptop, real queue-control surface that a web UI could reuse later, keeps
the reconciler as the only mover. Cons: more to build (define the API, auth, wire it into the
Deployment as a ClusterIP service). Tenets to respect: **tenet 9** (must not become public inbound —
keep it port-forward or /32-firewalled), **tenet 10** (one HTTP layer — `@effect/platform`, no raw
fetch), **tenet 3** (CLI/API only enqueues state; the reconciler still moves it).

**Option C — a `tp` wrapper that just hides the `kubectl exec`.** Cheapest, but not "local CLI" and
keeps the pod dependency. Likely rejected given the user's intent.

Recommendation to bring to the user: **B is the right seam** ("CLI really driving this"), with **A as
a quick interim** if they want remote ticket creation today. Confirm which before building.

## Suggested skills

- `superpowers:brainstorming` — settle the A-vs-B design with the user before coding (do this first).
- `design-an-interface` / `codebase-design` — design the control-plane API surface + the CLI/store
  seam as a deep module (Option B).
- `effect-ts` — `HttpApi` server + `HttpClient` client, layers, typed errors (both live in this repo).
- `tdd` — red-first per repo convention (tenet 12).
- `no-mistakes` / `/review` — gate before merge; every change ships as a green merged PR (golden rule).

## Watch-outs

- `--target` must be a **configured** target in `tidepool.config.ts` (only `0x63616c/tidepool-testbed`
  today); an unconfigured repo silently falls back to default models.
- Don't expose pg or any API to the public internet (tenet 9). Port-forward is the safe default.
- Follow the repo standards mechanically (IDs, branch/commit format, Biome, Effect-only I/O). See
  `AGENTS.md`.

## Also-open follow-ups (unrelated to this task, from `e2e-autonomous-loop-proven.md`)

Thread review feedback into the re-work prompt; auto-close PR on retry-exhaustion (PR #12 orphaned
open on testbed); `box_`/`provider` vestigial in run records + old `tp-main` box teardown; barman #47
preview cosmetically red; DESIGN.md deploy/box sections partly stale.
