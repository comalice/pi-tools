# Durable memory archive

The archive is an **explicitly ingested, local SQLite/FTS5 store** exposed by
`memory_search` and `memory_expand`, with an optional, rebuildable local
vector index for semantic and hybrid retrieval. There is no automatic recall,
reranker, generated summary, or model call from the extension itself.

It can also run as a **hub-and-spoke system**: one machine serves its archive
over HTTP to authenticated spokes, which push their own sessions into it. On
an enrolled spoke, the same two tools answer from the hub exactly as they
would locally.

## How the archive stays current

The extension runs a **debounced background ingest** at `session_start` and
after each `agent_end` — at most one at a time, skipped when the archive was
written within the last 15 minutes — and failures surface as warnings, never
block the session. Semantic indexing is opted into with an explicit first
`vector-build`; after that, a debounced background `vector-refresh` rebuilds
only when services answer, the document set changed, and the active sidecar is
at least 24 hours old. `memory_search` results carry `archive.latest` (the
newest searchable message, excluding the current session) and flag staleness
beyond 24 hours.

## Where the details live

- **Ingestion** — sources, watch vs. import, the blob store, backfill and
  forget, adapter semantics: [`memory-ingestion.md`](memory-ingestion.md)
- **Retrieval** — search modes, fusion, expansion semantics, provenance,
  bounds, the `evaluate` harness: [`memory-retrieval.md`](memory-retrieval.md)
- **Vector index** — local embedder/Qdrant services, builds, refreshes:
  [`memory-vectors.md`](memory-vectors.md)
- **Hub and spokes** — the hub service and its endpoints, token
  administration, two-action onboarding, spoke push:
  [`memory-hub.md`](memory-hub.md)
- **Service deployment** — the Qdrant + embedder container stack:
  [`memory-services.md`](memory-services.md) and
  [`services/memory/compose.yaml`](../services/memory/compose.yaml)
- **Evaluation history** — the local pilots behind the retrieval defaults:
  [`memory-history.md`](memory-history.md)
- The curated wiki corpus that feeds the `wiki` source: [`wiki.md`](wiki.md)

## Requirements, storage, and privacy

Tested with Node **26.8.1**, which provides built-in `node:sqlite` and FTS5.
No additional npm dependency is required. The default archive is
`~/.pi/agent/memory/archive.sqlite`; `PI_CODING_AGENT_DIR` changes the Pi agent
directory. Override the archive with `PI_MEMORY_INDEX` or CLI `--index`.
Archive directories created by this tool are owner-only (0700), and the SQLite
file and semantic sidecar are owner-only (0600). Select a private parent path;
existing parent directories are not chmodded.

Indexed source text is retained in SQLite. Excerpts returned by search/expand
are sent to the active model provider as tool results, so local storage does
not make provider transmission local-only. Embedding requests contain bounded
local archive text and go only to the configured loopback embedder service;
Qdrant stores vectors and reference metadata, never raw message/chunk text.
The extension does not start services or perform indexing in its factory.

## Commands

Run these from the repository root (or via the `pi-memory` shim installed by
`make install-bin`):

```sh
npm run memory -- ingest
npm run memory -- import --source pi ~/archive/session.jsonl
npm run memory -- import --source claude ~/Downloads/claude-export.json
npm run memory -- import --source grok ~/Downloads/grok-export/
npm run memory -- import --backfill
npm run memory -- forget --source pi --session SESSION_ID
npm run memory -- status
npm run memory -- sessions --since 7d
npm run memory -- search --query 'deployment rollback' --cue 'SQLite WAL' --project "$PWD"
npm run memory -- search --query 'prior decision' --all --mode lexical
npm run memory -- expand --id RESULT_ID --project "$PWD" --max-chars 3000
npm run memory -- expand --id RESULT_ID --project "$PWD" --offset 2400 --direction forward
npm run memory -- vector-status
npm run memory -- vector-build
npm run memory -- vector-refresh
npm run memory -- benchmark
npm run memory -- evaluate --cases ~/.pi/agent/memory/retrieval-eval.json
npm run memory -- evaluate --cases ~/.pi/agent/memory/retrieval-eval.json --cosine-floor 0.65
```

Hub and spoke commands (`enroll`, `join`, `push`, `hub-token`, `hub-git-init`)
are documented with the hub in [`memory-hub.md`](memory-hub.md); entity
tooling (`entity-scan`, `entity-dossier`) under
[Entity gazetteer](#entity-gazetteer) below and [`wiki.md`](wiki.md).

## Extension behavior

The extension registers `memory_search` and `memory_expand`. In local mode,
each starts a bounded Node CLI worker lazily per call (30-second process
timeout, 128 KiB output cap), with an absolute script path and no shell
interpolation. The worker makes no model calls. The extension does not change
system prompts or transcript context automatically. If the archive is missing,
tools direct you to run ingestion. Archive paths come from trusted
environment/configuration, not model-supplied paths.

If `~/.pi/agent/memory/hub.json` exists, the same two tools operate in
**remote mode**: requests go to the hub, and no local archive is opened or
ingested. The contract is documented in
[`memory-hub.md`](memory-hub.md#remote-extension-mode).

## Entity gazetteer

`~/.pi/agent/wiki/entities.json` is a git-tracked registry of known entities
(canonical name, type, aliases, status: auto|confirmed|rejected), curated by
editing the file. `npm run memory -- entity-scan` rebuilds the
`entities.sqlite` sidecar beside the archive index (by default
`~/.pi/agent/memory/entities.sqlite`) — aggregated entity mentions across the
whole archive (entity → documents with counts and offsets) via Aho-Corasick
dictionary matching. The sidecar is derived data: safe to delete, rebuilt in
seconds. Matching is case-insensitive with token boundaries that treat `-`
and `_` as token characters, so `MAXL-CL-4070` does not match inside
`MAXL-CL-4070-15`; separator variants (`mcp server` / `mcp_server` /
`mcp-server`) are generated automatically at load time.
