# HANDOFF — start here

> Read order: **this file → `GOALS.md` → `DESIGN.md` → `RESEARCH.md` → `AGENTS.md` → `SKILLS.md`.**
> The design is LOCKED (DESIGN.md, from a long grilling session 2026-06-27). Your job is execution,
> not re-deciding. If a locked decision looks wrong, raise it with Calum in one line — don't silently
> diverge. **`GOALS.md` is the mission.**

## What Tidepool is (10-second version)

A personal agentic-coding control plane. A thin always-on Hetzner box runs a TS+Bun reconciler loop +
a **sqlite ticket store** (single source of truth). Tickets spin ephemeral Hetzner workers that drive
coding agents (opencode SDK, on Calum's Codex subscription) against a target repo: `branch → PR →
review → auto-merge-on-green`. Declarative infra (Pulumi in CI), secrets sops+age, driven by `tp`.
Full rationale in `DESIGN.md`.

## How you (the lead) operate this project

Calum talks to you like a **senior manager to a lead** — high-level, low direct context. You do the
work by **dispatching parallel agent teams + validators** (Workflow tool, Opus), not by grinding inline.
- **Work backward from a terminal check** (GOALS.md defines them). Never take "implement X" raw.
- **Dispatch, don't grind.** Keep your context lean; summarize up, don't dump transcripts.
- **Evidence before claims.** "Done" = the terminal check passed and you saw the output.
- **Tiered autonomy by blast radius** (DESIGN §4.5): testbed = full auto / cheap model (`gpt-5.4-mini`).
- **Effect-first, one way of doing things** (tenet 10). **Update docs in the same change** (tenet 11).

## Spend is authorized

Calum authorized real spend — **no permission needed** for `pulumi up` / Hetzner boxes. The controls
are the **guardrails** (5-box project limit, reaper, Effect `Scope` teardown, max-TTL), not a gate.
Respect them: ≤5 boxes, every box deleted, N=1.

The ONLY thing still needing Calum: a **Pulumi Cloud account + access token** (Phase D, the always-on
main box). Not required for the mission — workers are Hetzner-API cattle; the reconciler can run
locally to drive the Phase C cloud-worker run.

## Current repo state (2026-06-27)

Done — Phase A, Phase B, and Phase C implementation complete:
- Docs: `DESIGN.md`, `RESEARCH.md`, `AGENTS.md`+`CLAUDE.md`, `GOALS.md`, `SKILLS.md`, `HANDOFF.md`.
- Stack configs: `package.json` (Effect + Biome + opencode SDK `1.17.11`), `tsconfig.json`,
  `biome.json`, `lefthook.yml`, `commitlint.config.mjs`, `.mise.toml` (bun+opencode pinned).
- `tidepool-testbed` repo exists (`0x63616c/tidepool-testbed`): pure-fn TS lib + vitest + identical
  rails (biome, commitlint, CI, `main` protected). `tp doctor` passes against it.
- `secrets/tidepool.enc.yaml` — sops-encrypted (3 age recipients: mainbox/ci/breakglass).
  Contains: `hcloud_token`, `github_token`, `opencode_auth_json`, `ssh_worker_private_key`.
- `src/` — full implementation:
  - `domain.ts` — branded ids, typed errors, Ticket/Run schemas (Effect Schema)
  - `config.ts` — Effect Schema Config + `AppConfig` Tag + `loadConfig`
  - `services.ts` — `TicketStore`, `Forge`, `BoxMaker`, `AgentRunner` Tags (interfaces)
  - `ids.ts` — Stripe-style prefixed ids (tckt_/run_/box_/lease_/pr_)
  - `reconciler.ts` — state machine (`step`, `settle`) + all ticket transitions
  - `fakes.ts` — `FakeTicketStore`, `FakeForge`, `FakeBoxMaker`, `FakeAgentRunner`
  - `sqlite-store.ts` — `@effect/sql-sqlite-bun` backed `TicketStore` (real)
  - `forge.ts` — GitHub `Forge` via Octokit port + `GithubForgeLive` Layer
  - `agent-runner.ts` — opencode `AgentRunner` (`@opencode-ai/sdk`) + SSH remote runner for
    Hetzner workers + `OpencodeAgentRunnerLive`. Routes on `box.ip !== '127.0.0.1'`.
  - `hetzner-box.ts` — `HetznerBoxMaker`: Hetzner API, `acquireRelease`, reaper, type/location
    fallback, cloud-init (bun + opencode binary + sentinel `/tmp/.tp-ready`), `HetznerBoxMakerLive`
  - `local-box.ts` — `LocalBoxMaker` (degenerate localhost lease, kept for Phase B fallback)
  - `doctor.ts` — `runDoctor` / `renderDoctor` / `gatherDoctorFacts` (4 facts: slugify +
    fresh-clone test + non-zero tokens + non-null `box_id`)
  - `runtime.ts` — `LiveStack` Layer (sqlite + config + GitHub + opencode + **HetznerBoxMaker**)
  - `cli.ts` — `tp ls / ticket add / run / doctor`
- All 101 unit tests passing (`bun run check` exits 0).

**Phase C e2e still pending** (the actual cloud run):
- Run `tp run` → provisions real Hetzner cpx22 worker → agent runs ON box → PR merged → box deleted.
- `tp doctor` exits 0 AND shows non-null `box_id` in run record.

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
