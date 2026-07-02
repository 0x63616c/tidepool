# tickets/ — seed fixtures (NOT the runtime store)

> The runtime ticket store is **sqlite on the main box** (single source of truth). These markdown
> files are **seed fixtures**: example tickets the loop ingests once to bootstrap a backlog for
> testing. They are not where ticket state lives.

A ticket (in the store) = `{ id, title, body, state, target, branch, pr, attempts, usage }`.
`body` is structured markdown (`# Context`, `# Acceptance Criteria`, `# Relevant Files`, `# Approach`,
`# Out of Scope`) — the sole intent field the work + review agents read. The review agent grades the
diff against the `# Acceptance Criteria` section; "green, merged PR" is a system invariant, never
written in the body. Done = a DB state transition the reconciler makes after auto-merge (review ✅ +
CI ✅ + merged).

Fixture frontmatter:

```markdown
---
id: tckt_xxxxxx
title: short title
priority: 1
target: tidepool-testbed
---
# Context
## Problem
what's missing/broken today.
## Motivation
why it matters now.

# Acceptance Criteria
- checkable, gradeable statement of done.

# Relevant Files
- path:line pointers (as of writing — verify against current code).
```

`tckt_001` (slugify) is the terminal-check function: `tp doctor` asserts slugify exists on
`tidepool-testbed@main`, its test passes, and the run's sqlite `usage` row is non-zero.
