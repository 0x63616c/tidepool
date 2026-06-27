#!/usr/bin/env bash
# Tidepool bootstrap collector. Gathers the human-only secrets/inputs and
# generates the keys we own, into a private dir for the build to consume.
# Safe to re-run: it skips anything already collected. (Future: `tp init`.)
set -euo pipefail

OUT="${TIDEPOOL_BOOTSTRAP_DIR:-$HOME/.tidepool/bootstrap}"
mkdir -p "$OUT"; chmod 700 "$OUT"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m!\033[0m %s\n' "$*"; }

echo "Tidepool bootstrap — output dir: $OUT"
echo "(private; the build reads these, moves them into sops + GitHub secrets, then shreds them)"

# ── 1. Hetzner Cloud API token (HUMAN-ONLY) ───────────────────────────────────
say "1) Hetzner Cloud API token"
if [ -s "$OUT/hcloud_token" ]; then ok "already collected"; else
  echo "   console.hetzner.cloud → create/select project 'tidepool' → Security → API Tokens → Read & Write"
  read -rsp "   paste token (hidden): " HC; echo
  printf '%s' "$HC" > "$OUT/hcloud_token"; chmod 600 "$OUT/hcloud_token"; ok "saved"
fi

# ── 2. opencode Codex-subscription auth (HUMAN-ONLY: browser OAuth) ────────────
say "2) opencode auth — ChatGPT/Codex subscription"
if opencode auth list 2>/dev/null | grep -qi 'openai'; then ok "openai credential already present"; else
  echo "   launching 'opencode auth login' → choose OpenAI → 'ChatGPT Plus/Pro'..."
  opencode auth login || warn "if that failed, run: opencode auth login   (then re-run this script)"
fi
AJ="$HOME/.local/share/opencode/auth.json"
if [ -f "$AJ" ]; then cp "$AJ" "$OUT/opencode-auth.json"; chmod 600 "$OUT/opencode-auth.json"; ok "copied auth.json"
else warn "auth.json not found at $AJ yet — finish the login, then re-run"; fi

# ── 3. Hetzner Object Storage S3 keys (OPTIONAL now — tofu state backend) ──────
say "3) Hetzner Object Storage S3 keys (OpenTofu state) — optional, can skip"
if [ -s "$OUT/objectstorage" ]; then ok "already collected"; else
  read -rp "   provide now? [y/N] " YN
  if [[ "${YN:-}" =~ ^[Yy] ]]; then
    echo "   console → project → Object Storage → create bucket 'tidepool-tfstate' → generate S3 credentials"
    read -rp  "   S3 access key: " AK
    read -rsp "   S3 secret key (hidden): " SK; echo
    read -rp  "   bucket [tidepool-tfstate]: " BK; BK="${BK:-tidepool-tfstate}"
    read -rp  "   endpoint (e.g. https://nbg1.your-objectstorage.com): " EP
    { echo "access_key=$AK"; echo "secret_key=$SK"; echo "bucket=$BK"; echo "endpoint=$EP"; } > "$OUT/objectstorage"
    chmod 600 "$OUT/objectstorage"; ok "saved"
  else warn "skipped — state backend gets settled after the research dossier lands"; fi
fi

# ── 4. Keys we own (generated locally; no input needed) ───────────────────────
say "4) Generating keys we own"
gen_age() { # $1 = name
  [ -f "$OUT/age-$1.key" ] && { ok "age-$1 exists"; return; }
  age-keygen -o "$OUT/age-$1.key" 2> "$OUT/age-$1.pub.txt"
  grep -o 'age1[0-9a-z]*' "$OUT/age-$1.pub.txt" | head -1 > "$OUT/age-$1.pub"
  chmod 600 "$OUT/age-$1.key"; ok "age-$1 generated"
}
gen_age mainbox
gen_age breakglass
if [ -f "$OUT/ssh-tidepool" ]; then ok "ssh key exists"; else
  ssh-keygen -t ed25519 -N "" -C "tidepool" -f "$OUT/ssh-tidepool" >/dev/null; ok "ssh keypair generated"
fi

# ── Manifest ──────────────────────────────────────────────────────────────────
say "Manifest"
: > "$OUT/MANIFEST.txt"
for f in hcloud_token opencode-auth.json objectstorage \
         age-mainbox.key age-mainbox.pub age-breakglass.key age-breakglass.pub \
         ssh-tidepool ssh-tidepool.pub; do
  if [ -e "$OUT/$f" ]; then printf 'have  %s\n' "$f"; else printf 'MISS  %s\n' "$f"; fi
done | tee "$OUT/MANIFEST.txt"

say "Done."
echo "Required for first provision: hcloud_token + opencode-auth.json (objectstorage optional now)."
echo "Tell Claude: \"bootstrap dir ready at $OUT\""
