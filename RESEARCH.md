# Tidepool — Research Dossier (2026-06-27)

---

## Go / No-Go on Core Assumptions

| Assumption | Verdict | Reason | Source |
|---|---|---|---|
| Codex-subscription via opencode on ephemeral boxes | AMBER | ChatGPT OAuth has no programmatic injection path; auth.json copy works but carries single-use refresh-token race risk. API key path (type:'api') is fully headless and safe. | [opencode SDK docs](https://opencode.ai/docs/providers/); [opencode issue #26115](https://github.com/anomalyco/opencode/issues/26115) |
| Crabbox vs direct-Hetzner | GREEN (direct) | Tidepool is building the exact governance Crabbox provides; the coordinator adds infra overhead with no net reduction in complexity. Bypass Crabbox; call Hetzner API directly. | [crabbox.sh architecture](https://crabbox.sh/architecture); crabbox v0.33.0 pre-1.0 |
| Hetzner Object Storage as OpenTofu state backend | GREEN | Confirmed working with 6 skip flags + `use_path_style = true`. `skip_s3_checksum = true` required or lock uploads fail on Ceph backend. | [community tutorial](https://community.hetzner.com/tutorials/howto-hcloud-s3-terraform-backend/); [oliver jakobi post](https://oliverjakobi.com/posts/opentofu-s3-backend-hetzner-storage/) |
| opencode exposes token/cost per message | GREEN | `AssistantMessage.cost` (USD float) + `tokens.{input,output,reasoning,cache.{read,write}}` fields confirmed in generated SDK types. Available via `message.updated` SSE event. | [types.gen.ts](https://github.com/sst/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts) |
| auth.json refresh-after-copy is safe | RED | OpenAI OAuth refresh tokens are single-use. Two concurrent copies of auth.json will collide on first refresh, hard-401 with no recovery. Not a bug; inherent to OpenAI OAuth protocol. | opencode SDK research; OpenAI OAuth spec |
| GitHub auto-merge-on-green | AMBER | Native `enablePullRequestAutoMerge` GraphQL mutation still works, but a March 2026 undocumented change requires all requirements (CI + approvals) to be satisfied **before** calling it. Old pattern (enable on PR open) returns HTTP 422. | [community discussion #190610](https://github.com/orgs/community/discussions/190610) |
| ARM workers (CAX series) | AMBER | CAX21 ARM64 is the right price/performance pick, but any native binary npm deps in opencode SDK or transitive tree will silently break. Must run `npm ls --all` on a CAX test box before committing. | [Hetzner CAX docs](https://www.hetzner.com/cloud/cost-optimized); hcloud provider v1.66.0 |

---

## Recommended Pinned Versions

| Component | Pin | Notes |
|---|---|---|
| opencode | `1.17.11` | `"@opencode-ai/sdk": "1.17.11"` in package.json; use `bun install --frozen-lockfile`. Some npm mirrors lag to 1.14.48 — run `npm view @opencode-ai/sdk version` to confirm before pinning. |
| opencode binary | `1.17.11` | Via mise: `.tool-versions: opencode 1.17.11` |
| hcloud Terraform provider | `~> 1.66` | Released 2026-06-18. Requires OpenTofu >= 1.10. After 2026-10-01: `hcloud_datacenter` data source removed — use `hcloud_location` instead. |
| OpenTofu | `~> 1.8` (CI) / `>= 1.10` (provider req) | `opentofu/setup-opentofu@v2` (v2.0.1, 2026-05-18) |
| setup-opentofu action | `v2` | MPL-2.0 |
| crabbox | N/A — skip coordinator | If CLI shelled out, use v0.12.0+ minimum (auth bypass CVE fixed); current v0.33.0 |
| sops | `v3.9.x` | From [getsops/sops](https://github.com/getsops/sops), not mozilla/sops |
| age | `v1.2.x` | Native age1… keys only; ssh-rsa not supported as recipient since v1.1 |
| Tailscale | latest stable | `--state=mem:` for ephemeral workers requires v1.30+ |
| @toon-format/toon | `2.3.0` (pin) | Confirm with `npm view @toon-format/toon version` |
| wagoid/commitlint-github-action | `v6` | Config must be `.mjs` or `.cjs` — plain `.js` not recognized |
| actions/create-github-app-token | `v1` | |
| oven-sh/setup-bun | `v2` | |

---

## 1. Crabbox vs Direct Hetzner

**Verdict: skip the Crabbox coordinator; call Hetzner API directly.**

Tidepool is already building the governance layer Crabbox provides: credential isolation, spend caps, idle self-destruct, and ticket-scoped lifecycle. Adding a self-hosted coordinator (Cloudflare Workers + Durable Objects or Node + Postgres) is parallel infrastructure with no net reduction in complexity.

### What Crabbox actually is

- Open-source (MIT, [openclaw/crabbox](https://github.com/openclaw/crabbox)), v0.33.0 (2026-06-22), pre-1.0.
- A brokered lease layer: CLI issues `POST /v1/leases` to the coordinator, coordinator holds Hetzner credentials, CLI drives data-plane (rsync + SSH) directly — coordinator never touches data.
- No published npm SDK; the coordinator API is HTTPS JSON with Bearer auth, but reimplementing the SSH/rsync data plane is significant work.
- No hosted coordinator SaaS — self-host only (Cloudflare Workers + DO, or Node + Postgres).

### If you ever want Crabbox tooling

Shell out to the CLI binary rather than reimplementing the HTTP API:

```bash
# Provision
crabbox warmup --provider hetzner --class cax21 --ttl 28800 --idle-timeout 3600 --pond tckt_042

# Run
ssh crabbox@<HOST> -p 2222 node /work/runner.js

# Teardown
crabbox pond stop tckt_042
```

The `--pond <ticket-id>` flag groups all leases for a ticket so you can bulk-release atomically.

**Security minimum:** v0.12.0+ (auth bypass CVE; path traversal in Islo fixed v0.9.0).

### Direct Hetzner API pattern (recommended)

```typescript
// Provision worker
const res = await fetch('https://api.hetzner.cloud/v1/servers', {
  method: 'POST',
  headers: { Authorization: `Bearer ${HCLOUD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `tidepool-worker-${ticketId}`,
    server_type: 'cax21',
    image: WORKER_SNAPSHOT_ID,   // numeric; from label_selector=role=worker
    location: 'nbg1',
    ssh_keys: [CP_SSH_KEY_ID],
    firewall_ids: [WORKER_FIREWALL_ID],
    user_data: workerCloudInit,
    labels: { managed_by: 'api', role: 'worker', ticket: ticketId },
  }),
});

// Self-destruct (from inside the worker, reading SERVER_ID from metadata)
const meta = await fetch('http://169.254.169.254/hetzner/v1/metadata').then(r => r.json());
await fetch(`https://api.hetzner.cloud/v1/servers/${meta.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${HCLOUD_TOKEN}` },
});
```

Workers that merely power off keep billing. `DELETE` is mandatory.

**Sources:** [crabbox.sh/how-it-works](https://crabbox.sh/how-it-works.html), [crabbox architecture](https://crabbox.sh/architecture), [crabbox releases](https://github.com/openclaw/crabbox/releases)

---

## 2. Hetzner Cloud Infrastructure

### Machine sizing (post-June-15-2026 pricing)

| Type | vCPU | RAM | Disk | Price/mo | Price/hr | Use |
|---|---|---|---|---|---|---|
| CAX11 | 2 | 4 GB | 40 GB | €4.49 | €0.0072 | Control plane |
| CAX21 | 4 | 8 GB | 80 GB | €7.99 | €0.0128 | Default worker |
| CAX31 | 8 | 16 GB | 160 GB | €15.99 | €0.0256 | Heavy worker |

All CAX: ARM64 Ampere Altra, EU only (nbg1, fsn1, hel1), 20 TB traffic.

**Control plane total: ~€5.56/mo** (CAX11 €4.49 + 10 GB Hetzner Volume at €0.0572/GB/mo for SQLite WAL durability).

**Worker cost example:** 2-hour CAX21 task = €0.0128 × 2 = **€0.026/invocation**.

### Key operational facts

- **Power-off ≠ stop billing.** Only `DELETE /v1/servers/{id}` stops the meter.
- **Snapshot architecture lock:** CAX (ARM64) snapshots cannot boot CPX (x86) instances and vice versa. Bake images on CAX11 (40 GB disk) so they deploy to any CAX tier.
- **UEFI required** on modern Hetzner types — start Packer from `ubuntu-24.04` base, not older images.
- **Billing precision:** partial hours round UP. A 2-minute server = 1 hour billed.
- **API rate limit:** 3,600 req/hr **per-project**, shared across all tokens. At 1 req/sec sustained. Budget: 600/hr CI + 600/hr reconciler + 2,400/hr worker burst headroom.

### Packer bake skeleton

```hcl
source "hcloud" "worker" {
  token        = var.hcloud_token
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "nbg1"
  snapshot_name   = "worker-{{timestamp}}"
  snapshot_labels = { role = "worker" }
  ssh_username = "root"
}

build {
  sources = ["source.hcloud.worker"]
  provisioner "shell" {
    inline = [
      "curl -fsSL https://bun.sh/install | bash",
      "npm install -g @opencode-ai/sdk@1.17.11",
      "install -d -m 700 /run/opencode",
    ]
  }
}
```

### Object Storage (OpenTofu backend)

Endpoint format: `https://{fsn1|nbg1|hel1}.your-objectstorage.com`

S3 credentials are separate from Cloud API tokens — create under Console → Object Storage → Security tab.

```hcl
terraform {
  backend "s3" {
    bucket   = "tidepool-state"
    key      = "control-plane/terraform.tfstate"
    region   = "main"
    endpoints = {
      s3 = "https://fsn1.your-objectstorage.com"
    }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    use_path_style              = true
    skip_s3_checksum            = true   # required — Ceph checksum mismatch on lock uploads
  }
}
```

Credentials go in env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), never in `.tf` files. `TF_VAR_` prefix does not work for backend blocks.

**Sources:** [Hetzner pricing](https://www.hetzner.com/cloud/cost-optimized), [billing FAQ](https://docs.hetzner.com/cloud/billing/faq/), [Object Storage](https://docs.hetzner.com/storage/object-storage/overview/), [S3 backend tutorial](https://community.hetzner.com/tutorials/howto-hcloud-s3-terraform-backend/)

---

## 3. OpenTofu + hcloud Provider

### Provider constraints

- Pin: `version = "~> 1.66"` — released 2026-06-18.
- Requires OpenTofu `>= 1.10`.
- **Breaking after 2026-10-01:** `hcloud_datacenter`/`hcloud_datacenters` data sources removed. Use `hcloud_location`/`hcloud_locations`.
- `allow_deprecated_images` removed in v1.65 — don't use it.

### Minimal control-plane module

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.66" }
  }
}

provider "hcloud" { token = var.hcloud_token }

resource "hcloud_ssh_key" "cp" {
  name       = "tidepool-cp"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "cp" {
  name = "tidepool-cp-fw"
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.management_ips
    description = "SSH only"
  }
  # no outbound rules = all outbound open (Hetzner default)
}

resource "hcloud_server" "cp" {
  name         = "tidepool-cp"
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "fsn1"
  ssh_keys     = [hcloud_ssh_key.cp.id]
  firewall_ids = [hcloud_firewall.cp.id]
  user_data    = templatefile("${path.module}/cloud-init.yaml.tpl", {
    age_private_key = var.age_private_key
  })
  labels = { managed_by = "opentofu", role = "control-plane" }
}
```

**Ephemeral workers: do NOT manage via OpenTofu.** When a worker self-destructs via API, the state drifts and the next `tofu plan` tries to recreate it, causing an infinite loop. Workers are provisioned/destroyed imperatively by the reconciler via the Hetzner Cloud API, tagged `managed_by=api` for label-selector reaping.

### GitHub Actions CI (plan/apply split)

```yaml
name: OpenTofu
on:
  pull_request:
    paths: [infra/**]
  push:
    branches: [main]
    paths: [infra/**]
env:
  HCLOUD_TOKEN: ${{ secrets.HCLOUD_TOKEN }}
  AWS_ACCESS_KEY_ID: ${{ secrets.HETZNER_S3_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.HETZNER_S3_SECRET }}
  TF_VAR_hcloud_token: ${{ secrets.HCLOUD_TOKEN }}
  TF_VAR_age_private_key: ${{ secrets.AGE_PRIVATE_KEY }}
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: opentofu/setup-opentofu@v2
        with: { tofu_version: "~> 1.8" }
      - run: tofu init && tofu validate && tofu plan -out=tfplan
        working-directory: infra
      - uses: actions/upload-artifact@v4
        with: { name: tfplan, path: infra/tfplan, retention-days: 1 }
  apply:
    needs: plan
    runs-on: ubuntu-latest
    environment: production
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    concurrency: { group: tofu-apply, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v4
      - uses: opentofu/setup-opentofu@v2
        with: { tofu_version: "~> 1.8" }
      - uses: actions/download-artifact@v4
        with: { name: tfplan, path: infra }
      - run: tofu init && tofu apply -auto-approve tfplan
        working-directory: infra
```

**Enable state encryption** to protect the age key stored in state: see [OpenTofu state encryption docs](https://opentofu.org/docs/language/state/encryption/).

**Sources:** [hcloud provider releases](https://github.com/hetznercloud/terraform-provider-hcloud/releases), [setup-opentofu](https://github.com/opentofu/setup-opentofu), [Hetzner cloud-init tutorial](https://community.hetzner.com/tutorials/basic-cloud-config/)

---

## 4. opencode TypeScript SDK

### Authoritative types (packages/sdk/js/src/gen/types.gen.ts)

```typescript
// AssistantMessage — exact shape
interface AssistantMessage {
  cost: number;               // USD float
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: { created: number; completed?: number };  // epoch ms
  modelID: string;
  providerID: string;
}
```

### Cost tracking (SSE)

```typescript
import { createOpencodeClient } from '@opencode-ai/sdk';

const client = createOpencodeClient({
  baseURL: 'http://localhost:4096',
  username: 'opencode',
  password: process.env.OPENCODE_SERVER_PASSWORD,
});

let totalCostUSD = 0;
for await (const ev of client.event.subscribe()) {
  if (ev.type === 'message.updated') {
    const msg = ev.properties.info;  // AssistantMessage
    totalCostUSD += msg.cost;
    console.log({ cost: msg.cost, tokens: msg.tokens, model: msg.modelID });
  }
  if (ev.type === 'session.idle' && ev.properties.sessionID === targetSessionId) break;
}
```

### Headless flow (API key path — fully works)

```typescript
// 1. Start: opencode serve --port 4096 (OPENCODE_SERVER_PASSWORD required)
// 2. Inject credentials (headless, no browser)
await client.auth.set({
  path: { id: 'openai' },
  body: { type: 'api', key: process.env.OPENAI_API_KEY },
});
// 3. Create session and prompt
const session = await client.session.create({ body: { ... } });
await client.session.prompt({ path: { id: session.id }, body: { text: '...' } });
// 4. Wait for idle
for await (const ev of client.event.subscribe()) {
  if (ev.type === 'session.idle' && ev.properties.sessionID === session.id) break;
}
```

The REST equivalent: `PUT /auth/{providerID}` with `{ type: 'api', key: '...' }`.

**ChatGPT OAuth cannot be injected programmatically.** Interactive `/connect` browser flow is required on first auth. This is the crux of the auth.json copy strategy.

### auth.json copy strategy (ChatGPT OAuth)

- File location: `~/.local/share/opencode/auth.json` (mode 0600)
- OpenAI OAuth refresh tokens are **single-use** — two workers holding the same token will collide on first refresh, causing a hard 401 with no auto-recovery.
- Safe copy window: check `auth.expires` field in auth.json; if < 15 minutes remain, trigger a manual refresh on source machine first.
- **Never run two workers from the same auth.json copy concurrently.**
- Long-term: use OpenAI API key auth for headless workers to eliminate this constraint entirely.

### Model strings (June 2026)

| String | Status |
|---|---|
| `openai/gpt-5.5` | Current flagship — use this |
| `openai/gpt-5.4` | Available |
| `openai/gpt-5.4-mini` | Available (faster/cheaper) |
| `openai/gpt-5.3-codex` | Available |
| `openai/gpt-5.5-pro` | Hidden for Codex OAuth users (v1.17.10) |
| `openai/gpt-5`, `gpt-5.1-codex`, `gpt-5.2-codex` | **Deprecated** April 14 2026 |

Add to `opencode.json`: `{ "model": "openai/gpt-5.5" }`. Run `opencode models` after `/connect` to get the live list.

### Changed files — avoid session_diff

[Bug #20990](https://github.com/sst/opencode/issues/20990) (April 2026, unfixed in 1.17.11): `session_diff` stores full file contents via `git show`, reaching 44 GB on disk and spiking RSS to 4–10 GB on session resume for large repos.

Use git shell commands instead:

```bash
# Before session
git_sha=$(git rev-parse HEAD)
# After session.idle
git diff --name-status $git_sha HEAD
git checkout -b ticket-$(sessionId)
git add -A && git commit -m "..."
git push -u origin HEAD
```

### Version pinning

```json
{ "@opencode-ai/sdk": "1.17.11" }
```

Use `bun install --frozen-lockfile` in CI. Subscribe to [releases.atom](https://github.com/sst/opencode/releases.atom). Breaking change indicator: diff `types.gen.ts` between versions.

**Sources:** [opencode SDK docs](https://opencode.ai/docs/sdk/), [types.gen.ts](https://github.com/sst/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts), [opencode changelog](https://opencode.ai/changelog), [session_diff bug](https://github.com/sst/opencode/issues/20990)

---

## 5. GitHub Agent Identity, Branch Protection, and CI

### Identity: GitHub App (not PAT, not machine user)

- Commits appear as `<app-name>[bot]`; no extra seat cost; tokens are short-lived (1 hr).
- **Critical:** pushes/PRs created with `GITHUB_TOKEN` (built-in) do **not** trigger `pull_request`/`push` workflows. The App's installation token **does** trigger them.
- Mint per-run: `uses: actions/create-github-app-token@v1` with `app-id` + `private-key`.

**Minimum App permissions:**
- `Contents: write` (push branches)
- `Pull requests: write` (open PR, enable auto-merge)
- `Checks: write` (post check runs)
- `Actions: read` (read workflow status)
- `Workflows: write` **only if** agent edits `.github/workflows/`

### Branch protection (OpenTofu)

```hcl
resource "github_repository_ruleset" "main" {
  name        = "main"
  repository  = github_repository.tidepool.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = github_app.tidepool_agent.id
    actor_type  = "Integration"
    bypass_mode = "pull_request"   # can push branches, not bypass PR requirement
  }

  rules {
    required_linear_history = true   # NOT available in org-level rulesets
    non_fast_forward        = true
    deletion                = true

    pull_request {
      required_approving_review_count = 1
      dismiss_stale_reviews_on_push   = true
      require_last_push_approval      = true
    }

    required_status_checks {
      required_check {
        context = "ci / quality"    # must match workflow job name: field exactly
      }
      strict_required_status_checks_policy = true
    }
  }
}

resource "github_repository" "tidepool" {
  ...
  allow_auto_merge  = true    # prerequisite for GraphQL mutation
  allow_merge_commit = false
  allow_squash_merge = true
}
```

### Auto-merge flow (post-March-2026)

```
push branch → open PR → wait for CI green + review-agent approval → call enablePullRequestAutoMerge
```

**Do NOT** call `enablePullRequestAutoMerge` at PR-open time — returns HTTP 422 since March 2026 behavior change ([discussion #190610](https://github.com/orgs/community/discussions/190610)).

```graphql
mutation {
  enablePullRequestAutoMerge(input: {
    pullRequestId: $nodeId
    mergeMethod: SQUASH
  }) {
    pullRequest { autoMergeRequest { enabledAt } }
  }
}
```

Alternatively, after approving and confirming CI green: `gh pr merge --squash`.

### CI workflow (Bun)

```yaml
name: ci
on: [pull_request, merge_group]
jobs:
  quality:
    name: ci / quality   # this string must match required_status_checks.context exactly
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx prettier --check .
      - run: bunx tsc --noEmit
      - run: bunx vitest run
      - uses: wagoid/commitlint-github-action@v6
        with: { configFile: commitlint.config.mjs }
```

### commitlint config (custom ticket prefix)

```js
// commitlint.config.mjs
export default {
  parserPreset: {
    parserOpts: {
      headerPattern: /^#(tckt_\d+)\s(\w+)(?:\(([^)]+)\))?:\s(.+)$/,
      headerCorrespondence: ['ticket', 'type', 'scope', 'subject'],
      referenceActions: ['close', 'closes', 'closed', 'resolve', 'resolves', 'resolved'],
      // 'fix' removed from referenceActions — otherwise 'fix' in type position silently breaks parsing
    },
  },
  rules: {
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
  },
  // Do NOT use extends: ['@commitlint/config-conventional'] alongside custom parserPreset
  // — array-merge doubles headerCorrespondence entries
};
```

**Sources:** [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [github_repository_ruleset](https://registry.terraform.io/providers/integrations/github/latest/docs/resources/repository_ruleset), [auto-merge mutation](https://docs.github.com/en/graphql/reference/mutations#enablepullrequestautomerge), [auto-merge behavior change](https://github.com/orgs/community/discussions/190610)

---

## 6. AXI — `tp` CLI Design

AXI benchmarks: 100% task success vs 86% raw CLI; vs MCP: 100% vs ~72% success, 2.3× fewer input tokens, 66% cheaper, half the turns. Source: [axi.md](https://axi.md/).

**Decision confirmed:** no MCP server for `tp` in v1. AXI CLI is the correct primary interface.

### Action items

1. **Install AXI SKILL.md into tidepool now:**
   ```bash
   mkdir -p tidepool/.agents/skills/axi
   cp /Users/calum/code/github.com/0x63616c/secrets/.agents/skills/axi/SKILL.md \
      tidepool/.agents/skills/axi/SKILL.md
   # or: npx skills add kunchenguid/axi  (inside tidepool dir)
   ```

2. **TOON output library:**
   ```bash
   bun add @toon-format/toon@2.3.0
   ```
   Wire `encode()` at a single stdout boundary in an `outputFormatter` module. Internal logic stays in plain JS objects.

3. **`tp` (no args) = live TOON ticket dashboard**, not help text (Principle 8: Content First).

### Command structure (noun-verb)

```
tp ticket list     (alias: tp ls)
tp ticket view <id>
tp ticket add
tp box list
tp run list
tp run logs <id>
tp cost
tp setup hooks
tp session-context   # used by SessionStart hooks; target <500 tokens output
```

### Session hook integration

**Claude Code** (`~/.claude/settings.json` or project-local `.claude/settings.json`):
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "tp session-context" }]
    }]
  }
}
```

**OpenCode:** No native SessionStart hook as of June 2026 ([issue #12110](https://github.com/anomalyco/opencode/issues/12110)). Use the OpenCode plugin system (`~/.config/opencode/plugins/`) to inject context at `session.created`.

### Output contracts

- `stdout`: ALL structured output (data, errors, suggestions).
- `stderr`: debug/progress only — never mix "Fetching…" into stdout.
- Exit codes: `0` = success/no-op, `1` = error, `2` = usage error. Idempotent mutations return `0`.
- Empty states: `tickets: 0 open tickets in this workspace` — never silent empty output.
- Lists: always include `count: 30 of 847 total` before the list.
- Errors: `error: --title is required\nhelp: tp ticket add --title "..."` — translate internal errors to tp-level actionable messages.

### `tp session-context` target output (< 500 tokens)

```
open_tickets: 3
in_progress: #tckt_042 "Add worker self-destruct" branch:feat/tckt042 state:coding
boxes: 1 active (worker-tckt042, cax21, nbg1, 43m uptime)
hints[2]:
  tp ticket view tckt_042
  tp run logs tckt_042
```

**Sources:** [axi.md](https://axi.md/), [gh-axi](https://github.com/kunchenguid/gh-axi), [toonformat.dev](https://toonformat.dev/), [AXI vs MCP benchmark](https://kunchenguid.medium.com/i-benchmarked-github-cli-vs-mcp-vs-tool-search-vs-code-mode-turns-out-the-best-solution-is-none-93528d5039e4)

---

## 7. Secrets (sops+age) and Tailscale Networking

### sops+age layout

```yaml
# .sops.yaml
creation_rules:
  - path_regex: 'secrets/.*'
    age: 'age1MAINBOX_PUBKEY,age1HUMAN_BREAKGLASS_PUBKEY,age1CI_KEY_PUBKEY'
    encrypted_regex: '^(value|password|token|key|secret|auth_json)$'
    # keys/structure remain plaintext in git for diffability
```

Key management:
```bash
age-keygen -o ~/.config/sops/age/keys.txt   # generates private + prints pubkey
age-keygen -y ~/.config/sops/age/keys.txt    # print pubkey from private key file
sops --encrypt --in-place secrets/config.yaml
sops --decrypt secrets/config.yaml           # to stdout
sops updatekeys --yes secrets/config.yaml    # add new recipient; re-wraps data key only
sops rotate -i secrets/config.yaml           # full re-encrypt with new data key (on compromise)
```

### Main box bootstrap (cloud-init)

```yaml
#cloud-config
write_files:
  - path: /etc/sops/age/key
    permissions: '0600'
    owner: root:root
    content: |
      ${age_private_key}        # interpolated via templatefile()

  - path: /etc/systemd/system/tidepool.service
    permissions: '0644'
    content: |
      [Unit]
      Description=Tidepool Reconciler
      After=network-online.target
      [Service]
      RuntimeDirectory=tidepool
      Environment=SOPS_AGE_KEY_FILE=/etc/sops/age/key
      ExecStartPre=sops --decrypt /opt/tidepool/secrets/config.enc.yaml
      ExecStart=/usr/local/bin/bun /opt/tidepool/reconciler.ts
      Restart=on-failure
      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl enable --now tidepool.service
```

**CRITICAL:** Hetzner exposes `user_data` at `http://169.254.169.254/hetzner/v1/userdata` for the entire instance lifetime to any local process. Unlike AWS IMDSv2, there is no token-gate. The age key at `/etc/sops/age/key` must be root:0600. Never run SSRF-vulnerable services on the main box. Consider blocking `169.254.169.254` via iptables for non-root users if any untrusted processes run on the box.

### GitHub Actions decrypt pattern

```yaml
- name: Install sops
  uses: nhedger/setup-sops@v2
- name: Decrypt secrets
  env:
    SOPS_AGE_KEY: ${{ secrets.SOPS_AGE_KEY }}   # CI-specific age key (3rd recipient)
  run: |
    mkdir -p ~/.config/sops/age
    echo "$SOPS_AGE_KEY" > ~/.config/sops/age/keys.txt
    chmod 600 ~/.config/sops/age/keys.txt
    sops --decrypt secrets/config.enc.yaml > config.yaml
```

### JIT worker secrets delivery

```bash
# On main box — pipe sops decrypt directly over SSH into worker tmpfs
sops --decrypt /opt/tidepool/secrets/opencode-auth.enc.yaml \
  | ssh -o StrictHostKeyChecking=accept-new \
        -i /etc/tidepool/worker-ssh-key \
        worker@$WORKER_IP \
        'mkdir -p /run/opencode && cat > /run/opencode/auth.json && chmod 600 /run/opencode/auth.json'
```

The age private key never leaves the main box. Worker receives plaintext only over encrypted SSH into its tmpfs (`/run/` is memory-only, cleared on reboot).

### Tailscale

**Main box (permanent):**
```bash
# cloud-init runcmd
- [sh, -c, 'curl -fsSL https://tailscale.com/install.sh | sh']
- [tailscale, up, --auth-key=${TS_CP_AUTH_KEY}, --hostname=tidepool-cp, --ssh,
   --advertise-tags=tag:control-plane]
# After confirming tailscale ssh works, apply Hetzner Firewall blocking port 22 from 0.0.0.0/0
```

**Workers (ephemeral, v1.30+):**
```bash
# write_files: /etc/default/tailscaled → FLAGS='--state=mem:'
# then runcmd:
- [sh, -c, 'curl -fsSL https://tailscale.com/install.sh | sh']
- [tailscale, up, --auth-key=${TS_WORKER_KEY}, --hostname=tidepool-worker-$(hostname),
   --ssh, --advertise-tags=tag:worker]
```

`--state=mem:` causes `tailscale logout` on shutdown → node immediately removed from tailnet (no 30-60 min grace period). Workers must be referenced by MagicDNS hostname (not IP, which changes on each `--state=mem:` start).

**Avoid 90-day auth key expiry — use OAuth client:**
```bash
curl -u "${TS_OAUTH_CLIENT_ID}:${TS_OAUTH_CLIENT_SECRET}" \
  https://api.tailscale.com/api/v2/tailnet/-/keys \
  -d '{"capabilities":{"devices":{"create":{"reusable":true,"ephemeral":true,
       "preauthorized":true,"tags":["tag:worker"]}}},"expirySeconds":86400}'
```

### Key rotation procedure

1. `age-keygen -o new-key.txt`
2. Add new pubkey to `.sops.yaml` alongside old
3. `for f in secrets/*.enc.yaml; do sops updatekeys --yes $f; done`
4. Deploy new private key to all consumers; verify decryption
5. Remove old pubkey from `.sops.yaml`
6. Repeat `sops updatekeys --yes` on all files
7. `shred -u old-key.txt`

On compromise: use `sops rotate -i` (generates fresh data key) instead of `updatekeys`.

**Sources:** [getsops/sops](https://github.com/getsops/sops), [age](https://github.com/FiloSottile/age), [Tailscale ephemeral nodes](https://tailscale.com/kb/1111/ephemeral-nodes), [Tailscale OAuth](https://tailscale.com/docs/features/oauth-clients), [Hetzner cloud-init](https://community.hetzner.com/tutorials/basic-cloud-config/)

---

## Open Questions for Calum

1. **ChatGPT OAuth vs API key on workers:** The auth.json single-use refresh token is a hard operational risk. Can you switch to an OpenAI API key (metered, not subscription) for worker agents, even if that costs per-token? Or is the ChatGPT subscription a hard budget constraint? This decision unblocks the entire auth bootstrap design.

2. **auth.json `auth.expires` format:** Is it Unix ms, ISO string, or seconds? Needs hands-on inspection of a live auth.json to build the TTL-guard copy logic. Check: `cat ~/.local/share/opencode/auth.json | jq '.expires'`.

3. **Access token TTL for ChatGPT OAuth:** What is the actual access token lifetime? This determines the usable copy window. Test empirically.

4. **session.idle reliability:** Has `session.idle` been reliable in practice for sessions > 5 minutes, or does SSE reconnection gap cause it to be missed? Needs an empirical test before relying on it as the sole completion signal. Add a timeout safety net regardless.

5. **session_diff bug (#20990) fix status:** Is this fixed in v1.17.11? The changelog does not mention it. Check `git log --oneline` on the dev branch filtering for "session_diff" or "memory".

6. **ARM native module compatibility:** Run `npm ls --all` on a live CAX21 box with the opencode SDK installed and grep for `.node` files. Any native binary = ARM incompatibility risk. Must be verified before committing to CAX workers.

7. **Hetzner metadata endpoint threat model:** Will any HTTP-serving process (webhook receiver, web UI) run on the main box alongside the reconciler? If yes, block `169.254.169.254` via iptables for non-root users immediately.

8. **Reconciler runtime vs first-boot-only secrets:** Does the reconciler need the age key at runtime for periodic secrets reloads, or only at first boot? If first-boot only, `shred /etc/sops/age/key` after initial decrypt significantly reduces the metadata endpoint exposure window.

9. **Worker SSH access mechanism:** Is Tailscale SSH the chosen approach, or will you keep OpenSSH on port 22 behind Hetzner Firewall restricted to the control plane IP? Tailscale adds another dependency but eliminates authorized_keys management.

10. **Tailscale plan tier:** Ephemeral node billing changed in 2025. Nodes active > 4 hr/month may count as standard tagged devices. For workers running 2–8 hour coding sessions this affects cost. Check your current plan tier limits.

11. **`tp session-context` output spec:** Confirm the minimal TOON dashboard fields (open ticket count, in-progress ticket, box count, 2 hints) fit under 500 tokens. Draft a sample output and count tokens before wiring the hook.

12. **`tp` npm publication:** Is `tp` published to npm (enabling npx-prefixed commands in SKILL.md) or is it global-install only on the main box and developer machine? This determines what command examples go in the SKILL.md.

13. **OpenCode plugin for SessionStart:** Since there is no native hook ([issue #12110](https://github.com/anomalyco/opencode/issues/12110)), what OpenCode plugin event is the right hook point — `session.created`, or the experimental `session.compacting`?

14. **GitHub App bypass actor configuration:** Confirm that adding the App as a `bypass_actor` with `bypass_mode = "pull_request"` (can push branches but cannot bypass the PR requirement) is the intended policy — i.e., the agent must always go through a PR, never direct-push to main.

15. **Crabbox coordinator decision:** Confirm the recommendation to bypass Crabbox entirely and call Hetzner API directly. If you want Crabbox tooling for the CLI ergonomics (rsync, ready-marker, exec streaming), confirm that shelling out to the Go binary as a subprocess is acceptable rather than a native TypeScript API.
