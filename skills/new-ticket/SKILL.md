---
name: new-ticket
description: Author a well-structured tidepool ticket and file it via `tp ticket add`. Use whenever Calum says "create a ticket", "new ticket", "file a ticket", or otherwise asks to enqueue work for the tidepool worker — load this BEFORE writing any ticket.
---

# new-ticket — author a tidepool ticket the worker can execute

A tidepool ticket's `body` is the **only** intent-bearing field the work + review
agents read (it is injected verbatim into their prompt, wrapped in `<ticket>`).
A vague body ⇒ a vague PR. This skill turns a one-line ask into a structured,
gradeable body and files it with `tp ticket add`.

The body may sit many tickets deep in the queue before it runs, so write it to be
**durable**: enough context to orient, a crisp acceptance criterion, pointers the
agent can re-verify — never a brittle step-by-step that rots when the code moves.

## Flow (default: explore → draft → confirm → file)

Prefer resolving ambiguity by **reading the code**, not by interrogating Calum.
Only ask him a question when exploration genuinely cannot settle it.

1. **Explore.** Dispatch an `Explore` (or `general-purpose`) sub-agent to map the
   files, seams, and existing patterns the ticket touches. Capture concrete
   `path:line` pointers. Do not skip this — the `# Relevant Files` section is the
   payoff.
2. **Draft** the body into the template below, to a temp markdown file.
3. **Confirm.** Show Calum the drafted body. Incorporate edits.
4. **File** it (see Filing). Report the new `tckt_…` id + how to watch it.

## Body template (emit these sections, in this order)

```markdown
# Context
## Problem
What's missing or broken today (the observable gap).
## Motivation
Why it matters now / what it unblocks.

# Acceptance Criteria
- Crisp, checkable statements of "done". The review agent grades the diff
  against THIS section. Keep them behavioral and verifiable.
- Do NOT restate "green, merged PR" — that's a system invariant, never an AC.

# Relevant Files
As of writing (#<short-commit-sha>, <ISO-8601-datetime>) — verify before trusting:
- `path/to/file.ts:123` — what lives here / why it's relevant.

# Approach (optional, non-binding)
A rough outline the agent MAY follow. Explicitly not prescriptive — if the code
has moved, the Acceptance Criteria win. Omit if the AC already imply the path.

# Out of Scope
- What NOT to touch. Keeps the blast radius (and the diff) tight.
```

### Stamping `# Relevant Files`

Get the pointers' as-of stamp from the target repo, not from memory:

```bash
git rev-parse --short HEAD    # → the <short-commit-sha>
date -u +%Y-%m-%dT%H:%M:%SZ   # → the <ISO-8601-datetime>
```

## Filing

Default to **production** context unless Calum says otherwise. The body is
multi-line markdown, so always pass it via a file, never inline:

```bash
# write the drafted body to a temp file first, then:
tp ticket add \
  --title "<short imperative title>" \
  --body-file <path/to/body.md> \
  --target "<owner/repo>" \
  --context production
```

- `--title` is short + imperative; it becomes the PR title / commit subject, not
  the agent's instructions (the body is).
- `--body-file <path>` reads the markdown from disk (`-` reads stdin). Mutually
  exclusive with inline `--body`.
- `--target` must be a configured repo (run `tp ticket add` with a bad target to
  see the configured list).
- Omit `--context production` only when Calum asks for local/dev.

After filing, surface the id and the watch command:

```bash
tp ticket get <tckt_id> --context production        # detail (body truncated; --full for all)
tp ticket logs <tckt_id> --context production       # live event stream
```

## Don'ts

- Don't write acceptance criteria that encode the invariant ("PR is merged and
  green") — the harness owns that.
- Don't over-specify the `# Approach`; a stale recipe is worse than none.
- Don't inline a huge `--body` on argv — use `--body-file`.
- Don't file to `local` when Calum meant prod (prod is the default here).
