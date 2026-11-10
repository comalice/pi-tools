# Blob store + import surfaces

**Type:** task
**Status:** claimed
**Blocked by:** Origin provenance column

## Question

The reconciler treats the registered source trees as authoritative: if `~/.pi/agent/grok-exports/` (or claude-exports, or a spoke's session tree) is deleted or moved, the next ingest interprets the absence as deletion and prunes those sessions from the archive (entries, documents, sessions, source_files). The archive is self-contained at query time, but its provenance is hostage to directory hygiene — and in hub-and-spoke terms, the hub would be hostage to every spoke's filesystem.

Make the memory system own its raw sources:

- **Blob store**: `~/.pi/agent/memory/blobs/<source>/<origin>/<content-hash>` holding every imported raw payload. Content-addressed, so re-import is idempotent for free. `source_files.file` points at the blob path; original filename/host/import time recorded alongside.
- **Authority flip**: ingest reconciles only against the blob store. `memory ingest <path>` becomes import-through-blob (copy in, then ingest from the blob). Pruning becomes an explicit act (`memory forget` / prune command), never an implicit consequence of an external file disappearing.
- **Import surfaces**: `memory import <path>` CLI (hub-local and agent-callable), hub `/import` endpoint (token-gated, source + origin from token), and an upload widget in the admin panel. An extension-level `memory_import` tool is optional — include only if it falls out cheaply.
- **Backfill migration**: one-shot command that copies each registered source's current files into blobs and re-points `source_files`, after which the original export trees can be retired safely. Until this runs, those directories remain load-bearing.
- **Bundle**: `blobs/` joins the hub-export set (ticket 08).

This simplifies ticket 05: spoke push = POST session files to `/import`.

## Resolution
