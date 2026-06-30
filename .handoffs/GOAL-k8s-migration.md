# GOAL — ship the full k8s / AgentWorker migration (PR 0→7), unattended

Invoke with `/goal @.handoffs/GOAL-k8s-migration.md`. The executor is **the main thread acting as
orchestrator**, spawning **agent teams** (one builder + one reviewer per PR). This file IS the
acceptance condition — judged from the transcript, so **every check below must be RUN and its output
SURFACED in the transcript** (the evaluator cannot run commands or read files).

## Authoritative design (read first — do NOT re-design)
- `.handoffs/2026-06-30-1123-k8s-agentworker-migration.md` — locked decision ledger + the PR 0→7 table
  + spike results + cluster layout + CNPG datastore design. **Every "how" detail lives here.**
- `.handoffs/2026-06-30-1503-secret-rotation-and-k8s-e2e.md` — session deltas + secret state.
- `CLAUDE.md`/`AGENTS.md` (tenets + standards), `DESIGN.md`, `RESEARCH.md`.
Everything is already decided. The job is to EXECUTE, not re-litigate. Pre-approved tenet crossings:
sqlite→Postgres, k8s adoption, agent-pod co-location. Any OTHER tenet crossing → **HALT and ask Calum**.

## END STATE (done = all of these, proven in transcript)
1. **8 PRs (the migration PR-0 … PR-7) are MERGED to `main`**, each on green CI. Surface
   `gh pr list --state merged` showing all eight with their `tckt_` ids and `MERGED`.
2. **`main` is clean**: after `git checkout main && git pull`, `git status --porcelain` prints
   **nothing**. No stray/untracked/dirty files (this includes the `.handoffs/*` trackers + this GOAL
   file being deleted in PR-7 once their durable content is folded into `DESIGN.md`/`AGENTS.md`).
3. **`bun run check` on `main` exits 0** (prettier + typecheck + commitlint + vitest), output surfaced,
   with **0 failed, 0 skipped** tests — no test deleted, `.skip`-ed, xfail-ed, or assertion weakened to
   pass, and CI never bypassed (`--no-verify` forbidden).
4. **System runs on k8s** (proven at PR-5/PR-6): `kubectl --context tidepool get pods -A` shows the
   control-plane pod (`replicas:1`), the CNPG `tidepool-pg` cluster, CCM/CSI/autoscaler all healthy;
   first CNPG backup object present in Hetzner S3.
5. **End-to-end flip proven (PR-6):** ONE real ticket dispatched as a k8s Job → produced a PR → merged,
   running against **Postgres**. Surface the ticket id, the Job name (`tp-work-tckt_…`), and the PR.
6. **Old path deleted (PR-7):** `git ls-files src/hetzner-box.ts src/hetzner-volume.ts` returns empty;
   ssh remote-work path gone from `src/agent-runner.ts`; dead `drizzle-orm`/`drizzle-kit` removed.
7. **Docs track reality (tenet 11):** `DESIGN.md` reflects the AgentWorker seam, async dispatch+poll,
   Talos topology, CredentialBroker, Postgres/CNPG + PgMigrator-on-boot; stale lines fixed; AGENTS.md
   tenet-1 wording says Postgres. No contradicting docs left.
8. **Zero stray Hetzner billables:** `hcloud server list` (and volumes/networks/LBs) shows ONLY the
   intended migration cluster — no orphans from any spike/`pulumi` run. Verified after EVERY infra step.
9. **Old Hetzner API token revoked.** Hetzner API tokens are **console-only** (no hcloud/API delete).
   So at the end of PR-6, **HALT and surface ONE instruction for Calum**: "revoke the old token in
   Hetzner console → Security → API Tokens", and treat the rest of the end state as independently done.
   (`tp-main` + `tp-state` are retired by the cutover but the token kill is Calum's console click.)

## HOW (the execution contract)
- **Per PR:** builder agent in its **own git worktree** (`superpowers:using-git-worktrees`); mint
  `tckt_<base36>`; branch `tp/tckt_<id>-<slug>`; implement the matching row from the 1123 handoff table;
  **test-first** for any bug/behavior; `bun run check` green locally; push; open PR
  (`type(scope): subject (tckt_<id>)`, commits `#tckt_<id> type(scope): subject`). Then a **reviewer
  agent** runs the `review` skill (Standards + Spec) against the row + tenets; builder addresses
  (`receiving-code-review`); merge on green CI. **Never push to `main` directly** (golden rule).
- **Plan checkpoint (PR-1 and PR-5 only):** builder produces a design plan; the **orchestrator
  self-approves** it against the locked design and surfaces it in-transcript before implementation.
- **Docs update rides the same PR as the change** (tenet 11): DESIGN delta in PR-1; AGENTS tenet-1
  wording in PR-5; final doc cleanup + delete `.handoffs/*` + this GOAL in PR-7.
- **Critical path:** 0 → 1 → (2 ∥ 3) → 4 → 5 → 6 → 7. Only PR-2 and PR-3 run in parallel, and only
  after PR-1 is merged. Do NOT start PR-N's builder before PR-(N-1) is merged.
- **Infra safety (PR-5/PR-6):** spend is AUTHORIZED by Calum but **timebox live `pulumi` ops**; the
  hcloud token comes from `secrets/hcloud_api_token.enc.yaml` (the rotated one) and is **never printed**;
  **ONE owner per destructive/infra action — never split teardown or run two infra agents on one
  resource** (spike collision lesson); verify zero stray billables after each op.
- **Scope discipline:** `secrets/**` and `.github/workflows/**` may be touched ONLY where a PR's ticket
  explicitly scopes them — PR-0 (`.sops.yaml` catch-all→breakglass-only + `.claude/**`), PR-5
  (`infra/**` + workflows + S3/PG secret rules). Nowhere else.

## PR scope (one line each — full detail in the 1123 handoff table)
- **PR-0** prep + HTTP→`@effect/platform` in `src/hetzner-box.ts`; CLAUDE.md "always Effect incl HTTP"
  + AGENTS.md secrets-resolution line; narrow `.gitignore` `.claude/` → track `settings.json`+`hooks/`;
  **fix `sops-leak-guard.sh`** (block `sops -d … | cmd` even with `2>/dev/null`); **`.sops.yaml`
  catch-all → breakglass-only**; delete dead drizzle deps; commit `.handoffs/*` + this GOAL.
- **PR-1** delete `BoxMaker`; `AgentRunner`→`AgentWorker` (`dispatch/poll/cancel/reap`, tagged
  `Running|Succeeded|Failed`); `running` state + `workHandle`/`dispatchedAt` cols + migration; reconciler
  dispatch+poll branches; `Local`/`Fake` workers keep suite green; **DESIGN delta**. *(plan checkpoint)*
- **PR-2** `CredentialBroker` passthrough (reads sops, returns PAT). *(∥ PR-3)*
- **PR-3** two Docker images on shared base; agent-worker entrypoint = generalized `src/worker/` runner
  (`kind: work|review`, prints `RunnerResult`); CI builds→registry. *(∥ PR-2)*
- **PR-4** `K8sAgentWorker` adapter (Job create/poll/cancel/reap, stdout harvest); tested vs Fake
  contract + k3d/kind in CI; CA image ≥ v1.32.x.
- **PR-5** Pulumi/Talos infra + CCM/CSI/autoscaler + namespaces/NetworkPolicy/RBAC/firewall + **CNPG**
  (operator + cert-manager + Barman plugin + ObjectStore→S3 + `instances:1` + daily backup); CI
  preview/apply; AGENTS.md tenet-1 wording; S3 secret gets explicit `.sops.yaml` rule. *(plan
  checkpoint; live spend; human-approved)*
- **PR-6** cutover: control-plane `replicas:1 Recreate` (PgMigrator on boot); one-time idempotent
  sqlite→pg Effect Job (row-count assert) then delete; Layer-swap Local→K8s + sqlite→pg client; one
  real ticket end-to-end; then surface the token-revoke instruction (end-state #9).
- **PR-7** delete `src/hetzner-box.ts` + `src/hetzner-volume.ts` + ssh path + `infra/worker/` bake;
  update DESIGN/AGENTS; **delete `.handoffs/*` + this GOAL**; `main` clean.

## Stop conditions (HALT and surface to Calum, don't power through)
- Any tenet crossing beyond the three pre-approved.
- A live `pulumi`/infra op that fails, hangs past its timebox, or would leave stray billables.
- The one-time data migration row-count assert fails, or any irreversible step is ambiguous.
- A gate that can't pass without deleting/skipping/weakening a test.
