# Migration status — resume note (2026-07-01, mid-run)

Live tracker for the k8s/AgentWorker migration (goal: `.handoffs/GOAL-k8s-migration.md`). Delete at PR-7.

## Merged to origin/main
- **PR-0** #32 · **tenet#12** #34 · **PR-1** #33 · **PR-2** #36 (+#37 orDie test) · **PR-3** #35 · **PR-4** #38.
  (HTTP→@effect/platform; AgentWorker seam + `running` state; CredentialBroker passthrough; base+control-plane+agent-worker images; K8sAgentWorker adapter [kind-in-CI, NOT prod-wired, live path still LocalAgentWorker].)

## In flight (all built + reviewed; live half gated on Calum)
- **PR-5a (#39)** `tp/tckt_k5p3r9-pr5-infra` — Talos/Pulumi cluster + gated CI. **APPROVED (pr5-reviewer).** Fixes landed: #4 CI-reachability (runner IP → pulumi config → firewall `[adminCidrs+ciRunnerCidr]`, in-state/no-drift); fail-closed adminCidrs; **passphrase→sops** (23ddb85 — `SOPS_AGE_KEY` is now the ONLY GH secret); Calum sealed `pulumi_config_passphrase` (ci+breakglass) + `updatekeys` granting ci on S3 (696e1e2). Preview VERIFIED: S3 login + all 3 sops decrypts WORK; last error was `no stack named 'production'` → pr5-builder adding `upsert:true` (create-if-missing). Once green → MERGE (branch is BEHIND main → update-branch first).
- **PR-5b (#41)** `tp/tckt_c9np8g-pr5b-cnpg` (stacked on 5a) — CNPG (cert-manager+operator+Barman *plugin*+ObjectStore→S3+Cluster instances:1+daily ScheduledBackup 30d) + tenet-1 AGENTS.md sqlite→Postgres + DESIGN ADR. Built, DRAFT, **HELD until 5a applied** (CNPG CR preview partial pre-cluster).
- **PR-6 (#42)** `tp/tckt_pg6cut-pr6-cutover` — cutover code: @effect/sql-pg client swap (one query source `store-sql.ts`) + PgMigrator-on-boot + one-time sqlite→pg data-move Job (hard-fail row-count assert) + config-gated Layers (`TIDEPOOL_DB_DRIVER`/`TIDEPOOL_AGENT_WORKER`, default sqlite+Local) + CI `postgres:16` service. DDL fixes: epoch-ms→BIGINT, rowid→`seq` IDENTITY. Built, **code-APPROVED (pr6-reviewer), all CI green, DRAFT, HELD until 5a+5b applied** (the live flip + one-real-ticket-on-pg acceptance need the cluster).
- **PR-7** pending (blocked on PR-6).

## Secrets matrix (least-priv — verified)
`SOPS_AGE_KEY` (=`ci` age PRIVATE key) is the **ONLY GH Actions secret**. `ci` decrypts EXACTLY 3 secrets:
`hcloud_api_token`, `hetzner_s3_credentials`, `pulumi_config_passphrase`. NOT `forge_github_token` /
`runner_opencode_auth_json` / `ssh_tidepool_private_key` (mainbox+breakglass only). breakglass = every secret (recovery).

## Calum prereqs
**DONE:** `SOPS_AGE_KEY` GH secret (ci key) · `PULUMI_CONFIG_PASSPHRASE` moved OUT of GH → sops (GH secret deleted) · `pulumi_config_passphrase` sealed (ci+breakglass) · S3 `updatekeys` granted ci · `tidepool-pulumi-state` bucket exists (nbg1) · **`production` GH Environment created w/ Calum required-reviewer** · **admin `/32` set in `infra/pulumi/cluster/Pulumi.production.yaml` = Calum's NordVPN dedicated static IP** (⚠️ admin kubectl/talosctl requires being connected to that Nord IP; if Nord reassigns it, update the config) · upsert-stack fix landed, preview GREEN.
**REMAINING:** just **approve the `pulumi up`** at the `production` gate once 5a merges (~€36/mo) — every future infra `pulumi up` also needs this click (rare; not per-ticket). **Later (5b):** pre-create `tidepool-pg-backups` bucket.
**IN PROGRESS:** 5a (#39) update-branched onto main, CI re-running → merge on green → up-job prompts Calum.

## Then (orchestrator resumes)
merge #39 → (Calum approves apply → cluster live) → finalize+apply 5b (rebase onto merged main, real preview vs live CRDs) → merge #42 = **the flip** (sqlite→pg data move + Local→K8s, one real ticket end-to-end on Postgres) → **PR-7**: delete hetzner-box.ts remnants + ssh path in agent-runner.ts (`sshArgv` etc.) + infra/worker bake + hetzner-volume.ts; drop `box_`/`lease_` from ids.ts + AGENTS.md ID list; update DESIGN/AGENTS; delete `.handoffs/*` + GOAL → clean main.

## Deferred fast-follows (post-migration, NOT blocking)
- **Rotate EVERYTHING** (breakglass leaked → all 3 age keys + every secret value) — handover `.handoffs/INVESTIGATE-secret-leak-guard.md`. Parallel worker (branch `tp/tckt_lk9g2r`) landed the LIVE `secret-command-guard` (PreToolUse block) + `secret-redactor` — confirmed working (blocks even the orchestrator from key material). KEEP rotation deferred until migration done.
- **Slim agent-worker image** — Lever A `bun install --production` proven safe ~360MB + alpine ~300MB. Bundle with cluster standup.

## Notes
- Uncommitted in the MAIN working tree: rotated `secrets/hcloud_api_token.enc.yaml` (local reseal) — lands in the rotation follow-up. (Not in the 5a worktree; safe.)
- cmux teams: spawn NAMED teammates, NO `isolation` flag (self-worktree), hard-shutdown when their PR merges.
- Live path defaults stay sqlite+LocalAgentWorker until PR-6's config-gated flip.
- Active agent: pr5-builder (fixing the `production`-stack upsert on #39). Others stood down; respawn per phase.
