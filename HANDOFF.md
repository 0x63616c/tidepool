# HANDOFF — start here

> Read order: **this file → `DESIGN.md` → `RESEARCH.md` → `AGENTS.md`.**
> This is the orientation + operating model + roadmap for the session that *builds* Tidepool.
> The design is locked (captured in DESIGN.md from a long grilling session on 2026-06-27). Your job
> is execution, not re-deciding. If you think a locked decision is wrong, raise it with Calum in one
> line — don't silently diverge.

## What Tidepool is (10-second version)

A personal agentic-coding control plane. Thin always-on Hetzner box runs a TS+Bun reconciler loop +
a **sqlite ticket store** (single source of truth). Tickets spin ephemeral Hetzner workers that drive coding agents
(opencode SDK, on Calum's Codex subscription) against a target repo: `branch → PR → review →
auto-merge-on-green`. Declarative infra (OpenTofu in CI), secrets sops+age, driven by the `tp` CLI.
Full shape + every decision and its rationale is in `DESIGN.md`.

## How you (the lead) should operate THIS project

Calum wants to talk to you like a **senior manager talks to a lead** — high-level, low direct context.
You keep the conversation with him short; you do the heavy lifting by **dispatching agent teams and
validators**, not by grinding everything inline.

- **Work backward from a terminal check.** Never take "go implement X" raw. For each milestone there
  is a single checkable end-state that implies everything upstream worked (see Validation below).
  Define it, then dispatch toward it.
- **Dispatch, don't grind.** Use the `Workflow` tool / subagents for parallel build + validation.
  Keep your own context lean — summarize results up to Calum, don't dump transcripts.
- **Report concisely.** Status to Calum = what's done (with the terminal check that proves it),
  what's blocked, what needs his decision. One screen, not ten.
- **Respect tiered autonomy by blast radius** (DESIGN §4.5): testbed = full auto / cheap models;
  real repos = gated + strong models + human lane for risky paths.
- **Evidence before claims.** "Done" means the terminal check passed and you saw the output.

## Current repo state (2026-06-27)

Built (docs + skeleton):
- `DESIGN.md` — all locked decisions + rationale. **Source of truth.**
- `RESEARCH.md` — full research dossier (go/no-go table, pinned versions, exact API patterns).
- `AGENTS.md` (+ `CLAUDE.md` symlink) — standards every agent/human follows.
- `README.md`, `.gitignore`, `package.json` (bun, opencode SDK pinned `1.17.11`), `tsconfig.json`,
  `.prettierrc.json`.
- `tickets/` — backlog: 3 seed tickets targeting `tidepool-testbed` (`tckt_001` slugify is the
  terminal-check function).
- `infra/bootstrap/collect.sh` — ran; bootstrap creds/keys collected (see Secrets below).

NOT built yet (this is your M1–M2 work):
- `src/` is empty — no interfaces, types, config loader, cli, reconciler, fakes, store yet.
- No commitlint config, husky hooks, CI workflow, AXI skill install.
- No real adapters (Hetzner/GitHub/opencode), no tofu module, no sops secrets file.

## Blocked on Calum (do NOT do these without his explicit go)

1. **Provisioning real infra** (Hetzner spend) — needs his go. Everything through M4 is free/local.
2. **Applying secrets** into sops + GitHub Actions secrets — security-sensitive; prepare the code,
   apply on his go.
3. **The cap>1 strategy** (credential broker vs N accounts vs API-key burst) — parked; v1 is N=1.
4. **Object Storage state backend** keys — deferred; settle when provisioning.
5. **Dedicated GitHub identity** (bot/App) — later; v0 uses his `0x63616c` account.

## Secrets / inputs already in place

- Bootstrap dir `~/.tidepool/bootstrap/`: `hcloud_token`, `opencode-auth.json`, age keys
  (`age-mainbox`, `age-breakglass`, `age-ci`), `ssh-tidepool`. (Public keys recorded in DESIGN/1Password.)
- 1Password (Homelab vault) item **`tidepool`** = offline backup of all the above.
- `gh` authed as `0x63616c` (scopes `repo`, `workflow`).
- Local tooling present: bun, node, opencode 1.17.11, sops, age, terraform (NOT tofu yet), gh, jq.

## Roadmap — milestones, each with a terminal check

- **M1 — scaffold + rails.** Finish `src/` (deep-module interfaces `BoxMaker`/`CredentialBroker`/
  `AgentRunner`/`Forge`/`TicketStore`, `types.ts`, `config.ts` zod loader, `tidepool.config.ts`,
  `cli.ts` AXI-style), commitlint (ticket-prefix convention from AGENTS.md), husky hooks, CI workflow,
  `npx skills add kunchenguid/axi`. **Terminal check:** `bun install && bun run check` green.
- **M2 — fakes + reconciler + tests (the loop-logic proof).** `Fake{BoxMaker,Forge,AgentRunner}` +
  in-memory `TicketStore`; reconciler state machine (claim → run → review → merge-on-green → done;
  failure → requeue with bounded attempts; reattach handles + restart). **Terminal check:** reconciler
  vitest suite green, including a "deploy mid-task → reattach → resume" test.
- **M3 — `tp` CLI against in-memory store.** `tp ticket add|ls`, `tp run logs`. **Terminal check:**
  `tp ticket add` then `tp ticket ls` shows it grouped by state.
- **M4 — `tidepool-testbed` repo.** Scaffold the pure-fn TS lib + vitest + identical rails + AGENTS.md;
  push (private). **Terminal check:** testbed CI green on a hand-made PR.
- **M5 — real adapters (NEEDS CALUM GO + SPEND).** Hetzner `BoxMaker`, GitHub `Forge`, opencode
  `AgentRunner` (+ API-key fallback + auth health-check), sops secrets, tofu main-box module, cloud-init,
  systemd self-update. **Terminal check:** `tp doctor` = `slugify` on `tidepool-testbed@main` + test
  passes + sqlite `usage` row non-zero (proves the whole real chain end-to-end).

## Validation strategy (how you prove it works)

Two terminal checks, per DESIGN §4.6:
- **Free/today:** reconciler suite green (M2) ⇒ state machine + resumability proven, no infra.
- **Real:** `tp doctor` (M5) ⇒ the one assertion that implies the entire real pipeline (non-zero
  tokens proves opencode actually ran on the live subscription, not a fake).

## Key invariants (full set in AGENTS.md)

PR not MR (forge = GitHub). Stripe IDs `tckt_/run_/box_/lease_/pr_`. Commit subject leads with
`#tckt_xxx `. Branch `tp/<tckt_id>-slug`. Squash-merge, linear history, `main` protected. Quality gates
mechanical via git hooks + CI (never trust local). Deep modules, no leaky abstractions. Design-for-N,
run N=1.
