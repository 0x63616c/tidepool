# Handover — investigate the secret-leak guardrail failure (run in a SEPARATE worker)

**Status:** parked until the k8s migration (PR 0→7, see `GOAL-k8s-migration.md`) is done. Pick this up
in your own worker/session, fan out with subagents. Do NOT block the migration on it.

## The incident
During PR-0, the `pr0-builder` subagent ran `echo "$SOPS_AGE_KEY"` and printed the **breakglass age
private key** (`AGE-SECRET-KEY-…`) into its transcript. Breakglass is the recipient of **every** secret
in `secrets/*.enc.yaml`, so **treat ALL secrets + ALL three age keys (breakglass/mainbox/ci) as
compromised** — full rotation required (see runbook below).

## Why the guardrails didn't stop it (EVIDENCE-BASED — verified this session, fresh session, hooks loaded)
- **PreToolUse `sops-leak-guard.sh` = WORKS.** Empirically blocked `sops -d <file>` to stdout this
  session. BUT it only covers sops-decrypt patterns — a bare `echo "$SOPS_AGE_KEY"` is NOT in scope, so
  it never had a chance to block this leak.
- **PostToolUse `age-key-tripwire.sh` = FIRES, BUT REDACTION WAS THE WRONG SHAPE. ROOT CAUSE FOUND.**
  The hook emits `updatedToolOutput` as a plain **string** — and for BUILT-IN tools (Bash/Read) a
  string is **silently ignored** (string form is MCP-only). It MUST be a **structured object mirroring
  the tool's own result shape** — Bash: `{stdout,stderr,interrupted,isImage}`, Read: its own shape.
  That's why the fake canary sailed through un-redacted. Verified empirically (CC 2.1.197 /
  claude-opus-4-8); now in Calum's global `~/.claude/CLAUDE.md`. **The redaction approach IS viable** —
  do NOT abandon it for PreToolUse-only. THE FIX: rewrite the hook to walk the original `.tool_response`,
  mask `AGE-SECRET-KEY-…` in every string in place, and re-emit the SAME object shape as
  `updatedToolOutput`. (Settings were loaded fine — PreToolUse fired; the "mid-session load" theory was
  wrong.)

## What to investigate (fan out subagents)
1. **FIX the tripwire redaction (root cause known):** rewrite `age-key-tripwire.sh` to emit
   `updatedToolOutput` as a STRUCTURED OBJECT mirroring the tool result (walk `.tool_response`, mask
   every string in place, re-emit same shape) — NOT a plain string. Then VERIFY empirically with a fake
   canary in BOTH the main session AND a subagent (confirm the model sees `[REDACTED-AGE-KEY]`).
2. **ALSO add a PreToolUse BLOCK as defense-in-depth** (redaction is post-hoc; blocking is pre-emptive):
   a PreToolUse Bash hook that BLOCKS any command that would print a secret — references a known secret
   env var (`SOPS_AGE_KEY`, etc.) or `echo`/`printf`/`cat`/`printenv` of secret-shaped material. Belt
   AND braces: block the obvious vectors, redact anything that slips through.
3. **Broaden `sops-leak-guard.sh`** (reviewer finding #1): its detect anchor omits `(` and backtick, so
   `echo $(sops -d f)` / `` `sops -d f` `` evade it. Add `(` + backtick to the anchor class.
4. **Verify subagent coverage empirically** — spawn a subagent, echo a fake canary, confirm the new
   PreToolUse block fires there (not just main session).
5. Consider stripping secret env vars (e.g. `SOPS_AGE_KEY`) from subagent environments entirely if they
   don't need them — defense in depth (no key in env ⇒ can't echo it).

## Rotation runbook (AFTER migration — everything is compromised)
1. Rotate all 3 age keys: `age-keygen` new breakglass + mainbox + ci. Store offline + keychain
   (`tidepool-age-breakglass` etc.) + 1Password backup. Master keys never leave their box (tenet 9).
2. Update `.sops.yaml`: replace all three recipient PUBLIC keys; also apply the deferred PR-0 item #6
   (catch-all `creation_rule` → breakglass-only).
3. `sops updatekeys secrets/*.enc.yaml` to re-encrypt to the new recipient set; verify each decrypts
   (`sops -d <f> >/dev/null`, never pipe to stdout).
4. Rotate every secret VALUE (all were decryptable by the leaked breakglass): `hcloud_api_token`
   (re-rotate — was rotated once this session but compromised again), `forge_github_token`,
   `runner_opencode_auth_json`, `ssh_tidepool_private_key`, `hetzner_s3_credentials`. Use the promptless
   re-seal recipe (read -rsp, never to argv/chat). Also commit the currently-uncommitted working-tree
   `secrets/hcloud_api_token.enc.yaml` + untracked `secrets/hetzner_s3_credentials.enc.yaml`.
5. Ship via PR (GitOps); editing `secrets/**` needs a ticket that explicitly scopes it.

## Interim mitigation during the migration (already in place)
- Every builder/reviewer prompt is hard-constrained: never echo env / print secret-shaped values, never
  `sops -d` to stdout. PreToolUse leak-guard still blocks sops-decrypt. Since everything is being rotated
  post-migration anyway, a repeat leak of an already-compromised secret doesn't widen the blast radius.
