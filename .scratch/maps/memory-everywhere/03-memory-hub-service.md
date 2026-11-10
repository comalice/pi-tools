# pi-memory-hub service

**Type:** task
**Status:** closed
**Blocked by:** Origin provenance column, Blob store + import surfaces

## Question

New token-gated HTTP service in the shape of `pi-wiki-serve`: `/search`, `/expand` (read paths, same semantics as the extension's local implementation), `/ingest` (receives pushed session payloads, runs normal ingest with origin from the token's spoke), `/status` (version, archive stats, token validity — what `memory join` verifies against). Per-spoke revocable tokens in hub config. Binds via the Q7 knob. systemd unit + deploy plumbing in the usual pattern.

## Resolution

Implemented `pi-memory-hub` with token-gated `/status`, `/search`, `/expand`, and serialized `/ingest` endpoints; local `memory hub-token add|list|revoke`; Pi JSONL blob imports with token-asserted origin; systemd install plumbing; and hub operations documentation/tests.

Decision: the service opens the archive through `openStore` at startup, applying supported migrations before opening a separate exact-schema read-only connection for search/expand. It creates the archive if missing; `memory ingest` follows a Pi blob root once hub push registers one. Remote search defaults to all-project scope when no scope/project is supplied; explicit project scope is supported.

Validation: `npm test` passes (143 tests, 0 failures). No known leftovers.
