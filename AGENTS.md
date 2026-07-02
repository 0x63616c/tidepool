# AGENTS.md — Tidepool

> Canonical instructions for **every** agent (opencode, codex) and human working in this repo.
> `CLAUDE.md` is a symlink to this file. One source of truth.

## What this repo is

Tidepool: an agentic-coding control plane. See `DESIGN.md` for the full design and `RESEARCH.md`
for the researched facts/versions. Read `DESIGN.md` before making non-trivial changes.

## Local vs remote dev

Two execution contexts share this repo; worktree lifecycle is owned differently in each.

- **Remote (the tidepool worker).** The reconciler dispatches an opencode runner that clones the
  target repo, works its own `tp/<tckt_id>-<slug>` worktree/box, and opens the PR. Isolation is
  handled by the worker — you do nothing. The `.claude/` hooks below never run here (opencode is
  the runner, not Claude Code), and they self-disable in-cluster anyway (`KUBERNETES_SERVICE_HOST`).
- **Local (Claude Code on the laptop).** Three `.claude/` hooks enforce the same isolation locally:
  - `main-guard.sh` (PreToolUse) blocks `git commit`/`merge`/`push` while `HEAD == main`, pushing
    you into a worktree. Run `EnterWorktree` (name it `calum/<slug>`) → native branch
    `worktree-calum+<slug>`; commit there.
  - `worktree-gc.sh` (SessionStart) removes clean `worktree-*` worktrees under `.claude/worktrees/`
    once merged to `main` or their upstream branch is gone (squash-merge). Dirty/unpushed/other
    trees are always kept.
  - The lefthook `no-main-commit` gate is the universal backstop (see Local quality gates).

  **Local branches are `worktree-*`; remote branches are `tp/*`.** That prefix is the local/remote
  tell. Merges to `main` happen via PR only, never locally.

## Golden rules

1. **Every change ships as a green, merged PR.** That is the definition of done — it is a system
   invariant, never something you state in a ticket's acceptance criteria. No direct pushes to `main`.
2. **Follow the standards below mechanically.** CI + git hooks enforce them; the review agent grades
   against them. If a hook/CI fails, fix the code — do not bypass.
3. **No leaky abstractions.** `AgentWorker`, `Forge`, `TicketStore`, `CredentialBroker`
   are deep modules: narrow front, implementation fully hidden. Never let k8s/GitHub/opencode
   types leak across an interface boundary.
4. **A ticket's `body` defines acceptance.** The body is structured markdown (`# Context`,
   `# Acceptance Criteria`, `# Relevant Files`, `# Approach`, `# Out of Scope`); the review agent
   grades the diff against its `# Acceptance Criteria` section + CI status. Other sections are
   context/pointers and may be stale — the work agent verifies them against current code.

## Tenets (changes that touch these need a human)

Load-bearing philosophies. **Small, local architecture changes within them are fine — make them.**
Any change that **crosses or weakens a tenet requires explicit human approval**: stop, flag it in
one line, do not implement it.

1. **Single source of truth.** Each datum lives in exactly one store — config in git, secrets in
   sops, runtime state (tickets/transcripts/usage) in Postgres (CloudNativePG). Never split state
   across stores. (Human-approved crossing: runtime state moved sqlite→Postgres for an HA seam; the
   single-source invariant is unchanged.)
2. **GitOps flow.** The system's *definition* (infra, config, code) is declarative, PR-reviewed,
   CI-applied — never hand-mutated on the box. (Runtime *data* like tickets is state, not definition,
   so it lives in sqlite, not git — consistent, not a violation.)
3. **Reconciler is the only mover.** All ticket state transitions go through the reconcile loop over
   durable state. No side-channel mutations.
4. **Deep modules, no leaky abstractions.** Narrow fronts, hidden impls; adapters swappable.
5. **Mechanical quality gates.** Enforcement via git hooks + CI, never vibes; same config local + CI.
6. **Tiered autonomy by blast radius.** Trust ∝ cost-of-being-wrong; risky paths gated + human-laned.
7. **Design for N, run minimal.** Build seams for scale; run the smallest safe config; no system
   before it's needed.
8. **Evidence before claims.** Prove via a checkable terminal state, not assertion.
9. **Least privilege / secrets stay home.** Box is outbound-only (no public inbound); master keys
   never leave the cluster / control plane; personal/internal scale only.
10. **One way of doing things.** One idiom, not a mix — **Effect** for all effects/errors/DI (never a
    raw-promise + Effect mashup), `@effect/schema` for validation (not zod alongside it), one HTTP
    layer (`@effect/platform`), one SQL layer (`@effect/sql`). Consistency beats local cleverness; if
    a second way creeps in, converge it.
11. **Docs track reality.** When you change the system, update the docs that describe it (DESIGN/
    HANDOFF/AGENTS/GOALS) in the same change. No stale or contradictory docs left behind.
12. **Test-driven — red before green.** Every behavior change is specified by a test written FIRST
    that fails before the code exists and passes after. A test that never failed is not evidence
    (tenet 8) — no behavior ships on a test written after the fact. Pure refactors keep the existing
    suite green (no behavior change ⇒ no new test); infra/deletion/docs prove themselves via their
    own checkable terminal state. The reviewer confirms each new test genuinely fails without its
    impl, not merely that it's green.

Examples needing approval: a second source of truth, bypassing GitOps/CI, an always-on service,
leaking an impl across a seam, removing/loosening a gate, widening autonomy, a public inbound port,
a secret outside sops.

## Standards (enforced)

- **Naming:** one mechanical standard for resources, code, and labels — see `NAMING.md`. Bare inside
  a tidepool-only scope, `tp` = CLI only, peers share one label schema, name by layer (machine vs
  workload). New resource? Copy the pattern in `NAMING.md`.
- **Language/runtime:** TypeScript + Bun. One language across cli, reconciler, runner.
- **IDs:** Stripe-style prefixed — `tckt_`, `run_`, `box_`, `pr_` + short lowercase base36
  suffix (`[0-9a-z]`), so ids satisfy their own commitlint/branch gate `tckt_[0-9a-z]+`.
- **Branches:** remote worker → `tp/<tckt_id>-<short-slug>` (e.g. `tp/tckt_a1b2c3-add-slugify`);
  local Claude Code → `worktree-<slug>` (native `EnterWorktree`, e.g. `worktree-calum+add-slugify`).
  Never commit on `main` (enforced locally by the lefthook `no-main-commit` gate + `main-guard.sh`).
- **Commits:** subject **leads with the ticket**, then Conventional Commits:
  `#tckt_a1b2c3 feat(scope): subject`. Body optional. Footer: `Ticket: tckt_a1b2c3`.
- **PR titles:** conventional + ticket id → `feat(reconciler): add claim loop (tckt_a1b2c3)`.
- **Formatting/lint:** Biome for TS/JSON (`bun run format`); shfmt + shellcheck for bash
  (`bun run lint:sh`). **Types:** `tsc --noEmit` (`bun run typecheck`) must pass.
- **Tests:** Vitest via Bun (`@effect/vitest`). New behavior needs a test. **Commits:** commitlint.
  **Git hooks:** Lefthook (pre-commit + pre-push; CI mirrors — same config local + CI).
- **Effect everywhere (tenet 10), incl HTTP:** all I/O goes through Effect; HTTP uses the one layer
  `@effect/platform` (`HttpClient`) — never raw `fetch`.

## Local quality gates (same as CI)

Run before pushing — git hooks run these automatically, CI re-runs them (never trust local):

```bash
bun run check     # biome + lint:sh (shellcheck/shfmt) + typecheck + test
```

The `no-main-commit` pre-commit gate fails any commit on `main` (human, CLI, or agent) — work on a
worktree branch. Escape hatch for the rare legitimate case: `LEFTHOOK=0 git commit ...`.

## Secrets

sops + age, one file per secret (`secrets/*.enc.yaml`); 1Password is backup-only. Local: `.envrc` caches the break-glass key in the macOS keychain → `SOPS_AGE_KEY`. Detail: `DESIGN.md`. **Who can decrypt each secret is defined once, in `.sops.yaml`'s creation rules** (the access-control matrix) — the `ci` recipient is intentionally minimal; it was widened to `forge_github_token` + `runner_opencode_auth_json` in PR-6.5 (human-approved) so `pulumi up` can seed the control-plane k8s Secret.

Resolve a credential via sops before concluding it's absent — don't infer absence from a filesystem search (a missing `~/.ssh` file ≠ no key; check `secrets/*.enc.yaml`).

**Leak guard** (`.claude/hooks/`, bash 3.2-safe): PostToolUse `secret-redactor` masks secret shapes + our exact sealed values (`.claude/redaction-hashes.json`, regenerated by `bun run seal:hashes` on any secret change, entropy-gated ≥80 bits, drift-checked at pre-push) in tool output before the model sees it. Age keys are X25519 (not post-quantum) — see `DESIGN.md`.

**Adding/rotating a secret?** Run `bun run seal:hashes`. If it introduces a new secret *shape*, add it to `secret-redactor.sh` and cover it in `src/secret-hooks.test.ts`.

## Do / Don't

- DO be concise everywhere — docs included.
- DO keep interfaces narrow and implementations swappable.
- DO write the test first for any behavior change (tenet 12) — reproduce/spec, then implement.
- DON'T edit `secrets/**` or `.github/workflows/**` unless the ticket explicitly says so
  (these are security-sensitive; protected once self-bootstrap is live).
- DON'T add dependencies casually; prefer the standard lib / existing deps.
- DON'T surface a secret value (sops or `op`) in chat — decrypt only piped into a derive tool that prints public/hash output.
