# Agent skills & references — load before building

Pre-load these so coding agents (opencode + Claude) write idiomatic Effect / TS / Pulumi from line 1.
Installed via Vercel Labs' `skills` CLI (`npx skills add <owner/repo>`, registry at skills.sh) into
`.agents/skills/`. All verified to exist 2026-06-27.

## Install now

```bash
# Effect — official skill (canonical; covers Layers/DI, Schema, @effect/sql, observability, @effect/vitest)
#   NOTE: expects a vendored Effect checkout at ./.repos/effect — read its README first.
npx skills add Effect-TS/skills -a opencode -a claude-code

# Effect — community, self-contained, version-aware (v3 prod + v4 migration). Belt-and-suspenders with the above.
npx skills add teeverc/effect-ts --skill effect-ts -a opencode -a claude-code

# Modern TypeScript — Matt Pocock's pack (TDD, DDD, clean architecture; tops skills.sh, maintained)
npx skills add mattpocock/skills -a opencode -a claude-code

# AXI — agent-ergonomic CLI design (for `tp`)
npx skills add kunchenguid/axi -a opencode -a claude-code
```

Cherry-pick / vet with `npx skills add <repo> --list` and `npx skills find <kw>`. Manage with
`npx skills list|update|remove`. (Snyk scans on install.)

## Reference via MCP / llms.txt (not SKILL.md installs)

- **Pulumi MCP server (official)** — highest-value infra resource; queries the registry live so the
  agent gets exact `pulumi-hcloud` (Hetzner) schemas + type-safe TS:
  ```bash
  claude mcp add --transport http pulumi https://mcp.ai.pulumi.com/mcp   # remote (OAuth)
  # or local: claude mcp add -s user pulumi -- npx @pulumi/mcp-server@latest stdio
  ```
  For opencode, add the same HTTP endpoint as an MCP server in its config.
- **Pulumi llms.txt:** https://www.pulumi.com/llms.txt (has a "For agents" section).
- **Total TypeScript cursor rules** (type-level strictness): https://www.totaltypescript.com/cursor-rules-for-better-ai-development — copy into AGENTS.md.

## Gaps (no trustworthy dedicated skill found — use a short AGENTS.md note instead)

Bun, Biome, vitest, SQLite, OpenTelemetry. The official Effect skill already covers observability +
`@effect/sql`. Effect's own `effect.website/llms.txt` is **404 today** (site mid-migration) — rely on
`Effect-TS/skills`, not the llms.txt URL.
