# tickets/ — seed fixtures (NOT the runtime store)

> The runtime ticket store is **sqlite on the main box** (single source of truth). These markdown
> files are **seed fixtures**: example tickets the loop ingests once to bootstrap a backlog for
> testing. They are not where ticket state lives.

A ticket (in the store) = `{ id, title, goal, state, target, branch, pr, attempts, usage }`.
`goal` is the acceptance criterion; "green, merged PR" is a system invariant, never written in `goal`.
Done = a DB state transition the reconciler makes after auto-merge (review ✅ + CI ✅ + merged).

Fixture frontmatter:

```markdown
---
id: tckt_xxxxxx
title: short title
goal: "checkable acceptance criterion"
priority: 1
target: tidepool-testbed
---
Optional notes for the agent.
```

`tckt_001` (slugify) is the terminal-check function: `tp doctor` asserts slugify exists on
`tidepool-testbed@main`, its test passes, and the run's sqlite `usage` row is non-zero.
