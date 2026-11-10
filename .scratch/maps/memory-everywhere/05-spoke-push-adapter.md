# Spoke push adapter + timer

**Type:** task
**Status:** claimed
**Blocked by:** pi-memory-hub service

## Question

`memory push` command: exports new/changed pi session files, plus opencode and claude sessions through the existing digest adapters, POSTs to hub `/ingest` with the spoke token; watermark state so re-runs are incremental and idempotent. systemd user timer per spoke (daily, or on-session-end if a clean hook exists). Best-effort: failure logs and retries next run, no durable spool in v1.

## Resolution
