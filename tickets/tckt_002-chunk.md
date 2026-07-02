---
id: tckt_002
title: fix chunk off-by-one
body: "fix chunk(arr, n) in src/array.ts so the final partial group is included when arr.length % n !== 0. Add a failing test first that reproduces the bug, then fix."
priority: 2
target: tidepool-testbed
---
Exercises the bugfix path: reproduce-then-fix (TDD), which the review agent should verify.
