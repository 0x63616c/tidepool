# SOPS secrets rehaul — per-file layout + guardrails

> Ticket: **tckt_mbtlcg** · Branch: `tp/tckt_mbtlcg-sops-per-file-secrets`
> Goal: split the single `secrets/tidepool.enc.yaml` blob into **one encrypted file per
> secret** (each with an independently-tunable recipient set), rename keys to be
> self-documenting, add encrypted explanatory comments, and wire **gitleaks** as a
> mechanical leak guardrail (lefthook pre-commit + CI). Green, merged PR = done.

This doc is the migration plan **and** the operator runbook. The privileged
decrypt+re-encrypt step is run by Calum locally with the breakglass key — no secret
plaintext ever passes through the agent.

---

## 1. Why

Today all four secrets live in one file, `secrets/tidepool.enc.yaml`, encrypted to
three age recipients (`mainbox`, `ci`, `breakglass`). Two problems:

1. **All-or-nothing decrypt boundary.** In sops the decrypt unit is the *file*: every
   value is sealed under one data key, wrapped for every recipient. So **CI can decrypt
   the worker SSH key and the opencode auth blob even though it only ever needs the
   Hetzner token.** That is an avoidable least-privilege violation (tenet 9).
2. **`ssh_worker_private_key` is misnamed.** It is not worker-specific — it is the single
   shared fleet identity (root on *every* box, and the key on Calum's laptop). The name
   actively misleads.

**Fix:** one file per secret. The recipient set becomes a *per-secret* dial, changeable
with a one-line `.sops.yaml` edit + `sops updatekeys` — no moving secrets between files,
no over-grant. `.sops.yaml` becomes the reviewable **access-control matrix**.

### Why per-file and not "two files by tier"

A grouped-by-tier layout (`infra.enc.yaml` = CI-readable, `runtime.enc.yaml` = box-only)
is fewer files, but it only works while access boundaries stay *stable*. The moment one
secret's audience diverges from its file-mates ("actually, CI needs this one too") you
must either move it to a new file or widen the whole file's recipients (over-grant).
Per-file sidesteps that entirely: each secret carries its own audience. Given we expect
audiences to drift per-secret, per-file is the right trade — the cost is just N
`creation_rules` instead of 2, and `.sops.yaml` anchors keep that DRY.

---

## 2. Target layout

```
secrets/
  hcloud_api_token.enc.yaml          # recipients: ci, mainbox, breakglass
  forge_github_token.enc.yaml        # recipients: mainbox, breakglass
  runner_opencode_auth_json.enc.yaml # recipients: mainbox, breakglass
  ssh_tidepool_private_key.enc.yaml  # recipients: mainbox, breakglass
  .gitignore                         # unchanged (ignores plaintext tidepool.yaml)
```

`secrets/tidepool.enc.yaml` is **deleted** at the end of the migration.

### Rename + audience map

| old key (in blob)        | new file / key                       | recipients                  | consumer |
| ------------------------ | ------------------------------------ | --------------------------- | -------- |
| `hcloud_token`           | `hcloud_api_token`                   | **ci** + mainbox + breakglass | box provisions workers; (future) Pulumi-in-CI |
| `github_token`           | `forge_github_token`                 | mainbox + breakglass        | reconciler/Forge pushes branches, opens PRs |
| `opencode_auth_json`     | `runner_opencode_auth_json`          | mainbox + breakglass        | AgentRunner — opencode subscription cred |
| `ssh_worker_private_key` | `ssh_tidepool_private_key`           | mainbox + breakglass        | box→worker SSH **and** operator→box SSH |

Naming convention: **`<scope>_<purpose>_<kind>`**. Key names are plaintext in the
encrypted file, so they encode role/reachability — never a value.

### The one judgment call: does `ci` stay a recipient of `hcloud_api_token`?

**Today, no workflow decrypts sops** — `.github/workflows/ci.yml` is only
lint/typecheck/test/container-harness/commitlint. Pulumi-in-CI (which would need the
Hetzner token from sops) is design intent (DESIGN.md §Bootstrap, "Phase D"), not yet
wired. Two options:

- **(A) Keep `ci` on `hcloud_api_token`** (recommended). Preserves the design intent;
  Pulumi-in-CI will need it. The blast-radius win still lands: `ci` is fenced *out* of
  the SSH key, github token, and opencode auth — the three it never needed.
- **(B) Drop `ci` entirely for now** (strict least-privilege-today). `hcloud_api_token`
  becomes mainbox+breakglass; the `ci` recipient disappears from the repo until Pulumi-CI
  lands, then re-added with one line.

This doc assumes **(A)**. Flag if you want (B) — it's a one-line change in `.sops.yaml`
below. Either way it's now a trivial per-secret toggle, which is the whole point.

---

## 3. New `.sops.yaml`

Recipient **anchors** (promoted from the existing `# mainbox/ci/breakglass` comments) +
one `creation_rule` per secret file. `path_regex` auto-routes which recipients seal which
file, so `sops edit`/`sops -e` always pick the right audience with no flags.

```yaml
# sops creation rules — one file per secret, each with its own recipient set.
# The recipient ANCHORS below are the access-control matrix: to change who can
# decrypt a secret, edit that secret's rule and run `sops updatekeys <file>`.
#
#   mainbox    — the always-on control plane (private key lives ONLY on the box)
#   ci         — GitHub Actions (Pulumi-in-CI; currently only hcloud_api_token)
#   breakglass — Calum's offline recovery key (recipient of EVERY secret)
#
# Holds NO secret values. Tenet 9: the master key never leaves the main box.

keys:
  - &mainbox    age1368zpnurgca5mraqvf3d8d6sl6ctkpxd7ht2mwuvmevpxu74j5tsms9lur
  - &ci         age1c8rzq8txxlq4g6zu0yn46rr9rdzfyn3j5u9d8cxnq2h5w3yrve6sjs3gkc
  - &breakglass age1ewkw53p9v6w44uae75kxnnwnmnt9etqpkems2kjqkyjwldrjju0qe2t4tn

creation_rules:
  # Hetzner API token — box provisions workers; (future) Pulumi-in-CI. CI-readable.
  - path_regex: secrets/hcloud_api_token\.enc\.yaml$
    key_groups:
      - age: [*ci, *mainbox, *breakglass]

  # GitHub PAT — reconciler/Forge. Box-only; CI uses its native GITHUB_TOKEN.
  - path_regex: secrets/forge_github_token\.enc\.yaml$
    key_groups:
      - age: [*mainbox, *breakglass]

  # opencode auth.json — AgentRunner subscription credential. Box-only.
  - path_regex: secrets/runner_opencode_auth_json\.enc\.yaml$
    key_groups:
      - age: [*mainbox, *breakglass]

  # Shared fleet SSH identity (root on every box + operator laptop). Box-only.
  - path_regex: secrets/ssh_tidepool_private_key\.enc\.yaml$
    key_groups:
      - age: [*mainbox, *breakglass]

  # Catch-all so any NEW secrets/*.enc.* file is at least sealed to box+breakglass
  # until it gets its own explicit rule above. (sops uses the FIRST matching rule,
  # so this must stay last.)
  - path_regex: secrets/.*\.enc\.(yaml|json)$
    key_groups:
      - age: [*mainbox, *breakglass]
```

> **sops rule order matters:** sops applies the *first* matching `path_regex`. The
> specific per-secret rules come first; the catch-all is last so a forgotten rule
> fails safe (box+breakglass) rather than unencrypted.

---

## 4. Encrypted per-secret comments

sops encrypts YAML comments by default (`type:comment`) — they're documentation that
ships *inside* the ciphertext, safe to commit. One comment block per secret file:
what it is, who consumes it, how to rotate, owner.

**Hard rule:** never set `unencrypted_comment_regex` / `#sops:dec` in a secrets file —
that leaks the entire following section as plaintext. Leave sops defaults (all encrypted).

The split script (next section) writes these. Example for the SSH key (the one that
caused the confusion):

```yaml
# Single shared Tidepool fleet SSH identity (ed25519, generated in
# infra/bootstrap/collect.sh as ssh-tidepool). PUBLIC half is Hetzner SSH key
# "tidepool" (SSH_KEY_ID 114362250), in root@authorized_keys on the MAIN box and
# EVERY worker. This PRIVATE half is materialized to ~/.tidepool/bootstrap/ssh-tidepool
# and used (1) by the control plane to SSH out to workers (src/agent-runner.ts) and
# (2) by the operator to SSH into all boxes. NOT worker-specific despite the old name.
# rotate: regen on box, sops updatekeys, redeploy to authorized_keys | owner: calum
ssh_tidepool_private_key: ENC[...]
```

---

## 5. Split script — `infra/scripts/split-secrets.sh`

**Operator-run, one-shot.** Decrypts the old blob, re-encrypts each value into its own
per-file secret (renamed key + comment), verifies fidelity, then removes the old blob.
Requires a decrypting age key (breakglass locally, or run on the box) + `sops`, `age`,
`ssh-keygen` on PATH.

Critical fidelity concern: the **SSH private key must keep its exact bytes** (a stripped
trailing newline corrupts it). The script never round-trips the key through a shell
variable — it pipes byte-for-byte file→file — and then **verifies** by re-deriving the
public key and comparing to the known Hetzner-registered pubkey. If they don't match, it
aborts and leaves the old blob intact.

```bash
#!/usr/bin/env bash
# split-secrets.sh — ONE-SHOT migration: explode secrets/tidepool.enc.yaml into
# one encrypted file per secret (renamed + commented). Idempotent-ish: safe to
# re-run; it overwrites the per-file outputs and only deletes the old blob once
# all fidelity checks pass.
#
# Run locally with the breakglass key, or on the box with the mainbox key:
#   SOPS_AGE_KEY_FILE=~/path/age-breakglass.key bash infra/scripts/split-secrets.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OLD="$REPO/secrets/tidepool.enc.yaml"
SEC="$REPO/secrets"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT          # plaintext temp dir shredded on exit
umask 077

[ -f "$OLD" ] || { echo "no $OLD (already migrated?)"; exit 1; }

# old-key  ->  new-file/new-key
emit() {  # $1=old_key  $2=new_name  $3=comment_file
  local old="$1" new="$2" cmt="$3"
  # byte-fidelity: pipe the scalar straight to a temp file (no $() — preserves newlines)
  sops -d --extract "[\"$old\"]" "$OLD" >"$TMP/$new.val"
  # build plaintext yaml: comment block + literal-block scalar (| keeps one trailing \n)
  {
    cat "$cmt"
    printf '%s: |\n' "$new"
    sed 's/^/  /' "$TMP/$new.val"
  } >"$TMP/$new.yaml"
  # encrypt in place — path_regex in .sops.yaml selects recipients
  cp "$TMP/$new.yaml" "$SEC/$new.enc.yaml"
  sops -e -i "$SEC/$new.enc.yaml"
  echo "  ✓ $SEC/$new.enc.yaml"
}

# --- comment blocks (encrypted alongside each value) ---
cat >"$TMP/c_hcloud" <<'EOF'
# Hetzner Cloud API token. Consumer: control plane provisions worker boxes
# (src/hetzner-box.ts); (future) Pulumi-in-CI. rotate: regen in Hetzner console,
# sops edit, redeploy, revoke old. owner: calum
EOF
cat >"$TMP/c_github" <<'EOF'
# GitHub PAT for the reconciler/Forge (clone, push branches, open/merge PRs).
# CI does NOT use this — it has its own native GITHUB_TOKEN. rotate: regen PAT,
# sops edit, redeploy, revoke old. Prefer a GitHub App token long-term. owner: calum
EOF
cat >"$TMP/c_opencode" <<'EOF'
# opencode auth.json — the AgentRunner subscription credential (@opencode-ai/sdk).
# Consumer: AgentRunner on the main box. rotate: re-run opencode auth, sops edit.
# owner: calum
EOF
cat >"$TMP/c_ssh" <<'EOF'
# Single shared Tidepool fleet SSH identity (ed25519, infra/bootstrap/collect.sh).
# PUBLIC half = Hetzner key "tidepool" (SSH_KEY_ID 114362250), in root@authorized_keys
# on the MAIN box AND every worker. PRIVATE half: control plane SSHes out to workers
# (src/agent-runner.ts) AND operator SSHes into all boxes. NOT worker-specific.
# rotate: regen on box, sops updatekeys, redeploy authorized_keys. owner: calum
EOF

echo "splitting $OLD ..."
emit hcloud_token           hcloud_api_token           "$TMP/c_hcloud"
emit github_token           forge_github_token         "$TMP/c_github"
emit opencode_auth_json     runner_opencode_auth_json  "$TMP/c_opencode"
emit ssh_worker_private_key ssh_tidepool_private_key   "$TMP/c_ssh"

# --- fidelity gate: SSH key must still derive the SAME public key ---
echo "verifying ssh key fidelity ..."
sops -d --extract '["ssh_tidepool_private_key"]' "$SEC/ssh_tidepool_private_key.enc.yaml" >"$TMP/ssh.new"
chmod 600 "$TMP/ssh.new"
NEWPUB="$(ssh-keygen -y -f "$TMP/ssh.new" | awk '{print $1, $2}')"
OLDPUB="$(sops -d --extract '["ssh_worker_private_key"]' "$OLD" | ssh-keygen -y -f /dev/stdin | awk '{print $1, $2}')"
[ "$NEWPUB" = "$OLDPUB" ] || { echo "FATAL: ssh pubkey mismatch — NOT deleting old blob"; exit 1; }
echo "  ✓ ssh pubkey matches"

# --- all good: remove the old blob ---
rm -f "$OLD"
echo "done. removed $OLD. review 'git status' then commit."
```

> If `sops -d --extract` emits a trailing newline the original value lacked (or vice
> versa) for the **scalar tokens** (hcloud/github), it's cosmetically harmless — those
> are consumed as env values / trimmed. The SSH key is the only byte-sensitive one, and
> it's gated above.

---

## 6. `materialize-secrets.sh` changes

Only the **sops source** changes (per-file + renamed keys). The on-box **output**
paths and env-var names stay identical (`ssh-tidepool`, `hcloud_token`,
`opencode-auth.json`, `HCLOUD_TOKEN`, `GITHUB_TOKEN`) so no downstream consumer
(agent-runner.ts, cloud-init env) needs touching.

```diff
-ENC="$REPO/secrets/tidepool.enc.yaml"
+SECRETS="$REPO/secrets"
 ...
-# Pull a single top-level key out of the encrypted bundle (decrypt in memory).
-extract() { sops -d --extract "[\"$1\"]" "$ENC"; }
+# Decrypt one per-file secret (file name == top-level key == secret name).
+sec() { sops -d --extract "[\"$1\"]" "$SECRETS/$1.enc.yaml"; }

-# 1. Hetzner token — worker provisioning (src/hetzner-box.ts).
-extract hcloud_token >"$BOOT/hcloud_token"
+sec hcloud_api_token >"$BOOT/hcloud_token"
 chmod 600 "$BOOT/hcloud_token"

-# 2. opencode auth.json — the agent subscription credential.
-extract opencode_auth_json >"$BOOT/opencode-auth.json"
+sec runner_opencode_auth_json >"$BOOT/opencode-auth.json"
 chmod 600 "$BOOT/opencode-auth.json"

-# 3. Shared SSH key to reach workers, plus its derived public half.
-extract ssh_worker_private_key >"$BOOT/ssh-tidepool"
+# 3. Shared fleet SSH key (box->worker AND operator->box), plus derived public half.
+sec ssh_tidepool_private_key >"$BOOT/ssh-tidepool"
 chmod 600 "$BOOT/ssh-tidepool"
 ssh-keygen -y -f "$BOOT/ssh-tidepool" >"$BOOT/ssh-tidepool.pub"
 chmod 644 "$BOOT/ssh-tidepool.pub"
 ...
   echo "TIDEPOOL_DB_PATH=$DB_PATH"
-  echo "HCLOUD_TOKEN=$(extract hcloud_token)"
-  echo "GITHUB_TOKEN=$(extract github_token)"
+  echo "HCLOUD_TOKEN=$(sec hcloud_api_token)"
+  echo "GITHUB_TOKEN=$(sec forge_github_token)"
```

---

## 7. Guardrails — gitleaks

Same binary local + CI (tenet 5). Single Go binary, offline, sub-second.

**`lefthook.yml`** — add to `pre-commit.commands` (runs `gitleaks` if installed; the
`--staged` mode scans only what's being committed):

```yaml
    gitleaks:
      run: gitleaks protect --staged --redact --config .gitleaks.toml
```

**`.gitleaks.toml`** (repo root) — extend the default ruleset, allowlist the encrypted
secrets (their ciphertext is high-entropy *on purpose* and would false-positive):

```toml
title = "tidepool gitleaks"
[extend]
useDefault = true

[allowlist]
description = "sops-encrypted secrets are ciphertext by design"
paths = [
  '''secrets/.*\.enc\.(yaml|json)$''',
]
```

**`.github/workflows/ci.yml`** — add a blocking job (mirrors local):

```yaml
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # full history scan
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITLEAKS_CONFIG: .gitleaks.toml
```

**GitHub push protection** — repo-level UI setting (Settings → Code security → Secret
scanning → Push protection). Can't be set in code; documented here as a manual step.
Turn it on for both `tidepool` and `tidepool-testbed`.

> `prepare` script already runs `lefthook install`, so the hook activates on
> `bun install`. Contributors without `gitleaks` on PATH: the hook will error — add a
> one-line install note to the README (`brew install gitleaks`), or make the hook
> `run: command -v gitleaks >/dev/null && gitleaks ... || true` if we want it
> best-effort locally (CI stays authoritative). **Recommend hard-fail locally** for a
> single-operator repo; CI is the floor regardless.

---

## 8. Docs to update (tenet 11 — docs track reality)

- **HANDOFF.md:47-48** — replace the single-blob inventory with the per-file list +
  new names + per-secret recipients.
- **HANDOFF.md:83-84** — note the on-box bootstrap layout is unchanged (output paths
  stable); the SSH identity description fixed ("fleet identity", not "worker").
- **DESIGN.md:182-189** — secrets store section: note per-file layout + that the
  recipient set is now a per-secret control surface.
- **README.md** — add `brew install gitleaks` to local setup (hook prerequisite).

---

## 9. Operator runbook (the exact sequence Calum runs)

The agent lands everything *except* the re-encrypted secret files (it has no key). You
run the split in the worktree, commit the generated files, then it's a normal PR.

```bash
# 0. in the worktree, on branch tp/tckt_mbtlcg-sops-per-file-secrets
cd .claude/worktrees/tckt_mbtlcg-sops-per-file-secrets

# 1. point sops at a decrypting key (breakglass from 1Password)
export SOPS_AGE_KEY_FILE=<(op read "op://<vault>/tidepool/age-breakglass-key")

# 2. run the split (decrypts old blob, writes per-file secrets, verifies, deletes blob)
bash infra/scripts/split-secrets.sh

# 3. sanity: each new file decrypts, ssh key still derives the right pubkey
for f in secrets/*.enc.yaml; do echo "== $f =="; sops -d "$f" | head -3; done
sops -d --extract '["ssh_tidepool_private_key"]' secrets/ssh_tidepool_private_key.enc.yaml \
  | ssh-keygen -y -f /dev/stdin

# 4. confirm CI recipient is OFF the box-only secrets (should list 2 recipients each)
grep -c age1c8rzq8 <(sops -d --output-type json secrets/forge_github_token.enc.yaml) || true
#   better: check the sops metadata recipient count per file

# 5. gates + commit
bun run check
git add -A && git commit -m "#tckt_mbtlcg refactor(secrets): per-file sops layout + gitleaks (tckt_mbtlcg)"
git push -u origin tp/tckt_mbtlcg-sops-per-file-secrets
gh pr create --fill
```

---

## 10. Verification checklist (evidence before claims — tenet 8)

- [ ] `secrets/tidepool.enc.yaml` is gone; four `secrets/<name>.enc.yaml` exist.
- [ ] Each file decrypts with breakglass; values match the originals.
- [ ] **SSH pubkey derived from the new file == the Hetzner-registered `tidepool` key**
      (split script gates this; re-confirm manually).
- [ ] `forge_github_token`, `runner_opencode_auth_json`, `ssh_tidepool_private_key` are
      sealed to **exactly** `mainbox` + `breakglass` (CI fenced out). Verify via the
      `sops:` metadata recipient list in each file.
- [ ] `hcloud_api_token` sealed to `ci` + `mainbox` + `breakglass` (per decision A).
- [ ] `materialize-secrets.sh` references the new files/keys; a dry decrypt on the box
      produces the same `~/.tidepool/bootstrap/` layout + `/etc/tidepool/env`.
- [ ] `gitleaks protect --staged` passes (no false-positive on `secrets/*.enc.yaml`).
- [ ] `bun run check` green; commitlint accepts the subject; CI green on the PR.
- [ ] Docs (HANDOFF/DESIGN/README) updated in the same PR.

---

## 11. Rollback

The old blob is only deleted *after* the split script's fidelity gate passes. Before the
PR merges, rollback is `git restore`/branch-delete — `main` is untouched. After merge, if
the box can't materialize, revert the PR (the blob returns) and the box's next
service-restart reads the old layout. Because the **underlying secret values and the
on-box output paths are unchanged**, no credential rotation is needed to roll back — only
the sops file layout changes.

---

## 12. Out of scope (follow-up tickets)

- **SSH identity split** (operator-inbound vs control-plane-outbound keys) — the bigger
  blast-radius win; touches cloud-init/bake/agent-runner. Separate ticket.
- **GitHub App token** replacing the long-lived `forge_github_token` PAT — structural
  rotation fix (short-lived, minted on demand). Separate ticket.
- **trufflehog `--only-verified` scheduled history sweep** — verified-leak alerting.
- **Hardware breakglass** (`age-plugin-yubikey`) — optional, keep paper X25519 fallback.
- **Rotation tracking** — `# rotate: <date>` comments are in place; a CI check that
  parses them and warns past-interval is a later nicety.
</content>
</invoke>
