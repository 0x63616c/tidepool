# AGENTS.md — Tidepool

> Canonical instructions for **every** agent (opencode, codex) and human working in this repo.
> `CLAUDE.md` is a symlink to this file. One source of truth.

## What this repo is

Tidepool: an agentic-coding control plane. See `DESIGN.md` for the full design and `RESEARCH.md`
for the researched facts/versions. Read `DESIGN.md` before making non-trivial changes.

## Golden rules

1. **Every change ships as a green, merged PR.** That is the definition of done — it is a system
   invariant, never something you state in a ticket goal. No direct pushes to `main`.
2. **Follow the standards below mechanically.** CI + git hooks enforce them; the review agent grades
   against them. If a hook/CI fails, fix the code — do not bypass.
3. **No leaky abstractions.** `BoxMaker`, `Forge`, `TicketStore`, `AgentRunner`, `CredentialBroker`
   are deep modules: narrow front, implementation fully hidden. Never let Hetzner/GitHub/opencode
   types leak across an interface boundary.
4. **A ticket's `goal` defines acceptance.** Work toward it; the review agent checks the diff against
   it + CI status.

## Tenets (changes that touch these need a human)

Load-bearing philosophies. **Small, local architecture changes within them are fine — make them.**
Any change that **crosses or weakens a tenet requires explicit human approval**: stop, flag it in
one line, do not implement it.

1. **Single source of truth.** Each datum lives in exactly one store — config in git, secrets in
   sops, runtime state (tickets/transcripts/usage) in sqlite. Never split state across stores.
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
   never leave the main box; personal/internal scale only.

Examples needing approval: a second source of truth, bypassing GitOps/CI, an always-on service,
leaking an impl across a seam, removing/loosening a gate, widening autonomy, a public inbound port,
a secret outside sops.

## Standards (enforced)

- **Language/runtime:** TypeScript + Bun. One language across cli, reconciler, runner.
- **IDs:** Stripe-style prefixed — `tckt_`, `run_`, `box_`, `lease_`, `pr_` + short base62 suffix.
- **Branches:** `tp/<tckt_id>-<short-slug>` (e.g. `tp/tckt_a1b2c3-add-slugify`).
- **Commits:** subject **leads with the ticket**, then Conventional Commits:
  `#tckt_a1b2c3 feat(scope): subject`. Body optional. Footer: `Ticket: tckt_a1b2c3`.
- **PR titles:** conventional + ticket id → `feat(reconciler): add claim loop (tckt_a1b2c3)`.
- **Formatting:** Prettier (`bun run format`). **Types:** `bun run typecheck` must pass.
- **Tests:** vitest. New behavior needs a test. **Lint commits:** commitlint.

## Local quality gates (same as CI)

Run before pushing — git hooks run these automatically, CI re-runs them (never trust local):

```bash
bun run check     # prettier --check + typecheck + commitlint (last commit) + test
```

## Do / Don't

- DO keep interfaces narrow and implementations swappable.
- DO write the test first for bugfixes (reproduce, then fix).
- DON'T edit `secrets/**` or `.github/workflows/**` unless the ticket explicitly says so
  (these are security-sensitive; protected once self-bootstrap is live).
- DON'T add dependencies casually; prefer the standard lib / existing deps.
