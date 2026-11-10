# Spoke push adapter + timer

**Type:** task
**Status:** closed
**Blocked by:** pi-memory-hub service

## Question

`memory push` command: exports new/changed pi session files, plus opencode and claude sessions through the existing digest adapters, POSTs to hub `/ingest` with the spoke token; watermark state so re-runs are incremental and idempotent. systemd user timer per spoke (daily, or on-session-end if a clean hook exists). Best-effort: failure logs and retries next run, no durable spool in v1.

## Resolution

Implemented `memory push` for recursive Pi `*.jsonl` sessions using
`~/.pi/agent/memory/hub.json` and per-file SHA-256/size/mtime watermarks in
private `push-state.json`. Successful files advance independently; failures are
logged, retried later, and produce a nonzero exit. Added the optional 15-minute
user timer and separate `make install-spoke` / `make uninstall-spoke` targets.

The hub now replaces an older payload snapshot from the same spoke and stable
uploaded filename when a session changes; this is needed because immutable
content-addressed versions of one append-mostly Pi session otherwise collide on
Pi session ID during re-ingestion. Push filenames include a stable relative-path
hash to distinguish same-named files in different session subdirectories.

Scope remains Pi only. OpenCode, Claude, and Grok push adapters are out of
scope; `memory join` remains ticket 06. Push requires that join-created
`hub.json` configuration to exist. Full `npm test` passes (146 tests), and the
systemd unit templates verify successfully.
