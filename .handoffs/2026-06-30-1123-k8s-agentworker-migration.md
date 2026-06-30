# Handoff — k8s / AgentWorker migration (worker orchestration redesign)

**Date:** 2026-06-30 · **Branch at handoff:** `main` (clean; PRs #28/#29/#30 merged) · **No open PRs.**

## Why this exists (the problem)

Today the reconciler runs **one ephemeral Hetzner box per ticket**, synchronously: `stepTicket`
leases a box and **blocks** on `agents.work` (ssh in, run opencode ~10 min), then scope-deletes the
box. Hetzner bills **per hour, rounded up**, so a 10-min job pays a full hour → **~83% of box spend
is idle**. 100 runs ≈ €1.28 of compute, but ~€1.07 of it is wasted round-up. (Box cost is small in
absolute terms; the point is the *model* — 1 ticket → 1 billed hour — doesn't bin-pack and can't
scale to zero.)

**Fix:** move workers onto **Kubernetes** that bin-packs jobs + autoscales nodes 0→N→0, so idle = no
worker spend and the hour you pay for gets fully used.

## The goal of the NEXT session (this handoff's focus)

Kick off the **full set of PRs** below using **agent teams**: **one builder agent per PR**, a
**reviewer agent per PR**, then merge + (for infra PRs) deploy. See **Execution playbook** at the end.
Everything is already grilled to ground and decided — the next session executes, it does not re-design.

---

## Decision ledger (LOCKED — do not re-litigate)

Full durable copy in memory: `~/.claude/projects/.../memory/tidepool-workrunner-seam.md` +
`calum-prefers-k8s-over-nomad.md`. Summary:

- **Execution model:** async **dispatch + poll**, not synchronous block. Reconciler dispatches a Job,
  stores a durable handle on the ticket, polls each tick (same idiom as the existing CI-`pending`
  branch in `src/reconciler.ts`). Resumable across control-plane restarts.
- **Seam reshape:** **delete `BoxMaker`** (its provisioning impl relocates to k8s + cluster-autoscaler
  in infra). Split `AgentRunner` → **`AgentWorker`** seam (`dispatch`/`poll`/`cancel`/`reap`; `poll`
  returns a tagged union `Running | Succeeded{WorkResult} | Failed{reason}`). **Both** the work agent
  and review agent run as **agent-worker Jobs** (`kind: work | review`) → **control-plane runs ZERO
  agents** and drops opencode.
- **Naming glossary (BINDING):** `control-plane` (the one always-on reconciler) · `agent-worker`
  (an ephemeral k8s Job) · `work agent` / `review agent` (the two kinds) · `AgentWorker` (the seam).
  Retire "box", "BoxMaker", bare "worker".
- **Handle + state:** `WorkHandle` = k8s Job id, stored on the ticket = reattach handle. New ticket
  state **`running`** + columns **`workHandle`**, **`dispatchedAt`** (+ `@effect/sql` migration).
  One new state only (k8s Job status already encodes pending-vs-running; don't add a 2nd).
- **Deadline:** native **`activeDeadlineSeconds`** on the Job (primary) **+** reconciler reaper
  (poll sees `now - dispatchedAt > deadlineSec` → `cancel` → retry). **`backoffLimit: 0`** so the
  reconciler owns retries (tenet 1).
- **Result harvest:** read the finished pod's **stdout `RunnerResult` line** (same schema the runner
  prints today, `src/worker/`). No new result channel. Implemented *inside* `poll`'s `Succeeded` branch.
- **OS = Talos Linux** (immutable, declarative). Spike PASSED 8/8 (see below). Provisioned by
  **Pulumi** (hand-roll: `@pulumiverse/talos` + `@pulumi/hcloud` + Helm for autoscaler — exivity
  module rejected: Go + experimental). **cluster-autoscaler** min=0. **Pulumi runs in CI, not a
  laptop** (tenet 2); state in **Hetzner Object Storage (S3)**.
- **Declarative image bake (GitOps, tenet 2):** committed **Talos Image Factory schematic** →
  snapshot via **`hcloud-upload-image` wrapped in a Pulumi `command` resource keyed on the schematic
  hash** → baked by CI `pulumi up`. Edit schematic → PR → new snapshot → nodes roll. (Avoid Hetzner's
  public Talos ISO — it boots `talos://metal` providerID and breaks CCM; use the custom snapshot.)
- **Topology = co-locate:** one always-on **`cpx32`** control-plane node also runs agent-workers on
  spare capacity; autoscaling **`cpx32`** worker pool (min=0) for overflow. Protect the control plane
  with `system-reserved`/`kube-reserved`, a control-plane `priorityClass`, and agent-workers in their
  own namespace with `NetworkPolicy` (no etcd/apiserver reach) + RBAC. (Graduate to a tainted,
  isolated worker pool when blast radius justifies the cold-start + idle cost — tenet 6.)
  **Account fact: the `cx`/`cax` server lines are NOT offered on this account — use the `cpx` line**
  (matches existing `typeChain` `cpx22→cpx32→cpx44` in `src/hetzner-box.ts`).
- **Resources:** **CPU request, NO CPU limit** (agents are bursty — LLM idle then compile/test spike;
  a CPU limit throttles for no benefit). **Memory request = limit** (incompressible; cap OOM blast).
  Target **2 vCPU request / 2 Gi mem request=limit**.
- **Docker images:** **two images on a shared base** — `base` (bun + opencode + git) → `control-plane`
  + `agent-worker`. agent-worker entrypoint = the existing `src/worker/` runner bundle, generalized to
  `kind: work | review`, prints `RunnerResult` to stdout. CI builds → registry (e.g. ghcr) by tag.
- **Datastore under k8s = Postgres via CloudNativePG** (RESOLVED 2026-06-30 — see the full datastore
  design in the "RESOLVED — datastore" section below; supersedes the earlier sqlite-on-PVC plan).
  control-plane pod = **`replicas: 1`, strategy `Recreate`** — **never RollingUpdate** (2 reconcilers =
  double-dispatch, tenet 1/3); this also guarantees single-writer for the on-boot PgMigrator. CNPG
  owns the PG data PVCs (`hcloud-volumes`); **Production cluster MUST enable Hetzner CSI**. No
  volume-import / no `/mnt/tidepool` sqlite file — data moves via the one-time sqlite→pg Job at cutover
  (`src/hetzner-volume.ts` box-volume model is now retired by PR-7). HA control-plane still OUT of
  scope (instances:1→3 is the future one-field lever; Calum signed off the tenet-1 cross to Postgres).
- **Secrets:** sops stays source of truth (per-file layout shipped in **PR #28**). Route ALL creds
  through a **`CredentialBroker`** at dispatch (passthrough now: reads sops + returns the existing
  GitHub PAT). **Agent-workers NEVER read sops** → future auto-rotation becomes a one-module swap.
- **HTTP:** converge everything onto **`@effect/platform`** (current `src/hetzner-box.ts` uses raw
  `fetch` — that's the one deviation to fix). Add a CLAUDE.md "always Effect incl HTTP, no raw fetch"
  line in the same PR (tenet 11).

### Tenet flags raised (already human-approved via the grill — note for the record)
- Spend guardrail mechanism changes from `acquireRelease`-delete-on-scope-close → deadline + k8s GC +
  scale-to-zero (tenet 6). Same "never pay for a stuck box" outcome, different enforcement.
- k8s adoption is a big infra change (tenet 7) — approved this session.
- Co-locating untrusted agent pods with the control plane is a blast-radius tradeoff (tenet 6),
  mitigated by reservations + NetworkPolicy + RBAC; revisit at scale.

---

## Talos spike result (8/8 PASS — GO) — scratchpad is ephemeral, key facts captured here

Ran on a real ephemeral Hetzner cluster, fully torn down, **zero billable resources left**, cost a
few cents. (Full writeup was at `scratchpad/talos-spike/RESULTS.md` — will not survive the session.)

- Bake + `providerID hcloud://…` (not `metal`): PASS. Bake hackiness 5/10 (inherent — Hetzner has no
  image-from-URL API), providerID mapping 1/10.
- Worker pool at 0 baseline: PASS.
- **Autoscaler 0→1→0:** PASS. Scale-up decision 9s · **Pending→Running 96s** · **1→0 ≈ 6m11s**
  (dominated by CA's ~5-min unremovable-recheck cache; set scale-down-unneeded ≈ 1m to speed it).
  cluster-autoscaler **v1.32.1** registered the pool cleanly — **no** "Nodegroup is nil" bug.
- Batch Job 2vCPU/2Gi `backoffLimit:0` → stdout harvest via `kubectl logs job/...` after exit: PASS.
- `activeDeadlineSeconds:30` + `sleep 300` → `DeadlineExceeded`, pod killed: PASS.
- Firewall: 6443+50000 locked to admin /32, default-deny otherwise: PASS.
- Declarative rebake: edit schematic (+iscsi-tools) → new hash → new snapshot, no manual steps: PASS.
- **Go/no-go:** GO Talos. k3s-on-Ubuntu fallback NOT needed (keep in pocket only if the
  snapshot/providerID dance or a CA version regression bites).

## Spike #2 results (2026-06-30 re-run) — Proof B PASS, Proof A mostly PASS

Two agents ran concurrently (orchestration error — collided on one box; both evidence sets combined
below). All resources torn down, verified clean (only tp-main/tp-state + tidepool-pulumi-state bucket).

- **PROOF B — opencode agent-worker in a pod: PASS** (the biggest unknown — now de-risked).
  opencode authed with the injected auth.json + ran for REAL → `RunnerResult` harvested from pod stdout
  via `kubectl logs` (exactly prod's `poll` path), parsed clean, **non-zero tokens** (gpt-5.4-mini,
  190 in/6 out, 8.3s). Real clone→edit→commit→push landed a branch on tidepool-testbed (then deleted).
  **Token NOT burned** (auth.json byte-identical post-run; access token had ~4d left). Cred handoff =
  **two k8s Secrets (auth.json + PAT) mounted at /secrets → copied to ~/.local/share/opencode**.
  Image = **bun-base + runtime git-clone** (NOT the `infra/worker/Dockerfile` SSH shape — wrong for a
  Job). `format` step exited 127 → best-effort WARN, committed anyway (correct).
- **PROOF A — CNPG datastore: PARTIAL (infra PASS, restore UNPROVEN).**
  - Talos + Hetzner **CSI**: PASS (PVC bound on `hcloud-volumes`, real volume attached, r/w verified).
  - **CNPG healthy on Talos+CSI** (instances:1, separate data+WAL PVCs): wrote+read rows. De-risked.
  - **Backup → Hetzner Object Storage (S3): PASS** (the other agent, CNPG 1.24.4) — 6 objects under
    `pg/`, **NO x-amz-content-sha256 workaround needed** (caveat: a newer aws-sdk/CNPG forcing
    x-amz-checksum could reintroduce it). **`sha256-workaround-needed` = NO.**
  - **Restore-from-S3: NOT RUN** by either (one blocked on creds, the other on the collision). Low risk
    (backup proven, CNPG restore is standard) — finish in PR-5's spike-forward or accept at PR-6.
  - **CNPG version: native `barmanObjectStore` is GONE in 1.30.0 → the Barman Cloud *plugin* is
    mandatory** (confirms the locked decision).

### PR-5 prerequisites + gotchas surfaced by the spike (DURABLE — builder must read)
1. **No Talos snapshot exists.** Snapshot `402689070` is an **ubuntu-24.04 worker** image, NOT Talos
   (the prior 8/8 spike's Talos snapshot was torn down). Both agents booted Talos via **rescue + `dd`
   of the Image Factory hcloud raw** (`factory.talos.dev/image/<schematic>/v1.13.5/hcloud-amd64.raw.xz`,
   default schematic `376567988…603b4ba`). PR-5 must **bake a real Talos snapshot** OR deliver the
   machineconfig via **hcloud user-data** (see #2).
2. **Hand-applied Talos config did NOT survive a hard reset** (PKI/etcd mismatch → needed re-dd). Root
   cause = no user-data seed. Proper hcloud-Talos pattern = **machineconfig via hcloud user-data**.
3. **CCM rejects the private node IP** ("failed to get node address that matches ip: 10.9.0.2") unless
   the Hetzner network is wired right (HCLOUD_NETWORK / chart networking values). Spike shortcut =
   kubelet nodeIP→public + networking.enabled=false. **Prod wants the private net → wire it properly.**
4. **S3 creds are NOT in sops + are console-only.** Hetzner Object Storage creds can't be minted via
   hcloud CLI. They currently exist ONLY as plaintext in `~/.tidepool/bootstrap/hetzner-s3.env`.
   **HUMAN PREREQUISITE before PR-6: mint Hetzner S3 creds + add to sops** (`secrets/hetzner_s3_*.enc.yaml`)
   so the CredentialBroker/CNPG ObjectStore can read them. Punt-list item, now a hard blocker for PR-6.
5. One **full-network wedge under concurrent CCM+CSI helm churn** on the single cpx32 (recovered via
   reset). Watch for it; **cpx42 or staggered installs** may help. (Reinforces the cx23/cpx node-sizing
   reopener.)
6. **Versions that worked:** Talos 1.13.5 · k8s 1.33–1.36 · CCM chart 1.33.0 · CSI chart 2.21.2 ·
   **CNPG 1.30.0** (chart 0.29.0).

### ⚠️ Security finding (tenet 9) — NOT spike-created, pre-existing, needs Calum's decision
`~/.tidepool/bootstrap/` holds **decrypted master keys + creds in plaintext** on the laptop:
`age-mainbox.key`, `age-breakglass.key`, `age-ci.key`, `hcloud_token`, `opencode-auth.json`,
`ssh-tidepool`, `pulumi-passphrase`, `hetzner-s3.env`. `age-mainbox.key` decrypts every box-only secret
→ brushes tenet 9 ("master keys never leave the main box"). Decide: wipe-after-bootstrap, or
keychain-cache like the breakglass key (PR #31 pattern). Left in place pending Calum's call.

---

## Rollout plan — the PR sequence (each lands GREEN + MERGED; golden rule)

Seam-first: risk front-loaded into safe refactors behind fakes; real k8s comes online incrementally;
cutover is one Layer swap; dead code deleted last.

| PR | Scope | Green-gate / notes |
|----|-------|--------------------|
| **0** | **HTTP → `@effect/platform`** everywhere (convert raw `fetch` in `src/hetzner-box.ts`). Add CLAUDE.md "always Effect incl HTTP" line + (optional) tenet-2 image-bake example. **+ AGENTS.md Secrets section:** add an agent-facing line — *"resolve a credential via sops/managing-secrets before concluding it's absent — don't infer from a filesystem search."* (a spike agent searched `~/.ssh`, found nothing, wrongly concluded "no key / 1Password" instead of checking `secrets/*.enc.yaml`). **+ commit THIS handoff** (`.handoffs/2026-06-30-1123-…md`, currently untracked) as the live execution tracker — but it's **transient: delete it in PR-7** once its durable content is folded into `DESIGN.md`/`AGENTS.md` (honors the "no standalone migration docs — keep knowledge inline" rule). **+ Narrow the `.gitignore` `.claude/` rule** → replace blanket `.claude/` with `.claude/skills` + `.claude/worktrees/` only, so `.claude/settings.json` + `.claude/hooks/` become TRACKED (shareable to CI/other machines/PR-builders). Then `git add` the two secret-leak guards: `.claude/hooks/sops-leak-guard.sh` (PreToolUse: blocks `sops -d` to stdout) + `.claude/hooks/age-key-tripwire.sh` (PostToolUse: detects AGE-SECRET-KEY in Bash/Read output) + `.claude/settings.json` wiring them. (Born from a real `sops -d | grep` leak this session.) | Pure refactor; existing tests green. Unblocks the k8s HTTP client. |
| **1** | **Seam reshape + state machine** behind fakes. Delete `BoxMaker`; `AgentRunner` → `AgentWorker` (`dispatch/poll/cancel/reap`, `WorkHandle`, `WorkStatus` union) + the review path. Add `running` state + `workHandle`/`dispatchedAt` cols + migration. Rewrite reconciler `in_progress`→dispatch, add `running`→poll branch. `LocalAgentWorker` + `FakeAgentWorker` preserve today's behavior (synchronous; `poll`→`Succeeded` immediately). | Still runs locally, no k8s; fakes keep the suite green. Biggest internal refactor but externally invisible. Consider splitting state-machine vs seam-rename into 2 PRs if review is heavy. |
| **2** | **`CredentialBroker` (passthrough).** New seam `credsFor(job) → {opencodeAuth, githubToken}`; reads sops, returns the PAT. Route work/review provisioning through it. | No behavior change. Sets up future rotation as a 1-module swap. |
| **3** | **Two Docker images** on shared base; agent-worker entrypoint = generalized `src/worker/` runner (`kind: work\|review`, prints `RunnerResult`). CI builds → registry by tag. | `docker run` locally testable; no k8s wiring. |
| **4** | **`K8sAgentWorker` adapter.** `dispatch`=create Job (image + broker creds, CPU-req/no-limit, mem req=limit, `backoffLimit:0`, `activeDeadlineSeconds`); `poll`=Job status + harvest pod stdout; `cancel`=delete Job; `reap`=label-selector + `ttlSecondsAfterFinished`. Uses `@effect/platform`. | Behind the seam, Layer-swappable. Test vs Fake contract + a k3d/kind cluster in CI. Not prod-wired yet. CA image must be ≥ v1.32.x. |
| **5** | **Pulumi/Talos infra + CI apply.** Productionize the spike: committed schematic → snapshot bake (`hcloud-upload-image` as Pulumi `command` resource keyed on hash) · `cpx32` control-plane node (co-locate, system-reserved, priorityClass) · autoscaling `cpx32` worker pool min=0 (1 worker/node, capacity-fallback groups) · CCM + cluster-autoscaler (Helm) · **enable Hetzner CSI** · namespace/NetworkPolicy/RBAC · firewall lockdown. **Datastore: stand up CloudNativePG** — operator (Helm) + **cert-manager** + Barman Cloud **plugin** + `ObjectStore`→Hetzner S3 (pre-create bucket) + `Cluster instances:1` (data+WAL PVCs on `hcloud-volumes`) + daily `ScheduledBackup` (30d retention). CI: `pulumi preview` on PR, `pulumi up` on merge; Pulumi state in Hetzner S3. **AGENTS.md tenet-1 wording (sqlite→Postgres) rides this PR** (the crossing PR). | Cluster + CNPG stand up healthy (PG reachable, first backup lands in S3); reconciler not yet dispatching. **Human-approved big change (tenet 7) + tenet-1 cross signed off.** Touches `infra/**` + `.github/workflows/**` + `secrets/**` (S3/PG creds) — these need explicit ticket scope (CLAUDE.md Do/Don't). |
| **6** | **Cutover.** Deploy control-plane image as a `replicas:1 Recreate` pod (PgMigrator runs on boot); **one-time sqlite→Postgres data Job** (typed Effect, idempotent, row-count verify) then delete it; Layer-swap `Local`→`K8sAgentWorker` + client `@effect/sql-sqlite-bun`→`@effect/sql-pg`; dispatch real tickets as Jobs. (No volume-import; no sqlite RWO/`Recreate` discipline — that was the old plan.) | Green = one real ticket → Job → PR → merge end-to-end, against Postgres. The flip. |
| **7** | **Delete the old path.** Remove `src/hetzner-box.ts` (ssh/cloud-init/BoxMaker), the ssh remote-work path in `src/agent-runner.ts`, `infra/worker/bake.sh` / cloud-init. Update DESIGN/HANDOFF (tenet 11). SSH key role shrinks. | Smaller codebase, all green. |

**Critical path:** 0 → 1 → (2, 3 in parallel) → 4 → 5 → 6 → 7.

### Still TODO before/within the plan
- **DESIGN delta:** none of this is in `DESIGN.md` yet — fold the architecture (AgentWorker seam,
  async dispatch+poll, Talos topology, CredentialBroker, **Postgres/CNPG datastore + PgMigrator-on-boot**)
  into `DESIGN.md`, ideally as part of PR-1 (tenet 11). Also fix the now-stale lines: L50
  `bun:sqlite + Drizzle` → Postgres/`@effect/sql-pg`, L47 `state in Pulumi Cloud` → Hetzner S3, and the
  Compute/BoxMaker sections. **Delete the dead `drizzle-orm`/`drizzle-kit` deps** in the same cleanup.
  The next agent should write this.
- **Migration DDL portability:** PR-1 authors the `running`/`workHandle`/`dispatchedAt` migration
  against **sqlite** (k8s/pg not online till PR-5/6); re-verify/adjust the DDL for Postgres at the PR-6
  client swap — `@effect/sql` `sql\`\`` is mostly portable but serial/type/AUTOINCREMENT syntax differs.
- **tenet-2 one-liner** (image-bake example in CLAUDE.md) — optional polish, fold into PR-0.

### RESOLVED (2026-06-30) — datastore = Postgres via CloudNativePG

Decided this session; supersedes the sqlite-on-PVC default. **Calum signed off crossing tenet 1**
(runtime state leaves sqlite). HA is NOT a near-term goal — the driver is "don't love sqlite, prefer
Postgres operationally." Run minimal now, keep the HA seam one field away.

**Locked datastore design:**
- **Operator: CloudNativePG (CNPG).** Not Zalando (heavier, slowing cadence), not a bare StatefulSet
  (own backups/failover by hand). CNPG = CNCF, declarative CRDs (fits Pulumi/GitOps tenet 2), barman
  backups, PITR, failover, rolling updates. Single-instance is first-class.
- **`instances: 1` now.** HA later = bump to `3`, operator handles Patroni-style failover (tenet 7
  run-minimal; design-for-N seam = one field).
- **Co-located on the always-on `cpx32`** (the same node — NOT a new dedicated node). PG is just
  another pod beside the control-plane + co-located agent-workers. Protect with `system-reserved`/
  `kube-reserved` + priorityClass (already planned); agent-workers walled off by NetworkPolicy (no DB
  reach). NB: PG eats ~0.5 vCPU/1Gi → cpx32 now holds CP+PG+**one** co-located agent-worker; 2nd burst
  → autoscale pool (was ~2 before PG). Acceptable; pool is the overflow valve.
- **Backups: Barman Cloud *Plugin*** (NOT native `barmanObjectStore` — deprecated CNPG 1.26, removed
  1.30) → **Hetzner Object Storage (S3-compat)**. Needs **cert-manager** + plugin manifest. Custom
  `endpointURL`, **pre-create the bucket** (Barman 3.16+ won't auto-create), watch the
  **x-amz-content-sha256** S3-compat gotcha (known env-var workaround if uploads 400). Daily
  `ScheduledBackup` + WAL archive → PITR. **30d** recovery-window retention.
- **No PgBouncer.** One replica, one writer, handful of connections. Add a pooler only if connection
  count ever bites (tenet 7).
- **Storage:** Hetzner CSI `hcloud-volumes`, separate data + WAL PVCs (10Gi each).

**Schema migrations (ongoing DDL):**
- **`@effect/sql` `PgMigrator`** (`fromRecord`/`fromFileSystem`) — typed migrations as Effects, NOT a
  schema-first generator. Tenet 10 clean (one SQL layer), single source of truth (migration history IS
  the schema). Schema is tiny → auto-gen (drizzle-kit/Atlas) not worth a 2nd schema source. **Drizzle
  rejected as query/migration layer** (2nd SQL layer = tenet-10 collision; 2nd schema def = tenet-1
  drift). **DELETE the dead `drizzle-orm`/`drizzle-kit` deps** — unused in `src/`, latent tenet-10
  violation (do in PR-0/PR-1 cleanup). Atlas = the only auto-gen that keeps `@effect/sql`, but external
  tool + 2nd schema source → revisit only if the schema grows large (drizzle-later is low-regret:
  `drizzle-kit introspect` the live DB whenever).
- **Runs in the control-plane process, on boot.** `PgMigrator` is a Layer in the app graph: pod starts
  → SqlClient connects to CNPG → Migrator creates `_migrations` table, locks, applies pending in order,
  fail-fast (bad migration → CrashLoopBackOff, never half-applied) → reconciler loop starts only after.
  `replicas:1 Recreate` ⇒ exactly one process ever migrates → no race (Migrator also self-locks).
  Pre-deploy Job/init-container only needed at multi-replica (future).
- **Client swap:** `@effect/sql-sqlite-bun` → `@effect/sql-pg` (keep all queries behind `@effect/sql`
  so the app-layer change stays localized).

**One-time sqlite→Postgres data move (cutover, PR-6 ONLY — distinct from schema migrations):**
- **Throwaway typed Effect k8s Job**, NOT pgloader. Reads sqlite repos → writes pg repos via the same
  domain types (tenet 10, catches sqlite-dynamic→pg-strict coercion at compile time). Idempotent
  upsert-by-id, **assert source/dest row counts match before flipping the Layer** (tenet 8 evidence).
  Runs once, then deleted.

**Doc edits this unlocks (must ride PRs, NOT direct-on-main):**
- AGENTS.md **tenet 1** wording: "runtime state (tickets/transcripts/usage) in **sqlite**" →
  **Postgres** (+ the L33 parenthetical) — rides the PR that crosses it (PR-5/6). Sign-off captured.
- DESIGN.md is **broadly stale** wrt this whole migration (predates it). Fold into PR-1's design delta:
  the datastore ADR above **and** fix L50 `bun:sqlite + Drizzle` → Postgres/`@effect/sql-pg`, L47
  `state in Pulumi Cloud` → Hetzner S3 (handoff already says S3), and the BoxMaker/Compute sections.

**Nodes (settled this session):** stay **cpx32** (4 vCPU/8GB/€36mo cap) for BOTH the always-on node and
the autoscale worker pool — one Talos snapshot/config, **1 agent-worker per pool node** (clean 1:1; a
2vCPU node can't host a 2vCPU pod + kubelet). Capacity fallback groups (cpx32→cpx42, nbg1→hel1→fsn1) so
a stockout doesn't strand a pending Job. Scale lever = switch pool to **cpx42** (8/16) packing **2–3
workers/node** to amortize the ~96s cold-start — only when parallel bursts prove it. (`…2` suffix =
EU gen; `cpx31` etc. are the US-only gen of the same size.)

### Cluster layout — context / namespaces / services / labels (PR-5 design, 2026-06-30)

- **kubectl context:** real cluster = **`tidepool`** (rename the Talos-generated context at PR-5/6) →
  `kubectl --context tidepool -n tidepool …`. The spike uses a throwaway **`tp-spike`** context (never
  reuse `tidepool` for a throwaway).
- **Namespaces (split on the trust boundary, tenet 6/9):**
  - **`tidepool`** — control-plane pod + Postgres (CNPG Cluster). Trusted brain + datastore.
  - **`tidepool-workers`** — ephemeral agent-worker Jobs (`kind: work|review`). Untrusted; the
    blast-radius wall (no PG/control-plane/apiserver reach).
  - vendor: `cnpg-system` (CNPG operator), `cert-manager`, `kube-system` (CCM/CSI/autoscaler).
- **Services** (`<svc>.<ns>.svc.cluster.local`):
  - Postgres: CNPG Cluster **`tidepool-pg`** → `tidepool-pg-rw.tidepool.svc:5432` (write/primary, the
    control-plane DSN target) · `-ro`/`-r` (reads, unused at `instances:1`, free at HA).
  - Control-plane: Deployment `tidepool-control-plane`, **no Service now** (reconciler is outbound-only);
    add ClusterIP `tidepool-cp` only if it later exposes health/metrics.
  - Agent-workers: Jobs, **no Service** (ephemeral); addressed by label selector.
- **Labels + WorkHandle (powers the AgentWorker seam):**
  `app.kubernetes.io/part-of: tidepool` · `tidepool/role: control-plane|postgres|agent-worker` ·
  `tidepool/kind: work|review` · `tidepool/ticket: tckt_…` · `tidepool/run: run_…`.
  **Job name = `WorkHandle`** (the reattach handle on the ticket): `tp-work-tckt_…-<attempt>` /
  `tp-review-…` in `tidepool-workers`. → `poll`=get Job by handle, `cancel`=delete by ticket label,
  `reap`=label-selector + `ttlSecondsAfterFinished`.
- **NetworkPolicy/RBAC (the wall):** `tidepool` default-deny ingress, allow control-plane→`tidepool-pg-rw:5432`
  + egress internet/DNS. `tidepool-workers` default-deny, allow egress internet/DNS only, DENY reach into
  `tidepool` ns + apiserver/etcd. RBAC: control-plane SA = create/get/delete Jobs + read pod logs in
  `tidepool-workers` ONLY; worker SA = none (no k8s API).

### Punted (separate tickets, NOT blocking the migration)
- **GitHub App token** to replace the long-lived PAT (`forge_github_token`) — *prerequisite* for
  per-dispatch 1h-token minting in the broker. Follow-up already noted in PR #28.
- **OpenAI opencode `auth.json` auto-rotation** in the broker. It's an **OpenAI subscription OAuth**
  token (`access`/`refresh`/`expires`), rotates ~weekly. **Decision deferred** pending one fact: is
  re-login a hard 7-day cap (→ prefer a static **API key in sops**) or just lapse-from-disuse
  (→ broker single-writer refresh is viable). For now sops holds it; manual re-auth when it lapses.
  Broker passthrough (PR-2) keeps this a 1-module change later.
- SSH identity split; strict-isolation taint of the worker pool at scale.

---

## Execution playbook — agent teams (the next session's job)

Spawn **one builder agent per PR** + **one reviewer agent per PR**, respecting the critical path.
Process per PR:

1. **Builder agent** (own git worktree — use `superpowers:using-git-worktrees`):
   - Create/December a ticket id `tckt_<base36>`; branch `tp/tckt_<id>-<slug>`.
   - Implement per the row above, **test-first** for any bugfix (`superpowers:test-driven-development`).
   - Honor standards (CLAUDE.md): Effect-only (tenet 10), `@effect/schema`, conventional commits
     `#tckt_<id> type(scope): subject`, PR title `type(scope): subject (tckt_<id>)`.
   - `bun run check` green locally (prettier + typecheck + commitlint + vitest), push, open PR.
2. **Reviewer agent** (use the **`review`** skill — Standards + Spec axes): review the PR diff against
   the row's scope + the tenets. Builder addresses feedback (`superpowers:receiving-code-review`).
3. **Merge** once CI is green (golden rule — never bypass gates). For **PR-5/6 (infra)**: after merge,
   confirm `pulumi up` applied in CI and the cluster is healthy before proceeding; for PR-6 confirm one
   real ticket completes end-to-end.
4. Advance along the critical path; run 2 & 3 in parallel only after 1 merges.

**Parallelism:** PRs 2 and 3 can run as concurrent teammates once PR-1 is merged. Everything else is
sequential. **Do not** start PR-N's builder before PR-(N-1) is merged unless the table shows them
parallel — the seam/state changes in PR-1 are a hard prerequisite for 2–7.

**Guardrails for infra agents (PR-5/6):** timebox + budget-cap any live `pulumi up`; the hcloud token
comes from sops (`secrets/hcloud_api_token.enc.yaml`) — never printed; mandatory verify of zero stray
billables; `.github/workflows/**` and `secrets/**` edits require the ticket to explicitly scope them
(CLAUDE.md Do/Don't). A prior spike run once left billing orphans — always verify teardown/`hcloud
server list`.

---

## Repo state / environment notes

- **Merged this session:** PR #28 (per-file sops + gitleaks), #29 (concise-docs + ban surfacing secret
  values), #30 (direnv local-secret loading + tracked `infra/pulumi/bun.lock`). All on `main`.
- **`@effect/platform` deviation** lives in `src/hetzner-box.ts` (raw `fetch`) — PR-0 target.
- **Local secrets dev setup:** `.envrc` loads `SOPS_AGE_KEY` via `op read` (1Password); `direnv allow`
  in a fresh shell. hcloud auth is NOT in the committed `.envrc` — set a `tidepool` hcloud context or a
  local `HCLOUD_TOKEN` for local `hcloud` use. Secret values must never be surfaced in chat (CLAUDE.md).
- A **Claude Code remote-control server** was left running on the dev box (lets Calum spawn phone
  sessions in this repo). Harmless; `kill` it if stale. Launch recipe is in global `~/.claude/CLAUDE.md`.
- Key code references: seams `src/services.ts`; loop `src/reconciler.ts`; agents `src/agent-runner.ts`;
  box impl `src/hetzner-box.ts`; volume `src/hetzner-volume.ts`; domain/states `src/domain.ts`;
  runner `src/worker/`. Tenets/standards: `CLAUDE.md` (= `AGENTS.md`). Design: `DESIGN.md`,
  facts/versions: `RESEARCH.md`.

## Suggested skills for the next session
- **`superpowers:writing-plans`** / **`writing-skills`** — if you want the PR rows turned into per-PR plans first.
- **`superpowers:using-git-worktrees`** — isolate each builder agent.
- **`superpowers:test-driven-development`** — bugfix/behavior PRs.
- **`review`** (Standards + Spec) — the per-PR reviewer agent.
- **`superpowers:requesting-code-review`** / **`receiving-code-review`** — the build↔review loop.
- **`effect-ts`** — every code PR (Effect patterns, tenet 10).
- **`codebase-design`** — the seam work in PR-1 (deep-module vocabulary).
- **`superpowers:dispatching-parallel-agents`** — running the per-PR teammates.
- **`no-mistakes`** — gate each PR (review → tests → lint → push → PR → CI) before merge.
