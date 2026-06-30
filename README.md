# Tidepool 🦀

> An agentic-coding control plane. A pool where small crab-agents come and go.

A thin always-on box runs a reconciler loop + ticket backlog. When tickets exist it spins ephemeral
worker boxes that drive coding agents (via the opencode SDK, on your Codex subscription) against a
target repo: `branch → PR → review → auto-merge-on-green`. Infra is declarative (Pulumi in CI),
secrets are sops+age, and you drive it with the `tp` CLI.

- **Design & decisions:** [`DESIGN.md`](./DESIGN.md)
- **Researched facts, versions, API patterns:** [`RESEARCH.md`](./RESEARCH.md)
- **Agent + human working rules:** [`AGENTS.md`](./AGENTS.md)

## Status

Scaffolding. Design locked. v1 target: a working **N=1** loop against `tidepool-testbed`.

## Layout

```
src/            cli, reconciler, runner, interfaces, store   (TypeScript + Bun)
tickets/        git-backed backlog (markdown, frontmatter)
infra/          Pulumi (main box, firewall) + Hetzner-API workers + bootstrap
secrets/        sops+age encrypted secrets, one file per secret (steady state)
.github/        CI rails (prettier, typecheck, commitlint, vitest)
```

## Quick start (dev)

```bash
brew install gitleaks # pre-commit leak scanner (lefthook hook prerequisite)
bun install
bun run check        # prettier + typecheck + commitlint + test
```
