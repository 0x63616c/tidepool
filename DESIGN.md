# Tidepool — Design

> Agentic-coding control plane. A pool where small crab-agents come and go.
> Status: **design locked, scaffolding**. Date: 2026-06-27.

This file records every decision made during the initial design grill so nothing is lost.
It is the source of truth for *why* the system is shaped the way it is.

---

## 1. One-paragraph shape

The **control plane** runs as a Kubernetes **Deployment** (`reconciler`, namespace
`core`) on a Talos/Hetzner cluster — a TypeScript + Bun **reconciler loop** over a **Postgres**
ticket store (CloudNativePG cluster `pg`, the single source of truth for tickets). When
tickets exist, the reconciler **dispatches ephemeral k8s Jobs** (agents) through the async
**`K8sAgentWorker`** seam. Each Job runs a TS **runner** that embeds the **opencode TypeScript SDK**
to drive coding agents against a target GitHub repo: `branch → PR → review-agent →
auto-merge-on-green`. Models run via a **ChatGPT/Codex subscription** (OAuth, not metered API)
through opencode's `openai` provider. Infra is **declarative via Pulumi** applied in **GitHub Actions
CI** (merge to main auto-builds images and rerolls the Deployment to the current commit's digests).
Secrets via **sops + age**. You drive it with the **`tp`** CLI.

```
laptop ──(git push ticket file)──▶ GitHub ◀──(poll)── control plane (k8s Deployment)
                                                         │  reconciler + Postgres (CNPG) + transcripts
  tp ticket list/get/logs ──(port-forward; later Tailscale)▶ │
                                                         │ tickets queued
                                                         ▼
                                    K8sAgentWorker → dispatch ephemeral Job (poll workHandle)
                                                         │  TS runner + opencode SDK
                                                         ▼  clone target repo, work worktree
                                          work agent → branch → PR → review agent → auto-merge
```

> **How we got here — the async AgentWorker / k8s migration (completed 2026-07-01; see
> `.handoffs/`).** The system originally ran as a thin always-on Hetzner box with a sqlite store that
> **spun ephemeral Hetzner worker boxes** synchronously (one box per ticket, blocking on the agent).
> That is done and gone. The reconciler no longer leases a box and blocks: it **dispatches** an
> *agent-worker* (work or review) through the **`AgentWorker`** seam, stores an opaque **`workHandle`**
> + `dispatchedAt` on the ticket, moves it to the **`running`** state, and **polls** the handle each
> tick — `Succeeded` harvests the result, `Failed` retries/rate-caps, and a worker past its deadline is
> reaped (`cancel`). `BoxMaker` is gone. The live `AgentWorker` is **`K8sAgentWorker`** (dispatches
> ephemeral k8s Jobs); a **`LocalAgentWorker`** remains for local dev (runs opencode in-process).
> Worker creds flow through the **`CredentialBroker`** seam
> (`credsFor(job) → { opencodeAuth, githubToken }`) — a passthrough today (reads the existing PAT +
> opencode auth), the one-module swap point for future GitHub App tokens / auto-rotation, so the
> dispatch path never reads a secret directly (tenet 9). The **Talos/Pulumi Kubernetes cluster** is
> defined in `infra/pulumi/cluster/` (PR-5a) — a baked Talos snapshot, dedicated Hetzner network +
> firewall, a cpx32 control plane, CCM/CSI/cluster-autoscaler (min=0), and the
> namespace/NetworkPolicy/RBAC wall — with the **Postgres/CNPG** datastore (PR-5b) and the reconciler
> cutover (PR-6) swapping in as Layers with no reconciler change.
>
> **Cutover wiring (PR-6).** Both swaps are Layer selections gated by env, so switching backings is a
> deployment toggle, not a code change (and the default keeps local dev + `bun run check` on sqlite +
> the in-process worker — green with no cluster): `TIDEPOOL_DB_DRIVER=sqlite|pg` picks the durable
> `TicketStore` backing, `TIDEPOOL_AGENT_WORKER=local|k8s` picks the worker. Production runs `pg` +
> `k8s`. The `TicketStore` query layer is shared across both backings behind the one `@effect/sql` seam
> (`store-sql.ts`); only the driver, the insertion-order column, and schema setup differ. Under
> Postgres the schema is applied by **`PgMigrator` on control-plane boot** (`replicas:1 Recreate` ⇒
> exactly one migrator, self-locking, fail-fast → CrashLoopBackOff rather than a half-applied schema);
> the reconciler loop starts only after it succeeds. Existing sqlite state was carried over once by a
> **throwaway, idempotent sqlite→Postgres data-move Job** (`pg-data-move.ts`) that read through the
> domain types and hard-failed on any source/dest row-count mismatch (tenet 8), then was deleted. The
> pg DSN (`pg-rw.core.svc:5432`) + creds are runtime config (`Redacted`), never hardcoded.

---

## 2. Locked decisions

### Tech stack (locked — supersedes earlier OpenTofu/zod choices)
- **TypeScript + Bun**, one language across cli / reconciler / runner.
- **Effect (effect-ts)** as the backbone — adopted fully, not half:
  - `Layer`/`Context` = adapter DI → `Fake*` vs real impls are just swapped layers (fakes-first IS this).
  - `Scope`/`acquireRelease` = **guaranteed box teardown** (kills the "worker bills forever" footgun).
  - `Schedule` = retry/backoff/timeout (rate-caps, heartbeats, flaky boots).
  - Typed errors (`RateCapped`/`BoxFailed`/`MergeConflict`) in signatures, not `throw`.
  - Built-in **OpenTelemetry** tracing = per-ticket/run/agent spans → the observability requirement, free.
  - `@effect/schema` for validation (replaces zod). `@effect/cli` for `tp` (+ AXI output contracts).
- **Pulumi (TypeScript)** for infra, **not OpenTofu** — stack unity + shared types; **state in Hetzner
  Object Storage (S3, bucket `tidepool-pulumi-state`)**, self-managed and encrypted by the stack
  passphrase. Still declarative + CI-applied (`pulumi up` in Actions) → GitOps tenet intact.
- **Datastore = CloudNativePG (Postgres).** Runtime state (tickets/transcripts/usage) lives in a CNPG
  `Cluster` `pg` (`instances: 1`; DSN `pg-rw.core.svc:5432`) on `hcloud-volumes`
  PVCs (data + WAL), with daily `ScheduledBackup` → Hetzner S3 via the Barman Cloud **plugin** (CNPG
  1.30 dropped the in-tree store; the plugin needs cert-manager). The backup bucket
  (`pg-backups`) is **Pulumi-managed** — an `aws.s3.Bucket` under an `aws.Provider` aimed at
  the Hetzner S3 endpoint (creds from the ambient sops-decrypted env, never in state), so there is **no
  hand-created prerequisite** (tenet 2). Single instance now, **HA one field
  away** (`instances: 3`) — no schema change. Infra lands PR-5b; the app driver swaps
  `@effect/sql-sqlite-bun`→`@effect/sql-pg` at the PR-6 cutover (the dead `drizzle-orm`/`drizzle-kit`
  deps get deleted then too). `@effect/sql` layer + prefixed-id domain types are unchanged.
- **`mise`** pins bun/opencode/pulumi versions identically across local + CI + box (env parity).
- **Bun `$`** for git/ssh/hetzner shelling; **Octokit** for the GitHub `Forge`.
- Next session: pin exact versions (`npm view`), then build `src/` on this stack from line 1.

### Architecture
- **Cloud-resident brain, thin client.** Always-on main box holds ticket state + reconciler +
  transcripts. `tp` is a thin client that attaches/detaches. (Required by: "not on my computer",
  "out all day", "self-iterating".)
- **Two loops, distinct.** A *local* fast loop for hacking on Tidepool itself; the *cloud* agent
  fleet loop. Don't conflate them.
- **No Temporal.** The ticket DB **is** the durable state; a plain reconcile loop drives it.
  Crash → reread DB → resume. Temporal is a future swap-in behind the reconciler seam *only if it
  hurts*. (Rejected: "systems not needed at the right time".)
- **Reconciler is the only mover.** Everything is "reconcile DB state toward done." That is the
  durability and the audit log in one.

### Compute
> **Superseded by the AgentWorker migration (see the note under §Architecture).** `BoxMaker` is
> removed; compute + agent execution now sit behind the async **`AgentWorker`** seam
> (`dispatch`/`poll`/`cancel`/`reap`), live as `K8sAgentWorker` on the Talos/Pulumi cluster. The v0
> Hetzner box-maker *implementation* — `src/hetzner-box.ts`, `src/hetzner-volume.ts`, the SSH
> remote-work path in `agent-runner.ts`, and the `infra/worker/*` snapshot bake — was **deleted in
> PR-7**; the v0 text below is historical context only. The spend guardrail is now the deadline
> reaper (`now - dispatchedAt > deadline → cancel`) + k8s scale-to-zero, not
> `acquireRelease`-on-scope-close.
- **Box-maker behind a `BoxMaker` interface.** v0 impl = **direct Hetzner Cloud API** (`POST
  /v1/servers` from a prebaked snapshot + cloud-init; worker self-`DELETE`s on idle via metadata).
  **Crabbox dropped** — research verdict GREEN for direct: Tidepool already builds the governance
  Crabbox offers (cred isolation, spend caps, idle teardown, ticket-scoped leases), so its
  self-hosted coordinator is parallel infra with no net simplification. Crabbox stays a possible
  future `BoxMaker` impl (shell out to its CLI) if ever wanted. See RESEARCH.md §1.
  - NB: power-off does **not** stop Hetzner billing — only `DELETE`. Partial hours round up.
- **Design for N, run N=1.** The system is concurrency-capable by construction — `workers.max` is
  the single knob and nothing assumes 1. Elastic ephemeral workers, 0→N: 0 at rest, spin on demand,
  reuse while the queue is hot, **self-destruct on idle**. No warm pool. **We run N=1 for now**, for
  two independent reasons:
  - **auth:** one coordinated credential refresher (trivially satisfied at N=1; needs the broker at N>1).
  - **merge safety:** N=1 serializes tickets → each branches off the *latest* main and merges before
    the next starts → merge conflicts essentially can't occur.
- **The "concurrency milestone" (raising N>1) unlocks two things together:** (a) **credential broker**
  — main box is the sole `auth.json` refresher, serving short-lived creds to workers (the networked
  form of how one laptop runs many opencode sessions off one shared file); (b) **concurrent-merge /
  rebase-contention strategy** — concurrent branches off one main need rebase-retry-on-conflict.
  Neither is built until N>1 is actually wanted. (opencode's exact refresh-locking mechanism — file
  lock vs re-read-on-401 — to be confirmed *at that milestone*, not now.)
- **CI/GitOps boundary:** persistent infra (main box, network, firewall, worker snapshot) is
  **declarative via Pulumi, applied in CI**. Worker boxes are **runtime cattle** created by the
  reconciler — imperative, outside CI, by design.

### Agent runtime
- **opencode TypeScript SDK** (`@opencode-ai/sdk`), not the `opencode run` CLI. The worker runs
  *our* TS runner that embeds the SDK: create session → stream structured events → drive git.
- **The SDK event stream IS the transcript + cost source.** Lossless capture (NDJSON per run).
- **Auth = ChatGPT/Codex subscription via OAuth** (`openai` provider). Credential = single
  `~/.local/share/opencode/auth.json`, distributed to workers JIT. **Not metered API.**
  - **CRITICAL constraint (research RED→scoped):** OpenAI OAuth refresh tokens are **single-use**.
    Two workers sharing one `auth.json` collide on first refresh → hard 401, no recovery. And
    ChatGPT-OAuth **cannot be injected programmatically** (only `type:'api'` API-keys can) — the
    `auth.json` file must physically be present. **Therefore: ≤1 concurrent worker per subscription
    auth.json.** v1 ships **cap = 1**, which is fully safe. Raising the cap >1 needs a decision
    (see below) — it does NOT block v1.
  - **The cap>1 decision (parked for Calum, post-v1):** to run >1 concurrent worker you pick one —
    (a) **token broker on main box** (main box owns the only auth.json + the only refresh; hands
    workers short-lived creds; complex, feasibility unverified); (b) **one ChatGPT account per
    worker slot** (still flat-cost, just N subs); (c) **API-key burst** for workers 2–3 only
    (metered only on overflow); (d) **stay cap = 1** (simplest). v1 = (d) by default.
  - Other handled risks: pin opencode `1.17.11`; avoid `session_diff` (bug #20990 → 44GB disk) and
    drive git via shell; ToS → personal/internal scale only.
  - **Provider seam stays:** metered API key is the GREEN fully-headless fallback; cross-provider
    (Claude Pro/Max OAuth) possible per-stage later with zero code change.

### Models (defaults; confirm exact strings via `opencode models` at build)
- work agent: **`openai/gpt-5.5`** · review agent: **`openai/gpt-5.5`** for v1.
- Tuning levers (config-only, later): review → `openai/gpt-5.4-mini` under rate-cap pressure;
  add a plan/decompose stage model; cross-provider mixing.
- Note: `gpt-5.3-codex` / `gpt-5.2` are **deprecated** for ChatGPT-signed-in users (API-only).
- **Per-target model tiers.** Models are configurable **per target**, not just globally: loop-
  validation / testbed work uses a **cheap** model (`openai/gpt-5.4-mini`) since we're testing
  plumbing not code quality; real targets (tidepool-self) use the **strong** model (`openai/gpt-5.5`).
  Config: a global `models` default + optional `targets[].models` override.

### Validation strategy — "one check that implies everything"
Prefer a single checkable end-state that is only achievable if the whole chain worked, over vague
"implement v0" goals (classic AI-agent goal-setting: pick a terminal fact that sneakily proves
everything upstream). Two levels:
- **Loop-logic (free, today, fakes):** terminal check = **reconciler vitest suite green** — a ticket
  driven `backlog → … → done` against `Fake*` adapters, plus reattach-after-restart. Proves the state
  machine + resumability with no infra.
- **Real end-to-end (needs provisioning + spend):** terminal check via **`tp doctor`** = FOUR facts:
  `slugify` exists on `tidepool-testbed@main` + its test passes + the run's sqlite `usage` row is
  **non-zero** + the latest work run's box provider is **`hetzner`** (proves a real cloud worker, not
  `LocalBoxMaker`). That single assertion implies: reconciler picked it → worker booted → opencode ran
  on the *real subscription* (non-zero tokens ⇒ not faked) → branch → PR → CI green → review approved →
  auto-merged.
  - **Phase C PROVEN (2026-06-28):** real Hetzner box → opencode → merged testbed PR → `tp doctor`
    exit 0.

### Forge
- **GitHub** (PRs, Actions, Octokit, zero extra infra), behind a `Forge` interface (GitLab later).
- **Later: a dedicated GitHub identity** (bot/machine account or GitHub App) for agent commits +
  PRs. Swap-in via the configurable git identity, not a redesign.

### Tickets & work
- **Ticket = `{ id, title, goal, state, branch, pr, attempts, usage }`.** `goal` is a natural-
  language acceptance criterion, `/goal`-style ("add `slugify(s)`…"). **"Green, merged PR" is a
  system invariant**, NOT part of `goal` text — the pipeline + system prompt own definition-of-done.
- **Tickets are first-class sqlite rows — that IS the store and the single source of truth.**
  (Reversed the earlier "backlog = markdown in git" idea: it split state across file+DB, made
  done-ness ambiguous, and gave files a churny move/delete lifecycle. Markdown can't hold deps/
  comments/relations — a dead end for a system we want to *beef up*. So: DB, not files.)
  - **Created** via `tp ticket add` → the `QueueControl` seam (in-process locally, or the daemon's
    HTTP API remotely); the reconciler is still the only mover.
  - **Done** = a DB state transition the reconciler makes after auto-merge (review ✅ + CI ✅ +
    merged), recording pr id + merge SHA + usage. Not "a file moved." Queryable.
  - **Beefable** — deps, comments, priority, attempts, retries, links = columns/tables.
  - `target` is a column (`tidepool-testbed`): control plane owns the backlog, work lands on the
    target. The backlog-lives-with-the-brain / work-lands-on-target split is normal, not weird.
- **Optional git *intake inbox* (later, NOT v1):** if "queue from a commit / PR-review the backlog"
  is wanted back, a folder the reconciler **ingests once into sqlite** then treats as an immutable
  creation record — git = inbox, sqlite = store. State never lives in git. `tickets/*.md` in this
  repo are demoted to **seed fixtures** (example inputs the loop ingests), not the runtime store.
- **Transcripts/usage** also sqlite + files on the main-box volume, never git.
- **Lifecycle (async dispatch+poll):** `backlog → in_progress (dispatch work agent-worker) →
  running (poll; Succeeded → open PR) → review (CI green → dispatch review agent-worker) →
  running (poll the verdict) → [approve AND CI green → auto-merge → done] | [changes OR red CI →
  in_progress/review]`. `running` carries the `workHandle` + `dispatchedAt`; a poll `Failed` maps to
  retry (or `rate_capped`) and `now - dispatchedAt > deadline` reaps the worker (`cancel`). The
  reconciler is still the only mover and resumable — the handle on the ticket is the reattach point.
  Bounded retries → then `failed` / `rate_capped` (surfaced, requeued, never crash).
- **Auto-merge in v1.** No human gate. Escalates to a human only on repeated failure.

### Standards (the spec the review agent grades against — mechanical, not vibes)
- **IDs:** Stripe-style prefixed — `tckt_`, `run_`, `box_`, `pr_` + short lowercase base36
  (`[0-9a-z]`, matches the `tckt_[0-9a-z]+` gate).
  Same id is the sqlite PK, the CLI display, and threads through branch/PR/commit.
- **Branch:** `tp/tckt_xxx-short-slug`.
- **Commit subject leads with the ticket:** `#tckt_xxx feat(scope): subject` (we own commitlint).
- **PR title:** conventional + ticket id → `feat(tp): add reconciler (tckt_xxx)`.
- **Quality rails are mechanical + shared via GIT hooks** (husky: prettier, tsc, commitlint,
  vitest) so the *same* gate covers human + opencode + codex + claude. CI re-runs the same gates
  (never trust local). Agents physically can't merge messy code.
- **No leaky abstractions.** `AgentWorker`, `Forge`, `TicketStore` are deep modules: fat behind,
  narrow in front, impl fully hidden (Hetzner/GitHub/opencode/k8s never leak through). (`BoxMaker`
  was removed — the async `AgentWorker` seam subsumes both compute provisioning and agent execution.)

### Config & secrets (three stores, never mixed)
1. **Declarative config** — typed `tidepool.config.ts` (`defineConfig`, zod-validated), in git,
   changed via PR. Holds targets, worker cap/box specs, models, retries, idle timeout.
2. **Secrets** — **sops + age**, encrypted in git, **one file per secret** so each secret's
   recipient set is an independently-tunable dial (`.sops.yaml` is the access-control matrix;
   change audience = edit one rule + `sops updatekeys`). Recipients: the **CI** pubkey (where a secret
   must be CI-readable) + the **break-glass** pubkey. **CI decrypts with the `ci` key at deploy time
   and seeds each runtime secret into the in-cluster k8s Secret** that the control-plane Deployment
   mounts — no age private key lives on a long-running host. (The old `mainbox` recipient was dropped
   when the Hetzner control-plane box was torn down.)
   *Local dev:* `.envrc` (direnv) caches the break-glass key in the macOS login keychain and exports
   `SOPS_AGE_KEY`, so `sops -d` is promptless after a one-time per-machine seed from 1Password (the
   keys' backup-only store; nothing reads it at runtime). 1Password access uses a vault-scoped service account.
3. **Runtime state** — Postgres (CloudNativePG) in the cluster, never in git.
- Rule: a thing lives in exactly one store. Config never holds a secret; state never holds config.
- **Leak guard.** Claude Code hook (`.claude/hooks/`, bash-3.2-safe): PostToolUse `secret-redactor`
  masks secret *shapes* + our *exact* sealed values (sha256 list in `.claude/redaction-hashes.json`,
  regenerated at seal time by `bun run seal:hashes`, entropy-gated ≥80 bits, drift-checked at
  pre-push) in tool *output* before the model sees it (built-in tools require a *structured*
  `updatedToolOutput`, not a string — a plain string is silently dropped). It fails OPEN by design;
  real containment is the outbound-only cluster + least privilege + rotation on compromise, not the hook.
- **Post-quantum caveat (deferred, human-gated).** sops/age use **X25519** — Shor-breakable, so
  secrets-at-rest are theoretically harvest-now-decrypt-later. Out of scope at personal/internal scale
  (tenet 7), and everything rotates on compromise anyway; `CredentialBroker` is the seam if a PQ KEM
  (ML-KEM) is ever wanted. (The redaction-hash list is sha256 — quantum-fine.)

### Provisioning / bootstrap
- **Declarative layer = Pulumi (TS) + pulumi-hcloud provider**. Defines
  only persistent stuff (~50 lines). State backend = **Hetzner Object Storage (S3)**. *(Pending
  research confirms.)*
- **Bootstrap root of trust = one GitHub Actions secret** (the `ci` age private key).
  Everything else flows from sops afterward. One clean handoff: GH Actions secret = bootstrap,
  sops = steady state.
- Sequence: generate age keypairs → pubkeys to repo as sops recipients → the `ci` age privkey is the
  one GH Actions secret → CI `pulumi up` provisions the k8s cluster and decrypts sops → seeds every
  runtime secret into the in-cluster k8s Secret → the control-plane Deployment mounts it → alive.
- **State-bucket seam (the one un-Pulumi'd resource).** Pulumi can't create the bucket its own
  backend reads from (circular), so `tidepool-pulumi-state` is bootstrapped by an idempotent
  `ensure-state-bucket.sh` step in the deploy job (before `pulumi up`), from the same sops-decrypted
  S3 keys. A keys-only cold start — full teardown, then CI — rebuilds it hands-free; RGW-idempotent,
  so a normal deploy no-ops. deploy job only (preview is read-only). Survivors of a scorched-earth
  teardown = the two keys (hcloud API + S3) in sops; everything in the Hetzner project self-rebuilds.

### Spend guardrails (defense in depth — "$100k bill is impossible by construction")
The cost nightmare (runaway box creation) must be blocked *outside* our code, then again inside.
- **L1 — Hetzner project server limit set LOW (e.g. 5).** Enforced by Hetzner, outside our buggy
  code → the N+1th box physically can't be created. Worst case at cap 5 × CAX21 24/7 ≈ €40/mo.
  $100k requires hundreds of boxes Hetzner won't allow. **Set in UI before any provisioning** +
  a billing alert. This is the load-bearing guardrail.
- **L2 — reconciler hard cap** (`workers.max`): never spawn beyond it.
- **L3 — Effect `Scope`/`acquireRelease`:** a box is created *in a scope* → guaranteed `DELETE` on
  scope close, even on crash/exception. Teardown is structural, not best-effort.
- **L4 — the reaper:** periodic sweep lists **worker** boxes (`managed_by=tidepool,role=worker`) and
  destroys orphaned (no live ticket) / over-TTL / over-cap. Catches leaked workers the reconciler lost.
  **The management box (`role=management`) is persistent — never reaped, no TTL, kept around.**
  "Return to baseline" = workers->0; the management box stays. Worker and management are the only roles.
- **L5 — per-box max-TTL self-destruct** (box-side timer) + idle self-destruct. Two-sided kill.
- **L6 — spend circuit-breaker:** if live-boxes or spawn-rate exceeds a ceiling, STOP and alert Calum
  instead of spawning (dead-man's switch).
- Cost safety is a tenet-level concern: any change that could weaken L1–L6 needs human approval.

### Deploy & GitOps for the control plane itself
> Post-migration the control plane is a k8s Deployment (Talos/Pulumi cluster), not a box. The
> box/cloud-init/systemd deploy path below is retired; the k8s flow is authoritative.
- **Ongoing deploy = push-based, fully automatic on merge to `main`:**
  - *Images:* `images.yml` builds + pushes `control-plane` + `agent-worker` to ghcr, tagged `:${sha}`
    (immutable per commit) + `:latest`.
  - *Apply:* `infra.yml` up-job resolves **this commit's** freshly-built image to a digest
    (polls ghcr, fails closed if absent) and `pulumi up`s with it (`config.ts` `pickImage` prefers the
    `TIDEPOOL_DEPLOY_*_IMAGE` override over the git-pinned default, rejecting any non-`@sha256` ref).
    The control-plane Deployment rerolls (RollingUpdate); in-flight worker Jobs are untouched; new
    Jobs inherit the new agent-worker image via `TIDEPOOL_AGENT_WORKER_IMAGE`. No hand-editing a
    pinned digest, no approval gate (personal scale; `environment: production` can re-add reviewers).
  - *Infra changes (`infra/**`):* PR → `pulumi preview`; merge → the same up-job applies.
- Control-plane state is in Postgres, so a reroll is a brief reconcile pause, not lost work; the
  reconciler resumes polling existing work handles on restart.

### Surface & cost visibility
- **CLI-first, AXI-compliant; no TUI in v1.** `tp ticket add | list | get | logs | transcript`
  (`get` merges the old `trace`+`cost` into one detail view). AXI skill installed at
  `.agents/skills/axi/` (shared across opencode + claude). TUI is a later skin.
- **Queue control — `tp` is a client, the daemon is the mover.** `tp` speaks a narrow `QueueControl`
  seam (`src/queue-control.ts`): read + enqueue only (`add`/`list`/`get`/`runsFor`/`events`). The
  reconciler's mover methods (`patch`/`addRun`/`appendEvents`) are *not* in that interface, so no
  client can move ticket state over the wire (tenet 3). Two adapters satisfy the tag, chosen by the
  active client context: **`sqlite`** (in-process store, for dev/tests) and **`http`** (an
  `@effect/platform` `HttpApiClient` → the daemon's queue API, `src/queue-api.ts`). The daemon
  (`src/daemon.ts`) runs the reconcile loop *and* serves that API on one pg-backed store. Every
  collection response is the uniform envelope `{ items, nextCursor }` + `limit` (no bare arrays).
  `add` validates its `--target` against the configured repos and rejects unknown ones
  (`TargetNotConfigured`) — the target set in `tidepool.config.ts` is the repo universe (tenet 1).
- **Client contexts (per-operator, not git).** Which backend `tp` drives lives in `~/.tidepool/config`
  (kubectl/hcloud-style named contexts + `current-context`), never in `tidepool.config.ts` (that's
  declarative shared app config — tenet 1/2). Resolution order: `--context` flag > `TIDEPOOL_API_URL`
  / `TIDEPOOL_CONTEXT` env > file `current-context` > built-in `local` (sqlite).
- **`tp trace <ticket>`** reconstructs a ticket's lifecycle from `run_events` (+ `runs`): a
  ts-ordered timeline with phase labels (`in_progress`/`review`/`failed`), the work/review runs with
  `box_id`/provider, and inter-event durations. **A browser/web view over the same data is a
  follow-up** (out of scope for the trace+cost PR).
- **Cost tracking: capture now, surface later.** Store the full lossless opencode event stream
  (has per-message token usage + timing). sqlite `runs` gets `usage` columns (tokens in/out, model,
  wall_time_sec, lease_sec). **Two cost axes per ticket:** token (opencode) + infra (lease-seconds
  × Hetzner rate). **`tp cost [<ticket>]`** now sums tokens + wall-time per run / ticket / model
  (tokens-only — no dollar cost until a price map exists; infra-seconds axis is a follow-up).

### Connectivity & security
- **v1 floor:** deny-all-inbound firewall except key-only SSH (ideally IP-pinned); reconciler is
  **outbound-only** (no public listen port). Small attack surface.
- **Reaching the queue API from a laptop (tenet 9 — no public inbound).** The daemon serves the
  queue-control API on a **ClusterIP** Service (`tidepool-control-plane:8080`) — no LoadBalancer, no
  Ingress. `tp`'s `http` context reaches it via `kubectl port-forward` through the already-/32-
  firewalled apiserver, so nothing new is exposed. A context can declare the forward
  (`namespace`/`service`/`remote-port`/`local-port`) and `tp` opens it **invisibly** per command —
  the operator never runs the tunnel by hand. **No app-level auth in v1**: reaching the port already
  requires kube creds + the VPN /32, so reachability *is* the auth (marked `TODO(tailscale)` in the
  server).
- **v1.1:** **Tailscale** the box → `tp` over the tailnet (a direct address, no per-command forward),
  drop public SSH; add a bearer token to the queue API at that point. (You have it.)
- Firewall is declarative (Pulumi).
- **Operator kubectl access:** the cluster kubeconfig is a *secret output* of the
  `tidepool-cluster` Pulumi stack; `bun run kube` (`infra/scripts/kubeconfig.sh`) decrypts the
  S3-state creds via sops, reads the output, and writes `~/.kube/tidepool.yaml` (0600). In this repo
  `.envrc` layers that onto `KUBECONFIG` so `kubectl` defaults to `admin@tidepool` while other
  clusters stay selectable; elsewhere your normal default is untouched. The apiserver `:6443` is
  firewalled to the operator admin /32 (NordVPN dedicated static IP) — connect the VPN first.

---

## 3. Repos

- **`tidepool`** — this repo. The product (reconciler, CLI, runner, interfaces). Humans build it now.
- **`tidepool-testbed`** — a GitHub-only repo; a tiny **pure-function TS utility lib + vitest**.
  The safe sandbox agents practice on in v1 (objective `goal` pass/fail, harmless on failure,
  endless easy tickets, identical rails). **Owns no infrastructure.**
- **Self-bootstrap later** = one config line: add `tidepool` to `targets`. Testbed stays forever
  as a safe integration-test target.
- **Both repos are now PUBLIC + hardened (2026-06-28).** `tidepool` and `tidepool-testbed` are both
  public, with branch protection on `main`: required status check `check`, linear history, no
  force-push, no branch deletions, enforce-admins on. Actions `GITHUB_TOKEN` is read-only by default,
  and both repos carry **0 repo secrets**.

## 4. Hetzner (one project: `tidepool`; testbed owns no infra)

**Box types — CPX (AMD x86), NOT CAX (ARM).** Verified live 2026-06-27: **CAX/ARM is unavailable in
every datacenter** (capacity), and gen-1 `cpx11/21` are US-only. EU offers `cpx12/22/32+`, `cx23`,
`ccx`. x86 also removes the ARM-native-deps risk. So:

| Role | Box (default) | Why |
|---|---|---|
| Main (always-on, thin) | `cpx12` (or `cx23`) EU | reconciler + sqlite + git poll |
| Worker (ephemeral 0→N) | `cpx22` EU | opencode client + worktrees + build/test |

- **Capacity WILL bite if hardcoded.** `BoxMaker` must **fall back across location + type** on
  `resource_unavailable` (nbg1→hel1→fsn1; cpx22→cpx32…). Effect `Schedule` makes this clean.
- **Private networking (confirmed working):** a Hetzner Network (`10.0.0.0/16`, eu-central); main box
  + workers attached → main↔worker comms (heartbeat, token broker, SSH) over **private `10.x` IPs**,
  not the public internet. Fits least-privilege tenet; no egress cost.
- **E2E smoke-tested 2026-06-27:** token + network create + server-on-network create + teardown all
  proven against the real API (created cpx22 w/ private IP 10.0.0.2, deleted cleanly).

**Worker first-boot (proven 2026-06-28).** Lessons baked into the worker boot path:
- **Recycled-IP ephemeral boxes → host-key verification disabled.** Workers come and go on recycled
  public IPs, so SSH uses `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null` (a stale
  known-hosts entry for a reused IP would otherwise abort the connection).
- **cloud-init** installs `unzip`, sets `HOME=/root`, and installs opencode via `bun add -g
  opencode-ai`; **bootcmd disables `apt-daily`/`unattended-upgrades`** before anything else (avoids a
  ~12-minute apt-lock stall while the boot scripts fight the background updater).
- **`sshRun` passes the remote command as a single arg** (not split across argv) so quoting survives.
- Worker boxes are named **`tp-worker-<ticket>-<id>`** and carry a **ticket label**.
- **TEMPORARY hotfix:** the worker runner currently **force-exits (`process.exit(0)`) after push**
  because the embedded opencode server keeps Bun's event loop alive (the process would otherwise hang
  open). This is a stop-gap pending the Effect runner rewrite — **not** the intended shape.

Cost reality: the model is the already-paid Codex sub. Hetzner ≈ €10–20/mo (main flat + workers
hourly-only-when-up). State backend = Hetzner Object Storage (S3, `tidepool-pulumi-state`).

## 4.5 Pain points, autonomy & dev-loop strategy (from the grill)

**Known pain points** (🔴 existential · 🟠 serious · 🟡 manageable):

- *Using:* 🔴 **silent-wrong-but-green** (auto-merge trusts foolable oracles → wrong PRs compound);
  🟡 throughput wall (N=1 serial); 🟡 rate-cap stalls; 🟡 opaque "what's it doing now"; 🟡 cost runaway.
- *Maintaining:* 🔴 **OAuth credential is a fragile SPOF** (one `auth.json`, browser-only re-auth → fleet
  dead till a human heals it); 🔴 **ToS/account-ban risk** (fleet off one consumer sub → personal
  ChatGPT flagged); 🟠 opencode is shifting sand (daily releases, grey-area auth, pins age); 🟡 single
  main box / sqlite SPOF; 🟡 GitHub coupling (auto-merge semantics already changed Mar-2026).
- *Developing:* 🟠 **loop is hard to test → slow/costly iteration** (emergent behavior only shows in
  real paid runs); 🔴 **self-bootstrap can brick the brain**; 🟠 self-modification security surface
  (agent + CI-decrypt-key + auto-merge + editable `.github/`/`secrets/`); 🟡 distributed triage.

**Decisions taken in response:**

- **Tiered autonomy by blast radius** (the answer to silent-wrong-but-green). Trust ∝ cost-of-being-
  wrong — NOT a "smarter review agent" (a second LLM grading the first is weak; prefer mechanical/
  objective oracles).
  - **Testbed = full auto-merge.** Pure fns, disposable repo, squash = per-ticket revert → wrong
    merges are harmless. The scary version of this pain *doesn't exist yet* on the testbed.
  - **Real repos (incl. tidepool-self) = stronger gates + a human-approval lane** for risky paths
    (infra / secrets / CI / low-confidence runs).
- **Fakes-first dev loop** — answers *untestable loop* AND *self-bootstrap brick* in one investment.
  - `FakeBoxMaker` / `FakeForge` / `FakeAgentRunner` + in-memory `TicketStore` → the whole reconciler
    runs locally, fast, free. This is the "fast local loop."
  - The orchestrator's own vitest suite must be green to merge → **a self-edit that breaks the loop
    can't merge** (self-bootstrap safety net). Recovery = CI re-pins last-green ref, no hands.
  - Same harness tests the acceptance-gate logic for silent-wrong-but-green.
- **API-key fallback wired from day one** — answers credential SPOF + ban risk. The metered API-key
  path is GREEN/headless → the fleet survives a dead/banned OAuth. Plus a cheap **auth health-check
  that alerts Calum fast**. Dedicated fleet account = later call, not v1.
- **Accept as known debt, do NOT pre-mitigate** (avoids "systems not needed at the right time"):
  rate-cap stalls, feedback latency beyond a heartbeat, cost runaway beyond a max-run timeout, sqlite
  SPOF beyond volume snapshots, GitHub coupling, distributed triage, self-mod security beyond
  path-protection. Let the small N=1 loop reveal which actually bite before spending on them.

## 5. Deliberately deferred (clean seams, not built)

plan/decompose agent · auto-scale >3 · multi-repo · TUI · Tailscale · dedicated GitHub identity ·
self-bootstrap flip · cost analytics UI · Temporal (only if reconciler hurts) · Crabbox→direct-Hetzner.

**User-facing `cancel` / `retry` verbs — deferred, not built (decision pending).** Today both exist
only as reconciler-internal automation (the deadline reaper's `AgentWorker.cancel`, and
`retryOrFail`); there is no `tp ticket cancel/retry`. Adding them cleanly means an intent/desired-state
seam — the CLI writes desired intent, the reconciler observes and performs the transition — so the
"only mover" invariant (tenet 3) holds. Whether they're wanted at all is an open call; `QueueControl`
stays read+enqueue until then.

## 6. Open items (pending research workflow → RESEARCH.md)

Crabbox brokered-Hetzner programmatic fit · Hetzner Object Storage as Pulumi state backend · opencode
usage/cost field names + refresh-after-copy fix version · GitHub auto-merge mechanics · AXI 10
principles · exact pinned versions.
