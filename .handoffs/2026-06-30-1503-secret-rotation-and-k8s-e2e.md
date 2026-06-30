# Handoff — secret rotation + finish k8s migration e2e

**Date:** 2026-06-30 15:03 · **Branch:** `main` (clean working tree except untracked `.handoffs/*`,
`.claude/*`) · **No open PRs.**

**Next session focus (user-set):** (1) finish **rotating the Hetzner secret**, (2) execute the **full
k8s migration end-to-end** (PR 0→7) — proven deployed on the new infra.

## Read these first (don't duplicate — this doc only adds the session delta)

- **Master plan + all locked decisions + PR 0→7 table:** `.handoffs/2026-06-30-1123-k8s-agentworker-migration.md`
  (heavily updated THIS session: datastore RESOLVED, spike results, cluster layout, PR-0 additions).
- **Durable cross-session facts:** memory `tidepool-workrunner-seam.md`, `calum-prefers-k8s-over-nomad.md`,
  `no-standalone-migration-docs.md`.
- **Repo canon:** `CLAUDE.md`/`AGENTS.md` (tenets/standards), `DESIGN.md` (stale wrt this migration —
  fixed in PR-1), `RESEARCH.md`.

## What happened this session (deltas on top of the 1123 handoff)

1. **Datastore RESOLVED → Postgres via CloudNativePG** (was the open question). Calum signed off crossing
   tenet 1. Full design in the 1123 handoff "RESOLVED — datastore" section + memory. Schema migrations =
   `@effect/sql` PgMigrator on control-plane boot; one-time sqlite→pg = throwaway Effect Job at cutover.
2. **Spike ran (de-risked the unknowns).** **Proof B (opencode agent-worker in a k8s pod) = PASS** — real
   auth+run, `RunnerResult` harvested from stdout, token not burned. **Proof A** = Talos+CSI + CNPG-on-CSI
   + backup→Hetzner-S3 all PASS (no sha256 workaround); only restore-from-S3 unproven (low risk). All spike
   infra torn down, verified clean. Details + PR-5 gotchas (no Talos snapshot exists; user-data machineconfig;
   CCM private-IP wiring; CNPG 1.30 plugin mandatory) in the 1123 handoff "Spike #2 results" section.
3. **🔴 SECRET LEAK + rotation (immediate next-session task).** While inspecting secret structure I ran a
   `sops -d | grep` that printed two **values** into this session's transcript: `hcloud_api_token` (Hetzner
   Cloud API token) and `forge_github_token` (GitHub PAT). **Both must be rotated.** `runner_opencode_auth_json`
   + `ssh_tidepool_private_key` were NOT leaked. Calum is minting a new Hetzner token. Decision pending:
   revoking the OLD tokens breaks the live `tp-main` box until the migration replaces it (tenet: don't touch
   boxes yet) — so likely seal-new-now, revoke-at-cutover, OR rotate the GitHub PAT sooner if broadly scoped.
4. **Secret-leak guardrails added** (`.claude/`, currently local-only — see gitignore note):
   - `.claude/hooks/sops-leak-guard.sh` — **PreToolUse(Bash)**: blocks `sops -d`/`--decrypt` whose output
     reaches stdout/a pipe (allows `-o`/`>`file/`>/dev/null`). Self-tested.
   - `.claude/hooks/age-key-tripwire.sh` — **PostToolUse(Bash|Read)**: **redacts** any `AGE-SECRET-KEY-…`
     in tool output via `hookSpecificOutput.updatedToolOutput` (genuine redaction — confirmed via
     claude-code-guide, docs: https://code.claude.com/docs/en/hooks.md). Self-tested.
   - `.claude/settings.json` wires both (portable `$CLAUDE_PROJECT_DIR` paths).
   - ⚠️ **Not yet live:** `.claude/settings.json` was created mid-session → the hooks watcher won't load
     them until someone opens **`/hooks`** once (or restarts). Do this at session start.

## Immediate TODO (next session, in order)

1. **Activate the hooks:** open `/hooks` (or restart) so the two guards load. Verify they fire.
2. **Rotate Hetzner token:** Calum mints a new Read&Write token in the Hetzner console (Security → API
   Tokens). Re-seal into `secrets/hcloud_api_token.enc.yaml` with a **promptless** script: `read -rsp` the
   value (never to chat/argv), write `hcloud_api_token: <val>` at the exact path so the `.sops.yaml` rule
   applies (recipients ci+mainbox+breakglass), `sops --encrypt --in-place`, verify with
   `sops -d "$DEST" >/dev/null`. (Scratchpad scripts from this session are EPHEMERAL — recreate from this
   recipe.) Then decide revoke-old timing. Same recipe rotates `forge_github_token` (recipients mainbox+breakglass).
3. **S3 creds → sops (PR-6 human prereq):** create `secrets/hetzner_s3_credentials.enc.yaml`. **Shape NOT
   finalized** — repo convention is 1 top-level key == filename; an S3 keypair is one credential → recommend
   one-file JSON blob mirroring `runner_opencode_auth_json` (key `hetzner_s3_credentials`, value = JSON with
   access_key_id + secret_access_key). Endpoint/region/bucket are CONFIG (git, PR-5), not sops. Promptless
   re-seal recipe as above. (Hetzner S3 creds are console-only.)
4. **Execute the migration PR 0→7** per the 1123 handoff table. Critical path 0 → 1 → (2,3 parallel) → 4 →
   5 → 6 → 7. Agent teams: builder + reviewer per PR (named teammates). PR-0 now also carries: AGENTS.md
   secrets-resolution line, commit-this-handoff-then-delete-at-PR-7, narrow the `.gitignore` `.claude/` rule
   + track `.claude/{settings.json,hooks/}`, delete dead drizzle deps. PR-1 = seam reshape + DESIGN delta.

## Gotchas / state notes

- **`.gitignore` ignores all of `.claude/`** (intended only to skip the regenerable skills symlink +
  worktrees). Too broad — it also hides `settings.json`+`hooks/`. PR-0 narrows it to `.claude/skills` +
  `.claude/worktrees/` so the guards become tracked/shared. Until then the guards are local-only (still
  cover this machine's agents).
- **`managing-secrets` skill is referenced but NOT installed on disk** — agents fall back to sops+breakglass
  directly. The keychain key loads promptless: `export SOPS_AGE_KEY="$(security find-generic-password -s
  tidepool-age-breakglass -w)"` (PR #31). Breakglass decrypts ALL secrets locally.
- **Concurrency hazard observed:** two spike agents collided on one Hetzner box this session (orchestration
  error). For the PR-0→7 run, ensure ONE owner per destructive/infra action; never split teardown.
- **Prod box** `tp-main` (IP `<box-ip>`) + volume `tp-state` (the live sqlite DB) are the refuse-list — never
  delete. The migration retires them at PR-6/7.

## Suggested skills (next session)

- `superpowers:using-git-worktrees` — isolate each PR builder.
- `tdd` / `superpowers:test-driven-development` — bugfix/behavior PRs.
- `effect-ts` — every code PR (tenet 10).
- `codebase-design` — PR-1 seam reshape.
- `review` (Standards + Spec) + `superpowers:requesting-code-review`/`receiving-code-review` — per-PR review loop.
- `no-mistakes` — gate each PR before merge.
- `superpowers:dispatching-parallel-agents` — the per-PR teammates.
- `update-config` — if adjusting the leak-guard hooks.
