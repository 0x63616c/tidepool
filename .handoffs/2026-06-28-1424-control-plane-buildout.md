# Tidepool — Handoff: finish control-plane bring-up + remaining workstreams (2026-06-28, updated)

Continuation of a long multi-agent push. **Phase C is PROVEN+LANDED.** Almost everything is merged to a green `main`; what's left is finishing the control-plane bring-up (one human `scp`) and a few non-blocking workstreams. Repo: `/Users/calum/code/github.com/0x63616c/tidepool` (work in place, not a worktree). Docs in root: `DESIGN.md`, `HANDOFF.md`, `AGENTS.md` (=`CLAUDE.md`), `GOALS.md`, `RESEARCH.md`.

## The goal (active /goal)
All remaining workstreams merged to green main (CI: check + commitlint); Hetzner worker e2e re-proven after the runner rewrite (tp doctor exit 0, provider=hetzner, 0 leaked boxes) — **DONE**; control plane running on a Hetzner main box (systemctl is-active tidepool, processes a ticket from the box, survives reboot with state on the volume); a dogfood self-edit ticket merged on the tidepool repo by the system itself. Each independently verified with pasted real output. Use agent teams.

## Operating model
- You are the lead: delegate workstreams to sub-agents (Agent tool, `isolation: worktree`) with **explicit non-overlapping file lanes**; review/validate; keep your context lean. Verify-don't-trust (paste real output).
- **Auto-merge is ON.** Agents `gh pr merge --auto --squash`; strict branch protection (required `check` + `commitlint`, linear history) → behind PRs need `gh pr update-branch <n>`. Lead-manage merge order for same-file streams.
- **One live Hetzner e2e at a time** (shared testbed repo + ticket + N=1 worker). Throwaway-box tests (volume/snapshot bake) can run alongside.
- Spend authorized (≤5 boxes *concurrent*). Every worker box must be deleted (reaper is the backstop; it skips `role=management`).

## What's MERGED (PRs #5–#17, main @ 16b8617)
- Phase-C worker fixes + box→ticket labels (#7), ssh regression tests (#8), docs (#9), **bake.sh + image param** (#10), **observability P1** failure-reasons+run_events+`tp logs`/`transcript` (#11), **`tp trace`/`tp cost`** (#13), **volume + `TIDEPOOL_DB_PATH` seam** (#12), **Pulumi control-plane scaffold + S3 bucket helper** (#14), cx23 (#15), **`tp up` + `reconcileForever` + `tp run --watch`** (#16), **Effect runner rewrite** `src/worker/*`, no process.exit, e2e re-proven (#17). 199 tests green.

## LIVE RIGHT NOW: control-plane bring-up (#14c, in progress)
- `tp up` (bg task) provisioned **`tp-main` cx23 @ nbg1, ip <box-ip>** (running). Pulumi stack `main` on the S3 backend `s3://tidepool-pulumi-state?endpoint=nbg1.your-objectstorage.com`. Passphrase at `~/.tidepool/bootstrap/pulumi-passphrase` (export as `PULUMI_CONFIG_PASSPHRASE` for any pulumi/tp-up run).
- Cloud-init is installing (bun/git/sops/clone main/`bun install`), then the systemd unit `tidepool.service` is enabled-but-STOPPED via `ConditionPathExists=/root/.tidepool/bootstrap/age-mainbox.key`.
- **THE ONE REMAINING HUMAN STEP (H2):** `scp ~/.tidepool/bootstrap/age-mainbox.key root@<ip>:/root/.tidepool/bootstrap/age-mainbox.key`. `tp up` prints it with the real IP after cloud-init, then polls for readiness. (H1 = S3 keys, already done; bucket created.)
- **To finish/verify #14c:** ensure `tp up` reaches ready (or re-run `tp up` — idempotent: pulumi no-op + re-poll) → `ssh root@<box-ip> systemctl is-active tidepool` == active → add a ticket (`tp ticket add` targeting `0x63616c/tidepool-testbed`) → confirm the BOX (not laptop) leases a worker and drives it to a merged testbed PR → `tp doctor` from the box exits 0 → **reboot test** (`hcloud server reboot tp-main` → after boot daemon `active`, `tp ls` shows prior state = volume survived). Watch: the box needs a GitHub token to push/PR — `materialize-secrets.sh` regenerates the bootstrap layout from sops; confirm `GITHUB_TOKEN` is delivered (sops/`gh auth`). This is the most likely gap to debug.

## REMAINING workstreams (not started — next session)
All non-blocking to the bring-up; needed for "all workstreams merged":
- **#8/#11 snapshot cutover (infra-A2):** bake the worker image (builder box → `bake.sh` → `POST /servers/{id}/actions/create_image`), wire `config.box.imageId` into `HetznerBoxMakerLive`, trim `workerCloudInit` to baked mode, e2e re-validate + record cold-boot delta. Foundation already merged (#10: `bake.sh`, `image` param default ubuntu, `infra/worker/Dockerfile`). Pulumi *consumes* a snapshot (`getImage`) but baking stays imperative (or add Packer later).
- **#9 container harness:** run `bake.sh` install in a clean `ubuntu:24.04` Docker container in CI (a NEW workflow job — the one legit `.github/workflows` edit) so install-env bugs are caught without Hetzner. Reuses `bake.sh`; install job must stay on stock ubuntu (not the baked image).
- **#15 dogfood self-edit ticket:** add a `tidepool` self-target to `tidepool.config.ts` + a small low-blast-radius ticket targeting `0x63616c/tidepool` itself; let the control-plane box run it → merged self-PR on tidepool. The headline closing proof. Needs control plane up + observability (have it).
- **#16 (day-2) warm worker-box pool:** amortize Hetzner's 1hr-min billing — keep a worker alive across tickets (wipe workspace between), reap at idle/TTL. Behind BoxMaker. Defer until throughput justifies.
- **#17 (day-2) self-update timer:** `tidepool-update.timer` (~2–5min): if origin/main SHA != deployed → git pull + bun install + restart (reconciler resumes from volume). Pull-based (keeps tenet 9). Code→timer, infra→box-roll.

## Footguns / environment
- Run `tp` from repo ROOT (`DB_PATH` CWD-relative unless `TIDEPOOL_DB_PATH` set). On the box it's `/mnt/tidepool/tidepool.sqlite` (the protected volume).
- Secrets in `~/.tidepool/bootstrap/` (hcloud_token, opencode-auth.json, ssh-tidepool, age-*.key, hetzner-s3.env, pulumi-passphrase) — never print/commit. `secrets/tidepool.enc.yaml` sops-encrypted.
- **Cleanup debt:** ~10 agent worktrees under `.claude/worktrees/agent-*` + local `worktree-agent-*` branches accumulated. Prune (`git worktree prune`, delete merged branches) — don't delete unmerged work.
- Pulumi runs under **node** in standalone `infra/pulumi/` (deps via `bun install` since npm is policy-blocked here); rest is Bun. `.mise.toml` pins node 22 + pulumi.
- Control-box capacity fallback chain: `cx23 → cpx21 → cx33 → cpx31` (Intel flaky → AMD second), nbg1→hel1→fsn1; ≤€30/mo (cx23 €6.49).
- Commit/PR: `#tckt_<lowercase base36> type(scope): subject` ≤100; branch `tp/<tckt>-slug`; footer `Ticket: <id>`.

## Suggested skills
- superpowers:dispatching-parallel-agents + Agent tool (lead, lane isolation)
- effect-ts (repo; skip `.repos/effect` clone), tdd (repo) — for #8/#9/#15
- superpowers:verification-before-completion + verify — prove e2e by running it, paste output
- axi (repo) — any `tp` CLI surface
- superpowers:systematic-debugging — control-plane bring-up (esp. the GitHub-token-on-box gap)
