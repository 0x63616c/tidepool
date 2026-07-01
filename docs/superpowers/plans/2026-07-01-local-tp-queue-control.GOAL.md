# GOAL — Local `tp` queue-control shipped as one green, merged PR

Implement the plan at `docs/superpowers/plans/2026-07-01-local-tp-queue-control.md` in full and ship it as ONE green, merged PR. This condition is judged from the conversation transcript only — surface every command and its output.

## End state (all must be transcript-proven)

1. **Reviewed, then merged PR, no direct push.** A single PR (branch `tp/tckt_t9zo30-local-queue-control`, title `feat(cli): local tp queue-control over HttpApi (tckt_t9zo30)`) is **reviewed and then merged into `main`**. Sequence, all transcript-proven:
   - Run the review gate (`/review` or `no-mistakes`) against the branch; surface its findings.
   - **Address every blocking finding** (fix code, or justify in-transcript why it's non-blocking) — do not merge over unresolved review objections or by weakening the change.
   - Only after review is clean **and** CI is green, merge. Prove it: surface `gh pr view <n> --json state,mergedAt,reviewDecision,statusCheckRollup` showing `"state":"MERGED"`, a non-blocking `reviewDecision`, and every check `SUCCESS`/green.
   - No commit lands on `main` outside this PR; no self-merge before review + green CI.

2. **Gates green, output shown.** `bun run check` (biome + lint:sh + typecheck + test) is run and its tail is surfaced showing **exit 0**, with **0 failed and 0 skipped tests** and **0 new `.skip`/`xfail`/`.only`**. `git status` at the end shows a clean tree (only the intended files changed).

3. **All 7 plan tasks delivered — each provable by a named artifact:**
   - `src/queue-control.ts` exports `QueueControl` with exactly the 5 methods `add`/`list`/`get`/`runsFor`/`events` and the `{items,nextCursor}` `Page` envelope; `src/queue-control.test.ts` proves pagination (2-page split) and passes.
   - `src/cli.ts` command tree is `tp ticket {add,list,get,logs,transcript}` (+ `doctor`); `grep -nE "bucket-init|SEED_GOAL|reconcileForever|\bupCommand\b|\brunCommand\b" src/cli.ts` returns **empty**.
   - `src/daemon.ts` exists and is the pod entrypoint; `infra/docker/control-plane.Dockerfile`, `infra/systemd/tidepool.service`, and `infra/pulumi/cluster/control-plane-deployment.ts` reference `src/daemon.ts` (not `tp run --watch`); `src/daemon.test.ts` passes.
   - `add` rejects an unconfigured target with `TargetNotConfigured` (test surfaced passing); `tidepool.config.ts` `targets[]` contains `0x63616c/tidepool`; `list` accepts `--target`.
   - `src/queue-api.ts` + `src/queue-api-server.ts` + `src/http-queue-control.ts` exist; `src/queue-api.test.ts` proves an `add→list` round-trip over HTTP **and** the `TargetNotConfigured` + `TicketNotFound` error mappings, all passing.
   - `src/client-config.ts` + `src/client-config.test.ts` exist; test proves `flag > env > file > default` resolution and `[contexts.*]` parsing, passing.
   - `DESIGN.md` updated: documents `QueueControl`, the daemon, `~/.tidepool/config` contexts, port-forward-now/Tailscale-later, and the deferred cancel/retry gap.

## Boundaries — forbidden shortcuts (naming the dodges)

- **Tenet 3 — no mover on the wire.** `QueueControlApi`, `queueApi` (HttpApi), and `HttpQueueControl` expose ONLY `add`/`list`/`get`/`runsFor`/`events`. They MUST NOT contain `patch`, `addRun`, or `appendEvents`. Prove: `grep -nE "patch|addRun|appendEvents" src/queue-control.ts src/queue-api.ts src/http-queue-control.ts` returns **empty**.
- **Tenet 10 — one HTTP layer.** No raw `fetch`; HTTP is `@effect/platform` only. Prove: `grep -rn "fetch(" src/queue-api*.ts src/http-queue-control.ts src/client-config.ts` returns **empty** (the port-forward uses `@effect/platform` `Command`, not `child_process`).
- **Tenet 9 — no public inbound, no app auth v1.** The k8s Service is `ClusterIP` (no `LoadBalancer`/public ingress). No bearer-token/auth middleware added; a `// TODO(tailscale): require bearer token when reach widens` marker is present in the server. Do not open a public port to satisfy any browser/smoke check.
- **Tenet 1/2 — contexts are not git config.** Client contexts live in `~/.tidepool/config`; **no context/current-context/API-URL field is added to `tidepool.config.ts`** (it gains only the `0x63616c/tidepool` target). Prove: `grep -nE "context|current-context|apiUrl|api_url" tidepool.config.ts` returns **empty**.
- **Out of scope — do NOT implement.** No user-facing `cancel`/`retry` verb; no Tailscale; no app auth. These are documented as deferred, not built.
- **Tenet 12 — red before green.** Every behavior change has a test written first that fails without the impl; surface at least the `QueueControl.list` pagination test and the `add`-validation test failing before their impl, then passing after. Do not weaken, delete, `.skip`, or `xfail` any existing test to make the suite pass.
- **No relic resurrection / no unrelated files.** `up`/`bucket-init`/`run`-oneshot CLI verbs stay deleted; `git status` shows only files named in the plan's File Structure.

## Executor note

Work the plan task-by-task (superpowers:subagent-driven-development or executing-plans), commit-sliced per the plan (each commit `#tckt_t9zo30 <type>(scope): ...`). Verify the flagged unknowns before coding: exact `EventQuery` field names (`src/services.ts`), `reconcileForever` arity (`src/reconciler.ts`), and the `@effect/platform` 0.96.2 `HttpApi*`/`HttpApiClient` surface (load the `effect-ts` skill). Done = the merged, green PR above — not a local pass.
