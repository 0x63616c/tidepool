# Handoff — post-migration: kubectl access, old-infra teardown, remaining work (2026-07-01 08:35)

Next session focus (from the operator): **(1) get connected to kubectl locally (create a local context), (2) tear down the old infra, (3) mop up remaining work.** The k8s + Postgres migration itself is **DONE** — see below.

## Migration status: COMPLETE ✅
PR-5, PR-6, PR-7 all merged; tidepool runs on **Postgres + k8s**. Prior live tracker `.handoffs/2026-07-01-migration-status.md` is now stale (says 6/7 pending) — update or delete it in the doc-sweep.

Merged this session (each behind a **separate reviewer agent** — repo rule):
- **#43** fix infra.yml hcloud-upload-image download (org/version/asset were wrong) — unblocked the cluster apply.
- **#44** reseal hcloud token + commit `.handoffs/`.
- **#45** rotate hcloud API token to a valid **Read+Write** key (old one was unauthorized).
- **#41** PR-5b — CNPG/Postgres + Barman-plugin backups + **declarative** `tidepool-pg-backups` S3 bucket (`@pulumi/aws` s3.Bucket on the Hetzner endpoint).
- **#42** PR-6 — pg cutover code seam (shared `store-sql.ts`, `PgStore`, `PgMigrator`-on-boot, config-gated layers, CI `postgres:16`).
- **#46** PR-6.5 — **the live flip**: control-plane k8s Deployment (`workloads.ts`), pg + k8s-worker env gate, widen-`ci` secret delivery. Applied green; pod reached **Ready** → PgMigrator succeeded → reconciler live on pg.
- **#48** PR-7 — deleted the dead Hetzner-box/SSH worker path + `lease_` + `infra/worker` bake + `container-harness` CI job (−1640 lines).

5a (#39) was already merged/applied before this session. **The `production` GH Environment gate was deleted by the operator → infra auto-applies on merge now** (no manual approval step).

## Live infra inventory (`hcloud all list`, context `tidepool`, nbg1)
Two servers running — **the old one is now redundant:**
- **`tp-main`** (id 146074609, ip `<old-box-ip>`, priv 10.0.1.1, net `tidepool-private`, vol `tp-state` 10GB) — **OLD** pre-migration control-plane VM (sqlite). Declared by `infra/pulumi/index.ts` (the *root* Pulumi program, separate stack from `cluster/`). **TEAR DOWN.**
- **`tidepool-cp`** (id 146793731, ip `<cluster-cp-ip>`, priv 10.10.0.10, net `tidepool-cluster`, 2× PVC = pg data/WAL) — **NEW** Talos k8s control-plane. Keep.
- Old-only extras to remove with tp-main: `tp-main-fw`, `tidepool-private` net, tp-main primary IPs, the `tidepool worker (baked)` snapshot (403541070 is the live Talos snapshot — KEEP that one).

## Task 1 — kubectl local context
The kubeconfig is a **sensitive output of the cluster Pulumi stack**; the apiserver (`<cluster-cp-ip>:6443`) is firewalled to the **admin /32 = operator's NordVPN dedicated static IP** + CI runners. So kubectl only works while on that Nord IP.

Recipe (needs sops-provided env; run from repo root, `.envrc` supplies `SOPS_AGE_KEY` via keychain):
```
cd infra/pulumi/cluster
export PULUMI_CONFIG_PASSPHRASE=$(sops -d --extract '["pulumi_config_passphrase"]' ../../secrets/pulumi_config_passphrase.enc.yaml)
# AWS_* from secrets/hetzner_s3_credentials.enc.yaml (state backend creds)
export PULUMI_BACKEND_URL='s3://tidepool-pulumi-state?endpoint=nbg1.your-objectstorage.com&s3ForcePathStyle=true&region=nbg1'
pulumi stack select production
pulumi stack output kubeconfig --show-secrets > ~/.kube/tidepool.yaml
KUBECONFIG=~/.kube/tidepool.yaml kubectl get nodes
```
**Deliverable the operator asked for:** wrap this in a `bin/tp-kubeconfig` helper (reads sops env, writes `~/.kube/tidepool.yaml`, merges/creates a `tidepool` context) so it's one command. Note the leak-guard (`.claude/hooks/secret-command-guard.sh`) blocks piping/printing secret env vars — the helper must write to a file, not echo. Alternative source: `talosctl kubeconfig` from the Talos client config if pulumi output is awkward.

## Task 2 — tear down old infra (tp-main + old stack)
GitOps-clean teardown (tenet 2 — don't hand-delete in the hcloud console):
1. **Confirm nothing of value on `tp-main` first:** its sqlite on `tp-state` (operator already said no real ticket data existed — §5 of the migration — but verify), and **no unique key material lives only there** (tenet-9 "master keys on the main box"; the age breakglass key is also in 1Password + the operator's keychain, but double-check before destroying).
2. `pulumi destroy` the **root** stack (`infra/pulumi/index.ts` — the main-box program, NOT `infra/pulumi/cluster/`). This removes tp-main, tp-state, tp-main-fw, tidepool-private, its primary IPs.
3. PR deleting `infra/pulumi/index.ts`, `infra/pulumi/cloud-init.main.ts`, and the old worker snapshot/bake remnants; update DESIGN/AGENTS (tenet 11) so docs no longer describe a main box.
4. Watch cost drop (~one server + volume + IPs gone).

⚠️ Sequence check: the migration moved control-plane OFF tp-main onto k8s. Nothing live should still depend on tp-main. But grep for any remaining reference (e.g. `infra/pulumi/materialize-secrets.sh` / root program still name `src/hetzner-box.ts`, now deleted — the doc-sweep flagged this). Confirm the root stack has no cross-refs into the cluster stack before destroy.

## Task 3 — remaining work (all tracked, all non-blocking to the migration goal)
See the in-session task list; key ones:
- **One-ticket acceptance on pg** — prove the full loop (reconciler → k8s worker Job → PR → merge) end-to-end on Postgres. Needs kubectl (Task 1) from the Nord IP. Gold-standard proof before trusting it unattended.
- **#18 churn-free preview fix** — draft **#47 is DO-NOT-MERGE** (v1 `yaml.ConfigFile` swap greens preview but *destroys+recreates* 18 barman objects incl. the CRD → ObjectStore cascade). Proper fix: alias the v1 children to the **old v2 child URNs** (pull from `pulumi stack export`) so it's in-place; also `ignoreChanges:["data","stringData"]` on `control-plane-secrets` (empty-at-preview → spurious replace); and the apply-time `talos.cluster.getHealth` barrier (first-boot 6443 race). Root cause: post-apply the `talos.cluster.Kubeconfig` resource is in state with a **known** value, so provider-side k8s ops (only the barman v2 ConfigFile today) dial `:6443` at preview, which preview runners can't reach. Infra PRs show a **red but non-required** `preview` until fixed (`check` is the only required status).
- **`box_` retirement** — `box_`/`BoxId`/`box_id` is **live/retained-by-design** (pg schema migration 0001, `store-sql.ts`, `store-contract.ts`, `domain.ts`, reconciler writes `boxId:null`). Since no legacy data was moved, it's pure-vestigial. Decision: leave it, OR a `0002` drop-columns migration (its own PR, careful live-DB apply).
- **Doc-sweep** — stale refs from earlier PRs (FakeBoxMaker, `BoxMaker`/`AgentRunner` Tags → `AgentWorker`, root `infra/pulumi/` comments) + mark the migration tracker done.
- **Rotate everything** — breakglass leaked (long-deferred) AND `ci` was **widened** this session (now decrypts 5 secrets incl. `forge_github_token` + `runner_opencode_auth_json`, not 3 — see AGENTS secrets matrix). If stepping away from the project, rotate before leaving. Handover: `.handoffs/INVESTIGATE-secret-leak-guard.md`.
- **Slim agent-worker image** (~360MB via `bun install --production` / alpine).

## Key facts / gotchas
- **cmux teams:** spawn NAMED teammates (split-pane, self-worktree), NO `isolation` flag. **One separate reviewer agent per PR** (self-approve is blocked on GitHub for the single account → reviewers post an APPROVED *comment*; merge on that + green required `check`). Stand teammates down as their PR merges.
- **Images are digest-pinned** in `infra/pulumi/cluster/Pulumi.production.yaml` (`controlPlaneImage`/`agentWorkerImage` `@sha256:…`) — bump deliberately on a new control-plane release; the deployed pod won't change until re-pinned+applied.
- Branch protection on `main`: only `check` is a required status; reviews are NOT required (so agent comment-approvals + green check suffice to merge).
- Commit signing (1Password op-ssh-sign) can't auth non-interactively for agents → teammates commit with `commit.gpgsign=false` (pre-existing commits already unsigned).
- Working trees: this session ran from a worktree under `.claude/worktrees/`. Old reseal/main-commit worktrees were cleaned up; the pr6/pr7 builder worktree may remain.

## Suggested skills
- `superpowers:using-git-worktrees` + cmux named teammates for the teardown PR + any follow-up PR (per-PR reviewer).
- `superpowers:brainstorming` before the teardown if the root-stack `pulumi destroy` scope is uncertain.
- `resolving-merge-conflicts` if follow-up branches drift behind main.
- The repo's own `no-mistakes` / review flow before merging each PR.
- `saving-a-memory` — the operator's declarative-infra + handoffs-are-kept preferences are already saved globally; add any new ones.

## Pointers
- Design/tenets: `DESIGN.md`, `CLAUDE.md`/`AGENTS.md` (esp. tenets 1/2/9 for teardown; secrets matrix).
- Cluster program: `infra/pulumi/cluster/` (`workloads.ts` control-plane Deployment, `cnpg.ts`, `talos.ts`, `platform.ts`).
- Old (to delete): `infra/pulumi/index.ts`, `infra/pulumi/cloud-init.main.ts`.
- Draft to resolve: PR **#47** (retitle notes the churn issue).
