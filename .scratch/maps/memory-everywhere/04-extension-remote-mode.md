# Extension remote mode

**Type:** task
**Status:** closed
**Blocked by:** pi-memory-hub service

## Question

The pi memory extension reads `~/.pi/agent/memory/hub.json` when present and routes `memory_search`/`memory_expand` over HTTP to the hub with the spoke's token — identical tool surface, identical output shape, local archive untouched. Failure mode: clear error naming the hub and the failure, never a silent fallback to an empty local DB.

## Resolution

Implemented remote mode in `src/memory/remote.ts` and wired both extension tools to
use it whenever `hub.json` is present. The pointer is validated on each call as
a private regular file with an HTTP(S) origin and non-empty token; failures are
clear tool errors and never fall back to a local archive. Requests use Bearer
authentication, reject redirects, and have a 30-second timeout. Background
local ingestion is skipped on spokes. With no pointer, the prior local path is
unchanged.

Remote search and expansion retain the local request parameters and successful
tool details. Search adds the remote-only trailing line
`hub archive latest: <timestamp>` (or `unknown`); this is the deliberate output
text difference required to expose the hub's archive timestamp. To preserve
local search semantics, the hub `/search` contract now accepts `currentSession`
and excludes it from both results and `archive.latest`.

Added real-hub extension tests covering search/expand, 401 and 403 errors,
network-down errors, no local fallback, and absent-pointer local mode. Full
`npm test`: 149 passing, 0 failing.

**Decision:** `hub.json` must be owner-private (no group/world permissions),
regular (symlinks rejected), and point to an origin rather than a path. This
keeps token handling and routing unambiguous. Remote HTTP remains supported as
specified; use a trusted private network or TLS-terminating proxy, as documented
for the hub.

**Concerns:** Plain HTTP does not encrypt the bearer token; deployment must
protect the configured transport.
