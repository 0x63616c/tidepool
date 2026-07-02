# Handoff — pipeline hardening + concurrency semantics

**Date:** 2026-07-01 19:40 PDT (2026-07-02 UTC)
**Context:** Long session that took the tidepool autonomous loop from "every prod ticket fails" to **e2e loop proven**, fixed a cascade of sandbox/observability bugs, and set up the next big piece: hardening the concurrency gate + designing ticket-selection as a seam.

---

## TL;DR — where things stand

- **The e2e loop WORKS now.** `tckt_52d1ao2ab0` ran the full path (dispatch → clone → opencode → commit past gitleaks → push → reconciler opened **PR #91** → `review`). First time this session. See task history.
- **PR #91 is stuck on a real bug:** commitlint fails on the auto-generated commit message (too long + sentence-case). Filed as `tckt_59qqc9ah8h` (held). This blocks *actual merge* of any ticket whose title is long/capitalized — **systemic**, must fix before running the queue wide.
- **Worker-cap fix (PR #92) merged** but has correctness gaps the user (correctly) flagged. Next big work item = **harden it** (decisions locked, see below). NOT yet filed as a ticket.
- **Deploy is drifted from GitOps:** several fixes were **bypass-deployed via `kubectl set env/image`** on `deploy/reconciler -n core` because infra auto-deploy is flaky/approval-gated. Cluster ≠ Pulumi state until next real `infra.yml` deploy reconciles it. This was user-approved for speed.

---

## What got merged this session (all on `main`)

Reference the PRs, don't re-read them:
- **#81** `tckt_dxtmo` — session timeout 8min→60min, Job `activeDeadlineSeconds`→3900/65min, `ttlSecondsAfterFinished`→86400/24h; poll-based progress logging (`pollProgress`/`diffMessages` in `src/worker/opencode-session.ts`, since SSE only yields heartbeats in-cluster).
- **#82** `tckt_fxtlog` — full transcript logging: text/reasoning deltas + file diffs, 1s poll.
- **#83** `tckt_patb8ggxrz` — `shellFailureReason()` extracts real git stderr into `GitFailed.reason`.
- **#84** `tckt_nkbk90kb7n` — shellcheck + shfmt v3.10.0 in `infra/docker/base.Dockerfile`.
- **#86** `tckt_causepretty` — `get message()` on `GitFailed`/`OpencodeFailed` so `Cause.pretty` prints the real reason (the #83 fix wrote the field but nothing logged it — `Cause.pretty` fell back to "An error has occurred").
- **#88** `tckt_j1kzlez9t7` — gitleaks v8.30.1 in base image (lefthook pre-commit needs it; only bites when a ticket runs `bun install`, which fires `prepare: lefthook install`).
- **#92** `tckt_e7mtol8fat` — `atWorkersCap` admission gate (see hardening section — this is the one needing rework).
- Plus CI-build fixes merged by other agents: #85, #87, #89 (buildx/concurrency).
- **#80** `tckt_gitsha` — git-sha pod label (NOTE: currently long 40-char sha; user wants **short** sha + `kind=work/review` on all log lines — not yet ticketed).

**Root cause of the original "every ticket fails":** gpt-5.5 agentic sessions run ~6–9 min but the hard session timeout was 8 min → killed mid-work. The "silent hang" was an observability lie (SSE `client.event.subscribe` only delivers heartbeats in-cluster; real progress is only in `GET /session/:id/message`). Model/auth/egress were all fine. Saved to memory: `prod-ticket-failure-session-timeout`.

---

## NEXT: harden the concurrency gate (decisions LOCKED, ticket not yet filed)

PR #92 added `atWorkersCap` in `src/reconciler.ts` but it's thin. User reviewed and made two decisions:

### Decision 1 — `workers.max` caps the WHOLE PIPELINE
Today it counts only `running` (live agent Jobs). **Change it to count `in_progress` + `running` + `review`** (every ticket past `backlog`, pre-terminal). So `max=1` → exactly ONE ticket flows dispatch→work→PR→review→merge before the next leaves `backlog`.

### Decision 2 — full crash-safety + test matrix
- **Idempotent dispatch:** Job name currently uses `Math.random()` suffix (`src/k8s-agent-worker.ts:456`, `defaultSuffix`). Make it **deterministic per (ticket, attempt)** so a crash between `worker.dispatch()` (Job created) and `store.patch(state:running)` → re-dispatch **collides** (AlreadyExists) instead of creating a 2nd Job. Closes the crash-window double-dispatch.
- **Test matrix** (all missing today — PR #92 only has 2 tests): failure frees a slot → next deferred dispatches; `review` dispatch is gated (not just work); mixed work+review at cap; FIFO ordering when a slot frees; `in_progress`/`rate_capped` slot accounting under new semantics; backlog→in_progress is currently *ungated* (decide if that's ok).
- **Multi-replica race** (read-then-act, no `SELECT FOR UPDATE`): safe only at `replicas:1`+`Recreate`. Document as a known HA limitation OR fix. Lower priority (not a live bug).

### Decision 3 — structure for the future (design-for-N, tenet 7)
The user's north star: ticket selection becomes a pluggable **"which ticket next" algorithm** (e.g. a future `--blocked-by <ticket_id>` flag; pick newest-not-blocked, one dimension at a time). **Do NOT build that algorithm yet.** But structure the code so the selection decision is a clean seam (an injectable function/module) the algorithm can slot into later. Two structural requirements:
1. **The pipeline must support `max > 1`** — don't hardcode 1; generalize the gate to N concurrent.
2. For now, selection = simple (FIFO). NOTE: code today is FIFO **oldest-first** (`store-sql.ts:143` `ORDER BY seq` ASC). User said "pick up the next latest" — **clarify oldest vs newest with the user** before changing; the current oldest-first may be fine.

### Full state list (from `src/domain.ts:15`)
`backlog`, `in_progress`, `running`, `review`, `done`, `failed`, `rate_capped`. Only `done`/`failed` terminal (`isTerminal`). **`NON_TERMINAL` in reconciler = [backlog, in_progress, running, review]** — `rate_capped` is EXCLUDED, so settle may never re-pick a rate_capped ticket → **possible gap**, fold into the hardening ticket or file separately. Interactive state diagram was generated at `scratchpad/ticket-state-machine.html` (transitions extracted from `stepTicket`).

---

## Held ticket "parking lot" (in prod DB, `state='failed'` as a manual hold)

The user uses `failed` state as a parking lot. These are FILED but intentionally held (flip to `backlog` one at a time to run). Query: `kubectl exec -n core pg-1 -c postgres -- psql -U postgres -d app -c "SELECT id,state,title FROM tickets ORDER BY seq"`.

Currently held (not yet worked): `tckt_39af8lic1l` (tp port-forward orphan/ephemeral port), `tckt_m6xxluu7z8` (Node20→24 in CI, **authorizes workflow edit**), `tckt_4utv62nij6` (reconciler dispatch logging + correlation ids), `tckt_47hjg4jo3o` (agent-worker Logger.json — see below), `tckt_bxg9td75e6` (reconciler interval 30s→5s + make configurable), `tckt_nylipfjaod` (retry transient git failures esp. clone), `tckt_v7mxbn63ek` (tp ticket list cols → `{id,state,target,title}`), `tckt_59qqc9ah8h` (commitlint on auto-gen commit msg + `workTitle` missing `#tckt_` prefix — **blocks merges**), `tckt_gn3lrfkpel` (jq missing in sandbox → dx-hooks tests fail).

`tckt_e7mtol8fat` (worker cap) and `tckt_j1kzlez9t7`/`tckt_nkbk90kb7n` (sandbox tools) are held-but-DONE (superseded by merged PRs #92/#88/#84).

**Not yet filed but discussed:** short-git-sha + `kind=` on all logs; the concurrency-hardening ticket above.

## Live agents (cmux teammates) — likely need standing down
`dex-worker-cap` (#92 merged), `dex-gitleaks-image` (#88 merged), `dex-full-transcript-logging` (#82 merged; still owed the Logger.json follow-up = `tckt_47hjg4jo3o`), `dex-causepretty-fix`, `dex-shellcheck-image` — most are idle/done. Stand down as their PRs merge.

---

## Key gotchas / mechanisms learned

- **Deploy path:** merge → `images.yml` (build+push `:${full_sha}` + `:latest`) → `infra.yml` (`pulumi up`, **gated on manual approval in the `production` GitHub Environment**, path-filtered to `src/**`/`infra/**`/etc). A CI-only PR won't trigger infra. Rapid merges cancel each other's infra runs. **`kubectl rollout restart` ≠ deploy** (freezes env). Bypass = `kubectl set env/image deploy/reconciler -n core` with digests resolved via `docker buildx imagetools inspect ghcr.io/...:${full_sha} --format '{{.Manifest.Digest}}'`.
- **Local e2e harness (fast, no k8s):** build `base.Dockerfile`→`agent-worker.Dockerfile` (`--build-arg BASE_IMAGE=tidepool-base:local`), then `docker run -w /work -v config.json:/work/config.json -v auth.json:/secrets/auth.json --entrypoint bun <img> run /app/src/worker/agent-worker.ts`. config.json = a `RunnerConfig` (kind/cloneUrl-with-token/base/branch/dir/model/prompt/commitMsg). auth.json from `~/.local/share/opencode/auth.json`. **Caveat:** testbed repo has no lefthook, and a task that doesn't run `bun install` won't install lefthook hooks → won't reproduce commit-gate bugs. Point at real `tidepool` repo + force `bun install` to reproduce.
- **`tp` port-forward orphan:** a killed `tp` leaks its `kubectl port-forward` on local :8080; next `tp` fails with a misleading "VPN?" error. Fix: `lsof -tiTCP:8080 -sTCP:LISTEN | xargs kill`. (Ticket `tckt_39af8lic1l` fixes properly.)
- **`bun link` the `tp` CLI from main repo root, never a worktree** (GC breaks it). Memory: `tp-link-from-main-not-worktree`.
- Reconciler is `replicas:1` + `Recreate`, no securityContext (namespace only warns). CNPG primary = `pg-1 -n core`, db `app`, `psql -U postgres`.

---

## Suggested skills for the next agent
- `superpowers:test-driven-development` — the hardening work is TDD-first (the whole point of the user's pushback on #92 was thin tests).
- `superpowers:systematic-debugging` — for the `rate_capped`/NON_TERMINAL gap and any new failures.
- `codebase-design` / `design-an-interface` — for structuring the ticket-selection seam (design-for-N, pluggable algorithm) without over-building.
- `effect-ts` — all reconciler/worker code is Effect; follow repo patterns.
- Dispatch the hardening work to a **Sonnet subagent** in a worktree (user's established pattern), TDD, green merge. One-ticket-at-a-time discipline is for the *tp prod queue*, NOT directly-dispatched agents (user confirmed).

## Immediate next steps
1. File the concurrency-hardening ticket (held) with Decisions 1–3 baked in. Ask user: fold the `rate_capped` gap in or separate? And clarify FIFO oldest-vs-newest.
2. Fix `tckt_59qqc9ah8h` (commitlint on auto-gen commit msg) — it blocks PR #91 and every future ticket merge. Arguably do this FIRST (unblocks the proven loop).
3. Then bypass-deploy #92 (currently merged but NOT deployed — reconciler still on pre-#92 image; resolve digest for current `main` HEAD and `kubectl set env/image`).
