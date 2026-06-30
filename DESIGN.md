# Tidepool — Design

> Agentic-coding control plane. A pool where small crab-agents come and go.
> Status: **design locked, scaffolding**. Date: 2026-06-27.

This file records every decision made during the initial design grill so nothing is lost.
It is the source of truth for *why* the system is shaped the way it is.

---

## 1. One-paragraph shape

A thin, always-on Hetzner box (the **control plane** / "main box") runs a TypeScript + Bun
**reconciler loop** and a sqlite ticket store (the single source of truth for tickets). When tickets
exist, the reconciler spins **ephemeral Hetzner worker boxes** (elastic 0→3, self-destruct on
idle). Each worker runs a TS **runner** that embeds the **opencode TypeScript SDK** to drive
coding agents against a target GitHub repo: `branch → PR → review-agent → auto-merge-on-green`.
Models run via a **ChatGPT/Codex subscription** (OAuth, not metered API) through opencode's
`openai` provider. Infra is **declarative via Pulumi** applied in **GitHub Actions CI**.
Secrets via **sops + age**. You drive it with the **`tp`** CLI.

```
laptop ──(git push ticket file)──▶ GitHub ◀──(poll)── main box (always-on, thin)
                                                         │  reconciler + sqlite + transcripts
  tp ls / tp logs ──(SSH tunnel; later Tailscale)──────▶ │
                                                         │ tickets queued & capacity<cap
                                                         ▼
                                          BoxMaker → ephemeral worker (0→3, self-destruct)
                                                         │  TS runner + opencode SDK
                                                         ▼  clone target repo, work worktree
                                          work agent → branch → PR → review agent → auto-merge
```

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
- **Pulumi (TypeScript)** for infra, **not OpenTofu** — stack unity + shared types; **state in Pulumi
  Cloud (free tier)** which *eliminates the Object-Storage state-bootstrap paradox*. Still declarative
  + CI-applied (`pulumi up` in Actions) → GitOps tenet intact.
- **`bun:sqlite` + Drizzle** (or `@effect/sql-sqlite`) for the typed ticket store + migrations.
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
  - **Created** via `tp ticket add` (writes a row); later optionally a small API.
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
- **Lifecycle:** `backlog → in_progress (work agent → branch → PR) → review (review agent grades
  diff vs goal) → [approve AND CI green → auto-merge → done] | [changes OR red CI → in_progress]`.
  Bounded retries → then `failed` / `rate_capped` (surfaced, requeued, never crash).
- **Auto-merge in v1.** No human gate. Escalates to a human only on repeated failure.

### Standards (the spec the review agent grades against — mechanical, not vibes)
- **IDs:** Stripe-style prefixed — `tckt_`, `run_`, `box_`, `lease_`, `pr_` + short lowercase base36
  (`[0-9a-z]`, matches the `tckt_[0-9a-z]+` gate).
  Same id is the sqlite PK, the CLI display, and threads through branch/PR/commit.
- **Branch:** `tp/tckt_xxx-short-slug`.
- **Commit subject leads with the ticket:** `#tckt_xxx feat(scope): subject` (we own commitlint).
- **PR title:** conventional + ticket id → `feat(tp): add reconciler (tckt_xxx)`.
- **Quality rails are mechanical + shared via GIT hooks** (husky: prettier, tsc, commitlint,
  vitest) so the *same* gate covers human + opencode + codex + claude. CI re-runs the same gates
  (never trust local). Agents physically can't merge messy code.
- **No leaky abstractions.** `BoxMaker`, `Forge`, `TicketStore`, `AgentRunner` are deep modules:
  fat behind, narrow in front, impl fully hidden (Crabbox/Hetzner/GitHub never leak through).

### Config & secrets (three stores, never mixed)
1. **Declarative config** — typed `tidepool.config.ts` (`defineConfig`, zod-validated), in git,
   changed via PR. Holds targets, worker cap/box specs, models, retries, idle timeout.
2. **Secrets** — **sops + age**, encrypted in git, **one file per secret** so each secret's
   recipient set is an independently-tunable dial (`.sops.yaml` is the access-control matrix;
   change audience = edit one rule + `sops updatekeys`). Recipients: main-box pubkey + break-glass
   pubkey (+ CI where a secret must be CI-readable). **Private key lives on the main box only.**
   Workers get JIT-decrypted creds over the lease's SSH — the master key never leaves the main box.
   *Local dev:* `.envrc` (direnv) caches the break-glass key in the macOS login keychain and exports
   `SOPS_AGE_KEY`, so `sops -d` is promptless after a one-time per-machine seed from 1Password (the
   keys' backup-only store; nothing reads it at runtime). 1Password access uses a vault-scoped service account.
3. **Runtime state** — sqlite on the main box, never in git.
- Rule: a thing lives in exactly one store. Config never holds a secret; state never holds config.

### Provisioning / bootstrap
- **Declarative layer = Pulumi (TS) + pulumi-hcloud provider**. Defines
  only persistent stuff (~50 lines). State backend = **Hetzner Object Storage (S3)**. *(Pending
  research confirms.)*
- **Bootstrap root of trust = GitHub Actions secrets** (Hetzner token + main-box age private key).
  Everything else flows from sops afterward. One clean handoff: GH Actions secrets = bootstrap,
  sops = steady state.
- Sequence: generate age keypairs → pubkey to repo as sops recipient → GH Actions secrets hold
  Hetzner token + age privkey → CI `pulumi up` creates main box → cloud-init installs bun, clones
  tidepool, injects age privkey, starts reconciler → main box decrypts sops → alive.

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
- **First install = cloud-init (the only imperative first-touch).** CI `pulumi up` creates the main
  box; cloud-init installs runtime (bun/node/git/sops/age), clones `tidepool` @ pinned ref, injects
  the main-box age key (CI decrypts from sops → Pulumi config), `sops -d` secrets, `bun install
  --frozen-lockfile`, writes `tidepool.service`, `systemctl enable --now`.
- **Ongoing deploy = pull-based, two lanes:**
  - *App/reconciler/config/secrets:* merge to `main` → box **self-update systemd timer** sees new SHA
    → `git pull` + `bun install --frozen-lockfile` + graceful `systemctl restart`. Pull-based → **no
    inbound access needed** (fits outbound-only box). Restart is safe mid-task (reattach handles +
    persistent volume).
  - *Infra (`infra/**`):* PR → CI `pulumi preview`; merge → CI `pulumi up`. Reprovision → cloud-init
    reinstalls → resume from volume.
- **Workers:** snapshot bakes heavy invariant runtime (bun/node/opencode binary); worker **clones
  `tidepool` @ pinned ref at boot** and runs the runner from source → always-current, no
  snapshot-rebuild pipeline in v1.
- Net: cloud-init does first install; **systemd + `git pull` does every deploy after.** Same
  machinery, no manual SSH-fiddle, resumable across restarts.

### Surface & cost visibility
- **CLI-first, AXI-compliant; no TUI in v1.** `tp add | ls | logs | transcript | trace | cost`. AXI
  skill installed at `.agents/skills/axi/` (shared across opencode + claude). TUI is a later skin.
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
  **outbound-only** (no public listen port). `tp ls/logs` over SSH tunnel. Small attack surface.
- **v1.1:** **Tailscale** the main box → `tp` over the tailnet, drop public SSH. (You have it.)
- Firewall is declarative (Pulumi).

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
hourly-only-when-up). State backend = Pulumi Cloud (free), no object-storage bill.

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

## 6. Open items (pending research workflow → RESEARCH.md)

Crabbox brokered-Hetzner programmatic fit · Hetzner Object Storage as Pulumi state backend · opencode
usage/cost field names + refresh-after-copy fix version · GitHub auto-merge mechanics · AXI 10
principles · exact pinned versions.
