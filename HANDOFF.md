# HANDOFF — start here

> Read order: **this file → `GOALS.md` → `DESIGN.md` → `RESEARCH.md` → `AGENTS.md` → `SKILLS.md`.**
> The design is LOCKED (DESIGN.md, from a long grilling session 2026-06-27). Your job is execution,
> not re-deciding. If a locked decision looks wrong, raise it with Calum in one line — don't silently
> diverge. **`GOALS.md` is the mission.**

## What Tidepool is (10-second version)

A personal agentic-coding control plane. The control plane runs as a Kubernetes Deployment
(`reconciler`, ns `core`) on a Talos/Hetzner cluster: a TS+Bun reconciler loop over a
**Postgres ticket store** (CloudNativePG, single source of truth). Tickets dispatch ephemeral k8s Jobs
that drive coding agents (opencode SDK, on Calum's Codex subscription) against a target repo:
`branch → PR → review → auto-merge-on-green`. Declarative infra (Pulumi in CI), secrets sops+age,
driven by `tp`. Full rationale in `DESIGN.md`.

## How you (the lead) operate this project

Calum talks to you like a **senior manager to a lead** — high-level, low direct context. You do the
work by **dispatching parallel agent teams + validators** (Workflow tool, Opus), not by grinding inline.
- **Work backward from a terminal check** (GOALS.md defines them). Never take "implement X" raw.
- **Dispatch, don't grind.** Keep your context lean; summarize up, don't dump transcripts.
- **Evidence before claims.** "Done" = the terminal check passed and you saw the output.
- **Tiered autonomy by blast radius** (DESIGN §4.5): testbed = full auto / cheap model (`gpt-5.4-mini`).
- **Effect-first, one way of doing things** (tenet 10). **Update docs in the same change** (tenet 11).

## Spend is authorized

Calum authorized real spend — **no permission needed** for `pulumi up` / cluster capacity. The controls
are the **guardrails** (concurrent worker-Job cap, reaper, Effect `Scope` teardown, max-TTL), not a
gate. Respect them: bounded concurrent worker Jobs, every Job cleaned up, N=1.

The k8s/Postgres control plane is **live** — the Phase D bootstrap (always-on control plane, Pulumi
state) is **done**: Pulumi state is self-managed on Hetzner S3 (no Pulumi Cloud account needed), and the
old always-on Hetzner main box is gone. Nothing further is blocked on Calum here.

## Repo state snapshot (2026-06-27, pre-migration — superseded)

> Historical: this snapshot predates the k8s + Postgres migration (completed 2026-07-01) and the
> old-box teardown. It describes the sqlite/`BoxMaker`/Hetzner-worker shape that has since been
> replaced — see "What Tidepool is" above and `DESIGN.md §1` for current reality. Kept as history.

Done — Phase A, Phase B, and Phase C implementation complete:
- Docs: `DESIGN.md`, `RESEARCH.md`, `AGENTS.md`+`CLAUDE.md`, `GOALS.md`, `SKILLS.md`, `HANDOFF.md`.
- Stack configs: `package.json` (Effect + Biome + opencode SDK `1.17.11`), `tsconfig.json`,
  `biome.json`, `lefthook.yml`, `commitlint.config.mjs`, `.mise.toml` (bun+opencode pinned).
- `tidepool-testbed` repo exists (`0x63616c/tidepool-testbed`): pure-fn TS lib + vitest + identical
  rails (biome, commitlint, CI, `main` protected). `tp doctor` passes against it.
- **Both repos are now PUBLIC + hardened (2026-06-28):** `tidepool` and `tidepool-testbed` are public,
  `main` protected (required check `check`, linear history, no force-push, no deletions,
  enforce-admins), Actions `GITHUB_TOKEN` read-only, 0 repo secrets.
- `secrets/*.enc.yaml` — sops+age, **one file per secret**, each with its own recipient set
  (`.sops.yaml` is the access-control matrix; recipients: mainbox/ci/breakglass anchors):
  - `hcloud_api_token` — ci + mainbox + breakglass (box provisions workers; future Pulumi-in-CI)
  - `forge_github_token` — mainbox + breakglass (reconciler/Forge; CI uses its native token)
  - `runner_opencode_auth_json` — mainbox + breakglass (AgentRunner subscription cred)
  - `ssh_tidepool_private_key` — mainbox + breakglass (shared fleet SSH identity: box→worker
    AND operator→box; **NOT** worker-specific despite the old `ssh_worker_private_key` name)
- `src/` — full implementation:
  - `domain.ts` — branded ids, typed errors, Ticket/Run schemas (Effect Schema)
  - `config.ts` — Effect Schema Config + `AppConfig` Tag + `loadConfig`
  - `services.ts` — `TicketStore`, `Forge`, `BoxMaker`, `AgentRunner` Tags (interfaces)
  - `ids.ts` — Stripe-style prefixed ids (tckt_/run_/box_/pr_)
  - `reconciler.ts` — state machine (`step`, `settle`) + all ticket transitions
  - `fakes.ts` — `FakeTicketStore`, `FakeForge`, `FakeBoxMaker`, `FakeAgentRunner`
  - `sqlite-store.ts` — `@effect/sql-sqlite-bun` backed `TicketStore` (real)
  - `forge.ts` — GitHub `Forge` via Octokit port + `GithubForgeLive` Layer
  - `agent-runner.ts` — the local opencode runner (`@opencode-ai/sdk`) behind the `AgentWorker`
    seam (`makeOpencodeAgentRunner`). **TEMPORARY hotfix:** force-exits (`process.exit(0)`) after
    push because the embedded opencode server keeps Bun's event loop alive — stop-gap pending the
    Effect runner rewrite, not the intended shape. (The old SSH remote-work path for Hetzner boxes
    was deleted in PR-7.)
  - `doctor.ts` — `runDoctor` / `renderDoctor` / `gatherDoctorFacts` (4 facts: slugify +
    fresh-clone test + non-zero tokens + latest work-run provider = `hetzner`)
  - `runtime.ts` — `LiveStack` Layer (sqlite + config + GitHub + opencode + **HetznerBoxMaker**)
  - `cli.ts` — `tp ls / ticket add / run / doctor`
- All 101 unit tests passing (`bun run check` exits 0).

**Phase C e2e PROVEN (2026-06-28)** (the actual cloud run happened):
- `tp run` provisioned a real Hetzner worker box → opencode ran ON the box → a merged PR on
  `tidepool-testbed@main` → box DELETED (project servers back to baseline).
- `tp doctor` exits 0 AND the run record's latest work-run provider = `hetzner`.

## Secrets / inputs in place

- `~/.tidepool/bootstrap/`: `hcloud_token`, `opencode-auth.json`, age keys (`age-mainbox/-breakglass/
  -ci`), `ssh-tidepool`. Backed up in 1Password (Homelab) item `tidepool`.
- `gh` authed as `0x63616c` (`repo`,`workflow`). Tooling present: bun, opencode 1.17.11, sops, age,
  mise (auto-activates), gh, jq. (Pulumi CLI + Pulumi Cloud token: not yet — Phase D.)

## The mission & milestones

See **`GOALS.md`** — one mission (a PR merged into `tidepool-testbed@main`, generated by opencode on a
real Hetzner worker box, full flow e2e, proven by `tp doctor`), built in phases A (fakes) → B (real
adapters, local) → C (real Hetzner worker = the mission) → D (Pulumi always-on, needs the token).

## Key invariants (full set + 11 tenets in AGENTS.md)

PR not MR (GitHub). Stripe IDs `tckt_/run_/box_/lease_/pr_`. Commit subject leads `#tckt_xxx`. Branch
`tp/<tckt_id>-slug`. Squash-merge, linear history, `main` protected. Gates mechanical via git hooks +
CI. Deep modules, no leaky abstractions. Single source of truth. Design-for-N, run N=1. Box type =
**CPX/x86** (ARM unavailable). Effect-first. Docs track reality.
