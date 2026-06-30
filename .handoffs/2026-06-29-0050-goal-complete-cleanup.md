# Tidepool — Handoff: GOAL COMPLETE, control plane live + self-improving (2026-06-29 00:50)

**The control plane is LIVE on Hetzner and self-improving. All goal conditions met + verified.** This supersedes `2026-06-28-2356-control-plane-hardening.md` (which was written mid-cascade and is now stale/pessimistic — its listed bugs were all fixed in PR #25). What remains is **day-2 features + cleanup**, none goal-blocking.

Repo: `/Users/calum/code/github.com/0x63616c/tidepool` (work in place). `main` is green.

## Verified end state (all with real output during the session)
| Condition | Evidence |
|---|---|
| All workstreams merged, green main | PRs through #26 (CI: check + commitlint + container-harness) |
| Worker e2e re-proven after runner rewrite | PR #17 + ticket isZero → `tp doctor` exit 0, provider=hetzner, 0 leaks |
| Control plane processes a ticket end-to-end FROM the box | isZero (`tckt_frky9ryot5`) → merged testbed PR #11, state `done` attempts=0 |
| Survives reboot with state on the volume | rebooted tp-main → daemon auto-`active`, 6 tickets survived, isZero still `done` |
| Dogfood: system merges a PR on its OWN repo | **tidepool PR #26 (`isBlank`, `src/strings.ts`) MERGED by the daemon** |

## How it runs now
- `tp-main` (cx23, nbg1, `<box-ip>`) runs `tp run --watch` (reconcileForever, 30s tick) via systemd `Restart=always`. sqlite on the protected `tp-state` volume at `/mnt/tidepool/tidepool.sqlite`. Firewall deny-inbound-except-22.
- Drop a ticket on the box (`ssh root@<box-ip>`, then `cd /opt/tidepool; export TIDEPOOL_DB_PATH=/mnt/tidepool/tidepool.sqlite; bun run src/cli.ts ticket add --title ... --goal ... --target <owner/repo>`). The daemon leases **snapshot** workers (~49s boot, image `402689070`), runs opencode for **work and review (both on workers)**, formats, pushes, opens a PR, gates on CI, merges, tears down.
- Targets: `tidepool-testbed` uses the cheap model; any other repo (incl. `0x63616c/tidepool` itself) uses the strong global model `gpt-5.5` — no `targets[]` entry needed (config resolves target-override ?? global).
- Observe: `tp trace <ticket>`, `tp logs <ticket>`, `tp doctor`, `tp cost` on the box. Provisioned via `pulumi up` from `infra/pulumi/` (S3 backend `s3://tidepool-pulumi-state?endpoint=nbg1.your-objectstorage.com`; passphrase `~/.tidepool/bootstrap/pulumi-passphrase`).

## Bugs fixed this session (all merged) — for context, do NOT redo
Original 6-bug worker chain (host-key, unzip, HOME, opencode-install, apt-lock, sshRun `sh -c`), then live-on-control-plane: cloud-init nested-quote (#18), review `gh`-token→REST diff (#21), runner format-before-commit (#22), format-only best-effort + snapshot activate (#23), and review-on-worker + opencode session 8-min timeout + review-aware retry (#25).

## REMAINING — day-2 features (deferred, tracked as tasks)
- **#16 warm worker-box pool** — Hetzner bills per-hour-min; today it's one box per ticket. Keep a worker warm across tickets (wipe workspace between), reap at idle/TTL. Big cost win at volume. Behind BoxMaker.
- **#17 self-update timer** — daemon doesn't auto-pull new tidepool code (it ran git reset --hard manually each redeploy this session). Add a `tidepool-update.timer` (~2-5min): if origin/main SHA != deployed → git pull + bun install + restart. Pull-based (tenet 9).

## REMAINING — cleanup (small, not goal-blocking)
- **`retries` is still 2** in tidepool.config.ts (PR #25's bump-to-5 didn't land). Bump to 5 — a one-line PR.
- **Pulumi state drift**: the `pulumi up` replace detached the volume + cloud-init ran before it attached → I hand-mounted/formatted + manually re-attached. State is slightly off; the volume attach lives outside pulumi's recorded state. Run `pulumi refresh` + reconcile; fix the volume-before-cloud-init ordering so `tp up` is truly one-command.
- **Control-box opencode hack is now MOOT** (review runs on workers): I had added `bun add -g opencode-ai`, `/root/.local/share/opencode/auth.json`, and a systemd drop-in `/etc/systemd/system/tidepool.service.d/path.conf` (`Environment=PATH=/root/.bun/bin:...`) on the live box. Harmless but unnecessary — can remove.
- **testbed PR #9 (isOdd)** left OPEN+green from the pre-fix bounce — close it. Stale failed tickets in the box DB (reverseString/clamp/isEven/isPositive) — harmless.
- **~16 agent worktrees** under `.claude/worktrees/agent-*` + branches — `git worktree prune` + delete merged branches.
- **Commit signing**: 1Password SSH signer can't unlock for headless agents (`failed to fill whole buffer`) → all agent commits this session are unsigned (squash commits on main are GitHub-signed regardless). Decide: a signing path for agents, or accept unsigned.
- **AGENTS.md hcloud-CLI note** never landed (the PR was abandoned when the guard blocked branching from the main checkout). Re-add if wanted: `HCLOUD_TOKEN=$(cat ~/.tidepool/bootstrap/hcloud_token) hcloud ...` (stored homelab context token is stale).

## Env / footguns
- Secrets in `~/.tidepool/bootstrap/` (hcloud_token, opencode-auth.json, ssh-tidepool, age-*.key, hetzner-s3.env, pulumi-passphrase). `secrets/tidepool.enc.yaml` sops-encrypted.
- SSH boxes: `ssh -i ~/.tidepool/bootstrap/ssh-tidepool -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@<ip>`.
- Run `tp` from repo root (DB_PATH CWD-relative unless `TIDEPOOL_DB_PATH` set). Snapshot worker image `402689070`. Control-box capacity chain cx23→cpx21→cx33→cpx31.
- Can't `git checkout -b` from the main checkout (guard) — agents work in `isolation: worktree`. Auto-merge on green CI is ON.
- The control box does NOT auto-update code — after merging a tidepool change, redeploy: `ssh root@<box-ip> 'cd /opt/tidepool && git reset --hard origin/main && bun install --frozen-lockfile && systemctl restart tidepool'` (until #17 lands).

## Suggested skills
effect-ts + tdd (repo); superpowers:dispatching-parallel-agents; superpowers:systematic-debugging; verify (prove via `tp trace`/`tp doctor`, paste output).
