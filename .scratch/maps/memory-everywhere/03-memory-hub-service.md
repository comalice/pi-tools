# pi-memory-hub service

**Type:** task
**Status:** claimed
**Blocked by:** Origin provenance column, Blob store + import surfaces

## Question

New token-gated HTTP service in the shape of `pi-wiki-serve`: `/search`, `/expand` (read paths, same semantics as the extension's local implementation), `/ingest` (receives pushed session payloads, runs normal ingest with origin from the token's spoke), `/status` (version, archive stats, token validity — what `memory join` verifies against). Per-spoke revocable tokens in hub config. Binds via the Q7 knob. systemd unit + deploy plumbing in the usual pattern.

## Resolution
