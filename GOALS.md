# GOALS.md — the staged `/goal` ladder for Tidepool

Invoke in order. Each block is a self-contained `/goal` (copy it, or `/goal @GOALS.md` and name the
goal). Before any: read `HANDOFF.md → DESIGN.md → RESEARCH.md → AGENTS.md → SKILLS.md`. The design is
LOCKED there — execute, don't re-decide. Operate as **lead**: dispatch parallel agent teams (Workflow
tool, Opus, parallelize), preload the skills in SKILLS.md + wire the Pulumi MCP, keep Calum's context
low, report concisely. Stack: TS+Bun+Effect+@effect/platform+@effect/cli+Biome+@effect/vitest+
fast-check, sqlite via @effect/sql, Pulumi(TS), nanoid. Cap = 1 (design-for-N). Tenets in AGENTS.md —
crossing one → STOP and ask Calum.

---

## Goal 1 — orchestrator core + first REAL merged PR (NO cloud spend)

End state: the reconciler fake-suite is green AND one real ticket is driven, locally, to a merged
green PR on `tidepool-testbed@main`.

DONE = every item shown in the transcript:
1. `bun install` ok; `bun run check` exits 0 (biome + `tsc --noEmit` + `vitest run`), **0 failed, 0
   skipped**.
2. The reconciler suite includes & PASSES (name them, show vitest output): (a) one ticket
   `backlog→in_progress→review→done` when fake CI+review are green; (b) red fake-CI → back to
   `in_progress`, retries to the cap, then `failed`; (c) "deploy mid-task": an `in_progress` ticket
   with reattach handles is **resumed not restarted** after the reconciler is reconstructed.
3. `tidepool-testbed` created (private `0x63616c/tidepool-testbed`), pure-fn TS lib + vitest, identical
   rails (biome, commitlint, CI, `main` protected requiring green CI + linear history), pushed.
4. Real adapters built behind the locked interfaces: **GitHub `Forge`** (Octokit), **opencode
   `AgentRunner`** (`@opencode-ai/sdk`, model `openai/gpt-5.4-mini`), **`LocalBoxMaker`** (runs on THIS
   machine — no Hetzner), local `CredentialBroker` (the shared `auth.json`).
5. Drive `tckt_001` (slugify) end-to-end: reconciler claims it → opencode runs locally in a git
   worktree of testbed → writes `slugify` + its vitest → opens a real PR → CI green → review agent
   approves → **auto-merged**.
6. `tp doctor` exits 0 and its output is shown: asserts `slugify` exists on `tidepool-testbed@main`,
   `bun run test` in a fresh clone passes, and the run's sqlite `usage` row has **non-zero tokens**.

BOUNDARIES (do not cross without asking): **NO Hetzner / cloud boxes** (`LocalBoxMaker` only), **NO
Pulumi / provisioning**, do not edit `secrets/**` beyond reading the local `auth.json`. Run opencode
**locally only** (safe re the single-use-refresh-token issue — one machine, shared file). Don't weaken,
skip, or delete tests. Cap = 1.

---

## Goal 2 — run it in the cloud (REAL infra spend, bounded by the 5-box limit)

End state: the same loop runs on Hetzner — a Pulumi-provisioned main box + a real ephemeral worker box
per ticket — and merges a PR on `tidepool-testbed@main`.

DONE = transcript-shown:
1. **Secrets** in sops (`secrets/tidepool.enc.yaml`, recipients main-box+ci+break-glass) built from
   `~/.tidepool/bootstrap/`; GitHub Actions holds the **one** `age-ci` secret; plaintext shredded.
2. **Pulumi (TS) main-box stack**: `cpx12` EU on a private network, deny-all-inbound-except-SSH
   firewall, cloud-init (mise+bun+opencode, clone tidepool, inject age key, systemd reconciler +
   self-update timer). `pulumi up` succeeds; state in Pulumi Cloud.
3. **Hetzner `BoxMaker`** (real): location+type fallback (`cpx22→cpx32…`, `nbg1→hel1→fsn1`) on
   `resource_unavailable`; Effect `Scope` teardown; label `managed_by=tidepool`; **reaper** +
   per-box max-TTL.
4. Drive a ticket on a REAL worker box: box created (show id + private `10.x` IP), opencode runs
   there, PR merged on `tidepool-testbed@main`, **box DELETED** (show project servers back to
   baseline). Spend guardrails **L1–L6** in code.
5. `tp doctor` exits 0 against the cloud run (non-zero usage), output shown.

BOUNDARIES: stay within the **5-box project limit**; **every created box MUST be deleted** (verify the
server count returns to baseline at the end); **never >1 worker concurrently** (N=1). **Get Calum's
explicit OK before the first `pulumi up`** (it spends real money). Tenets hold.

---

## After Goal 2 (parked — separate goals when reached)

Self-bootstrap flip (target = tidepool, gated) · the credential broker + concurrent-merge strategy for
N>1 · `tp` TUI · cost analytics (`tp cost`) · Tailscale (drop public SSH) · dedicated GitHub identity.
