---
id: tckt_001
title: add slugify
body: "add slugify(s: string): string in src/string.ts — lowercases, trims, spaces→'-', strips chars that aren't [a-z0-9-], collapses repeated '-'. Has a vitest spec covering those cases."
priority: 1
target: tidepool-testbed
---
This is the terminal-check function. `tp doctor` asserts slugify exists on tidepool-testbed@main,
its test passes, and the run recorded non-zero token usage.
