# Session handoffs

This directory holds **session handoff docs** — the running context one Claude session
leaves for the next, so work can resume without re-deriving state.

## Naming

`<YYYY-MM-DD>-<HHMM>-<slug>.md`

The time component keeps two handoffs written on the same day collision-safe and preserves
ordering. Newer handoffs supersede older ones.

## Redaction (public repo)

This repo is **public**. Handoffs are **redacted** before committing: concrete operational
secrets (e.g. Hetzner box public IPs) are replaced with placeholders like `<box-ip>`.
File *paths* to secrets (e.g. `~/.tidepool/bootstrap/...`) are kept — the path is not the
secret. Never commit a real token, key, or public box IP here.
