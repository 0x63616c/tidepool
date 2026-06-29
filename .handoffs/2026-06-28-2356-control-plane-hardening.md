# Tidepool — Handoff: control plane is UP, finish the review/retry hardening (2026-06-28 23:56)

**The control plane is LIVE on Hetzner and ~90% proven.** All build workstreams are merged to a green `main`. What remains is a **hardening cascade on the review/retry/timeout path** — running it live keeps surfacing one real runner/reconciler edge-case at a time. No ticket has yet reached `done` *via the daemon*; that's the finish line.

Repo: `/Users/calum/code/github.com/0x63616c/tidepool` (work in place). Prior handoffs in `.handoffs/`. The `/handoff` skill now writes here.

## What is TRUE and verified
- **Control box `tp-main` is up**: cx23 @ `<box-ip>`, on `tidepool-private`, protected `tp-state` volume mounted at `/mnt/tidepool` (sqlite DB lives there), deny-inbound-except-22 firewall. `systemctl is-active tidepool` = **active**. Provisioned via `pulumi up` (self-managed S3 backend `s3://tidepool-pulumi-state?endpoint=nbg1.your-objectstorage.com`, passphrase at `~/.tidepool/bootstrap/pulumi-passphrase`).
- **The daemon autonomously runs the pipeline**: it leases a snapshot worker (~49s boot, image `402689070`), runs opencode, formats, commits, pushes a branch, and **opens a green PR** — verified live: testbed PR #9 (`feat: add isOdd`) is OPEN + CI-GREEN + MERGEABLE, produced entirely by the box.
- **All build workstreams MERGED** (`main` green, ~224 tests): runner Effect rewrite (#17), observability P1/P3 (#11/#13), volume+DB seam (#12), Pulumi scaffold+`tp up`+`reconcileForever` (#14/#15/#16), snapshot+harness (#20), and this session's live-bug fixes (#18 cloud-init, #21 review-diff, #22 format, #23 format-only+snapshot).
- **Observability is the hero**: every bug below was found via `tp trace <ticket>` / `tp logs` on the live box (run them on the box with `cd /opt/tidepool; export TIDEPOOL_DB_PATH=/mnt/tidepool/tidepool.sqlite`).

## Live bugs found+fixed THIS session (each was real)
1. main-box cloud-init nested-quote `runcmd` → box installed nothing → `write_files` (PR #18).
2. review used `gh pr diff` → GitHub App token rejected by gh's GraphQL → ShellError → switched to REST diff (PR #21).
3. runner didn't format opencode output → biome CI red → run repo formatter pre-commit (PR #22).
4. that format step used `biome check --write` (lint-gates, exits non-zero) → made it `bun run format`/`biome format --write`, best-effort (PR #23). Also activated snapshot `imageId=402689070` (PR #23).

## REMAINING bugs (the blockers to a clean `done`) — priority order
1. **Review runs opencode LOCALLY on the control box**, but the box's cloud-init installs bun/git/sops/node, NOT opencode/auth → `Executable not found in $PATH: "opencode"`. I **hacked the running box** (`bun add -g opencode-ai@1.17.11`, copied `opencode-auth.json` to `/root/.local/share/opencode/auth.json`, added a systemd drop-in `Environment=PATH=/root/.bun/bin:...`) — works now but **NOT durable** (a re-provision loses it). FIX: either add opencode+auth+PATH to `infra/pulumi/cloud-init.main.ts` + `infra/scripts/materialize-secrets.sh` + the systemd unit, OR (cleaner) make `agents.review` run on a worker box like `agents.work` does (review currently records `boxId: null` = local).
2. **No timeout on the opencode session in the runner** → a hung opencode session (observed live: files created, session never idle, `opencode serve` stuck) hangs the runner AND blocks the daemon's whole `settle` forever. FIX: add a hard session timeout (abort + AgentFailed if no `session.idle` within N min) in `src/worker/opencode-session.ts`.
3. **Retry re-runs WORK on an already-pushed branch** → non-fast-forward push → fails, wasting attempts. The resume guard (`reconciler.ts` in_progress case: `workedAttempt===attempts && prNumber!==null → review`) breaks because a review-failure retry bumps `attempts`. FIX: on a review/CI failure, retry should re-enter REVIEW (or work should force-with-lease / handle the existing branch).
4. **`retries: 2` too low** for a flaky live system — transient worker-boot/CI-timing/opencode hiccups exhaust attempts before success. Bump to ~4-5 (`tidepool.config.ts`).

## Lower-priority / cleanup
- `pulumi up` replace **detached the volume** + cloud-init ran before it attached → I hand-mounted/formatted; pulumi state is slightly drifted (manual reattach). Reconcile state + fix the volume-before-cloud-init ordering so `tp up` is truly one-command.
- `tp up` readiness poll false-negative (`cloud_init=-` despite done).
- 1Password SSH **commit-signing fails for headless agents** (`failed to fill whole buffer`) — agents commit unsigned (`-c commit.gpgsign=false`); PR #23 squash is unverified. Need a signing path for agents or accept unsigned.
- Prune ~16 agent worktrees under `.claude/worktrees/`.
- Stale tickets in the box DB: reverseString/clamp/isEven failed; **isOdd → testbed PR #9 OPEN+GREEN, never merged** (good evidence of the work pipeline); isPositive stuck (worker killed).

## NOT yet done (the goal's remaining conditions)
- A ticket reaching **`done` via the daemon** (blocked by #1-3 above).
- **Reboot/state-survival test** (`hcloud server reboot tp-main` → daemon active + `tp ls` shows prior state — note the hacks in bug-#1 are on-disk so they survive reboot, but a re-provision wouldn't).
- **Dogfood** self-edit ticket merged on the tidepool repo by the system.
- Day-2 (explicitly deferred): warm worker-box pool (#16), self-update timer (#17).

## Recommended next moves
1. Fix bugs #1-4 (one or two agent PRs: opencode-on-control-box durable + session-timeout + retry-to-review + bump retries). 2. Redeploy the box (`ssh root@<box-ip> 'cd /opt/tidepool && git reset --hard origin/main && bun install --frozen-lockfile && systemctl restart tidepool'`). 3. Add a fresh ticket → should reach `done`. 4. Reboot test. 5. Dogfood.

## Env / footguns
- Secrets in `~/.tidepool/bootstrap/` (hcloud_token, opencode-auth.json, ssh-tidepool, age-*.key, hetzner-s3.env, pulumi-passphrase). `secrets/tidepool.enc.yaml` sops-encrypted.
- hcloud CLI: `HCLOUD_TOKEN=$(cat ~/.tidepool/bootstrap/hcloud_token) hcloud ...` (stored homelab context token is stale — also noted in AGENTS.md... actually that note PR was never landed; re-add if wanted).
- Pulumi runs under node in `infra/pulumi/` (deps via `bun install`); snapshot worker image `402689070`; control-box capacity chain `cx23→cpx21→cx33→cpx31`.
- SSH to boxes: `ssh -i ~/.tidepool/bootstrap/ssh-tidepool -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@<ip>`.
- Commit/PR: `#tckt_<lowercase base36> type(scope): subject` ≤100; auto-merge on green CI is ON.

## Suggested skills
- superpowers:systematic-debugging (the review/retry/timeout bugs); effect-ts + tdd (repo); superpowers:dispatching-parallel-agents; verify (prove a ticket reaches done by running it, paste `tp trace`).
