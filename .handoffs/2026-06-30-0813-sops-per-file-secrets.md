# Tidepool — Handoff: SOPS per-file secrets rehaul (2026-06-30 08:13)

**PR #28 (`tckt_mbtlcg`) splits the single sops secrets blob into one encrypted file per
secret, each with its own recipient set, + adds gitleaks.** Branch
`tp/tckt_mbtlcg-sops-per-file-secrets`, all CI green (check + commitlint + gitleaks +
container-harness), marked ready. Not yet merged at time of writing.

Repo: `/Users/calum/code/github.com/0x63616c/tidepool` (worktree under `.claude/worktrees/`).

## Why this was done
- **Least-privilege:** sops' decrypt unit is the *file*. The old single
  `secrets/tidepool.enc.yaml` was sealed to mainbox+ci+breakglass, so **CI could decrypt
  the SSH key + opencode auth despite only needing the Hetzner token** (tenet 9 violation).
- **`ssh_worker_private_key` was misnamed:** it is the single shared *fleet* identity —
  one ed25519 keypair (gen'd in `infra/bootstrap/collect.sh`), public half = Hetzner key
  `tidepool` (SSH_KEY_ID 114362250) in root@authorized_keys on the main box AND every
  worker; private half used both by the control plane to SSH out to workers
  (`src/agent-runner.ts`) and by the operator to SSH into all boxes. NOT worker-specific.

## Key design decision: per-file, not per-tier
Considered grouping by trust tier (`infra.enc.yaml` CI-readable vs `runtime.enc.yaml`
box-only = 2 files). Rejected: tier grouping only holds while audiences are stable; the
moment one secret's audience diverges from its file-mates you must move it or over-grant
the whole file. **One file per secret** makes each secret's recipient set an independently
tunable dial (edit one `.sops.yaml` rule + `sops updatekeys <file>`), at the cost of N
`creation_rules` (kept DRY via recipient anchors). Chosen because audiences are expected
to drift per-secret. `.sops.yaml` is now the access-control matrix.

## End state (verified)
| Secret file | recipients | CI? |
|---|---|---|
| `hcloud_api_token.enc.yaml` | ci + mainbox + breakglass | ✓ (Pulumi-in-CI, future) |
| `forge_github_token.enc.yaml` | mainbox + breakglass | ✗ fenced |
| `runner_opencode_auth_json.enc.yaml` | mainbox + breakglass | ✗ fenced |
| `ssh_tidepool_private_key.enc.yaml` | mainbox + breakglass | ✗ fenced |

- Recipient counts confirmed from each file's plaintext sops metadata: `ci` (age1c8rzq8)
  is on `hcloud_api_token` ONLY. That's the blast-radius win.
- SSH key byte-fidelity verified: re-derived pubkey == pre-split pubkey
  (`ssh-ed25519 AAAA...2D7V`) before the old blob was deleted.
- `materialize-secrets.sh` updated to read per-file/renamed keys; **on-box output paths +
  env var names unchanged** (`ssh-tidepool`, `hcloud_token`, `opencode-auth.json`,
  `HCLOUD_TOKEN`, `GITHUB_TOKEN`) so no downstream consumer (agent-runner, cloud-init) was
  touched.
- gitleaks: `.gitleaks.toml` (allowlists `secrets/*.enc.*`), lefthook pre-commit
  (`gitleaks protect --staged`), and a CI job. Requires `brew install gitleaks` locally.

## Gotchas (the next session will re-hit these without this note)
1. **`SOPS_AGE_KEY_FILE=<(op read ...)` is a single-use pipe.** A migration that invokes
   sops many times drains the pipe on the first decrypt; all later decrypts get EOF.
   Write the key to a 0600 temp file instead: `op read ... > "$keydir/bg.key"`, then
   `SOPS_AGE_KEY_FILE="$keydir/bg.key"`, then `shred -u` it.
2. **`ssh-keygen -y -f /dev/stdin` is rejected** on macOS ("bad permissions", fd 0660).
   To derive a pubkey from a piped private key, write it to a 0600 temp file first.
3. **gitleaks-action@v2 needs `GITHUB_TOKEN` in env** to scan PRs, else it errors
   "GITHUB_TOKEN is now required". (It's the ephemeral Actions-minted token — NOT a stored
   repo secret; the "0 repo secrets" invariant still holds.)
4. **Breakglass key path in 1Password:** `op://tidepool/age-breakglass/credential`
   (public half = `age1ewkw53...`).

## No standalone migration doc kept
Drafted a full `docs/sops-migration.md` + a one-shot `infra/scripts/split-secrets.sh` to
scaffold the work and get review, then **deleted both** before merge (one-shot artifacts
go stale; durable knowledge lives in `.sops.yaml` comments + per-secret encrypted comments
+ HANDOFF/DESIGN). The migration record is this handoff.

## Remaining
- **MERGE PR #28**, then two manual GitHub-settings steps (not code):
  turn on **push protection** for `tidepool` + `tidepool-testbed`; add **`gitleaks`** to
  `main`'s required status checks.
- **Open decision:** `hcloud_api_token` keeps `ci` as a recipient (forward-looking for
  Pulumi-in-CI, which is not yet wired — no workflow currently decrypts sops). Flip to
  box-only for strict least-privilege-today if preferred (one-line `.sops.yaml` change).
- **Follow-up ticket — SSH identity split:** one key = root on the whole fleet AND it's on
  the operator laptop → a laptop leak owns everything. Split into operator-inbound vs
  control-plane-outbound identities; touches cloud-init/bake/agent-runner. Biggest
  remaining blast-radius win.
- **Follow-up ticket — GitHub App token** to replace the long-lived `forge_github_token`
  PAT (short-lived, minted on demand).
- **Deferred (research-backed, optional):** trufflehog `--only-verified` scheduled
  history sweep; hardware breakglass via `age-plugin-yubikey` (keep paper X25519 fallback);
  a CI check that parses `# rotate:` comments and warns past-interval.
