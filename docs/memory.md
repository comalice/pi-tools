# Durable memory archive

The archive is an **explicitly ingested, local SQLite/FTS5 store** exposed by
`memory_search` and `memory_expand`. The second milestone adds an optional,
rebuildable local vector index. There is still no automatic recall, reranker,
generated summary, or model call from the extension itself.

To keep the archive current, the extension runs a **debounced background
ingest** at `session_start` and after each `agent_end`: at most one ingest at
a time, skipped when the archive was written within the last 15 minutes, with
a 10-minute worker timeout. Failure surfaces as a warning notification and
never blocks the session. `memory_search` results include the newest
searchable message timestamp (`archive.latest`, excluding the current
session); when it is more than 24 hours old the tool result carries a visible
staleness note. Source reconciliation logic remains the explicit `ingest`
command's. Semantic indexing is opted into by an explicit first `vector-build`;
after that, the extension runs a debounced background `vector-refresh` chained
to the background ingest: it rebuilds the vector index only when services
answer, the archive document set changed since the last build, and the active
sidecar is at least 24 hours old (override with `PI_MEMORY_VECTOR_REFRESH_HOURS`
or `vector-refresh --max-age-hours`). A changed embedder identity or a
missing/broken collection forces a rebuild regardless of age. A successful
refresh deletes the superseded Qdrant generation recorded in the previous
sidecar, so repeated refreshes do not accumulate collections. Refresh failure
surfaces as a warning notification, then backs off for 6 hours; when services
are down the refresh skips quietly.

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

Run these from the repository root:

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

`ingest` reads Pi sessions from `$PI_CODING_AGENT_DIR/sessions` (normally
`~/.pi/agent/sessions`), OpenCode from
`~/.local/share/opencode/opencode.db`, and curated wiki pages from
`$PI_WIKI_DIR/pages` (normally `~/.pi/agent/wiki/pages`; see
[`docs/wiki.md`](wiki.md)). Override with `--pi-sessions DIR`,
`--opencode-db FILE`, or `--wiki-dir DIR`. Missing sources are reported but
are not fatal.

### Watch sources and imported exports

`pi`, `opencode`, and `wiki` normally use watch sources: their registered live
roots are reconciled, so removed source data is pruned on a later ingest (the
wiki repository remains its own canonical store). Claude and Grok exports are
import sources. `memory import --source pi|claude|grok PATH...` copies the
supplied files (or recursively walks supplied directories) into the
archive-owned blob store, registers that store as the source root, and runs the
existing adapter. Pi imports support session JSONL and are used by hub pushes;
once Pi is registered in blob mode, regular ingest follows that blob root
rather than the local live sessions directory. Repeated imports deduplicate by
SHA-256 content hash.

Blobs live under `~/.pi/agent/memory/blobs/<source>/<origin>/` (beside the
default archive). Each file is named
`<sha256-of-bytes>--<sanitized-original-filename>`; the original extension is
retained. `<origin>` uses `PI_MEMORY_ORIGIN` when set, otherwise the machine
hostname, matching entry provenance; values that are not safe path components
are encoded for the directory name. `source_files.file` is the manifest and
points into this tree (Grok manifest keys also retain the adapter's `#session`
suffix). No additional database schema is required. Blob directories/files
are private (0700/0600).

Existing Claude/Grok registrations must be migrated before their original
export roots are retired. Run `memory import --backfill` while those registered
roots still exist. Backfill copies their current files, maps every existing
manifest row to exactly one blob by content hash, rewrites the manifest paths,
and changes each registered root to its blob directory; an ambiguous or
missing content match fails rather than partially rewriting the manifest.
Then run `memory ingest` and verify it reports unchanged files and zero removed
sessions. After a successful backfill, the original export directories are no
longer load-bearing and may be moved or deleted. Future imports add blobs to
the same source store. For import roots, a missing blob is not treated as a
prune; use `memory forget --source pi|claude|grok --session ID` (or
`--file PATH`) to explicitly remove an imported item and its derived archive rows. The forget
command only operates on sources registered in blob-store mode.

Wiki pages are indexed as source `wiki`: one document per page, `session_id`
set to the page slug, `role` set to `page`, `project` set to the constant
`wiki`. Wiki pages are **curated cross-project knowledge**, so project-scoped
search and expansion never exclude them; the `wiki` source filter restricts to
pages only. Malformed pages are skipped and reported in the ingest result's
`errors` list rather than failing the snapshot.

`sessions --since 7d` (or an ISO date) lists conversation sessions with indexed
activity in the window — source, session ID, project, first/last timestamps,
message counts, and the source file where known — most recent first. It exists
for the dream-mode sweep (`skills/dream`) and excludes wiki pages. Ingestion
never writes to source archives. Pi files are parsed independently and read
read-only; incomplete final JSONL records wait for the next complete newline.
Changed complete snapshots are replaced transactionally. Malformed or
unsupported snapshots do not prune valid entries. Deleted files from watch roots (and legacy Claude/Grok roots until backfill)
are removed on the next successful reconciliation. Once Pi/Claude/Grok are in
blob-store mode, pruning is explicit via `memory forget`.

OpenCode's `session`, `message`, and `part` projections are read-only, with
`query_only`, a busy timeout, bounded per-session queries, and bounded message
and session counts. The 6GB-scale event log is not read. OpenCode session-parent
and assistant-message parent references remain distinct. Fork lineage is
unknown; session parent is not treated as message ancestry. Session revert
hides messages after the recorded revert point from default search. A missing
revert boundary is diagnosed and does not replace the prior session snapshot.

The CLI emits one JSON object on stdout. Errors return nonzero status with a
JSON diagnostic. `status` includes counts and semantic-index metadata, never source text; vector
readiness is checked against the saved model identity and live Qdrant
collection/count when services are reachable. Incompatible archive schema
versions are refused rather than overwritten.

## Local vector services and rebuilds

The companion service stack and operating details are maintained separately:
[`services/memory/compose.yaml`](../services/memory/compose.yaml) and
[`docs/memory-services.md`](memory-services.md). The integration accepts only
unauthenticated HTTP on loopback endpoints (`PI_MEMORY_QDRANT_URL`, default
`http://127.0.0.1:6333`; `PI_MEMORY_EMBEDDER_URL`, default
`http://127.0.0.1:6335`) and rejects redirects. This constrains the
integration's destinations; it is not firewall-enforced outbound isolation
for the local services. The embedder `/health` identity includes model and
artifact digest revision; a build/search requires that revision to match. Vectors are 384-dimensional cosine vectors. Embeddings are requested in
batches of at most 32 with request timeouts, cancellation, finite-value and
dimension checks.

`evaluate` compares lexical, semantic, and hybrid search on a private local JSON
fixture containing queries, optional scope/cues, and expected result IDs (not
source excerpts). The fixture must be a regular owner-only file, at most 128
KiB; it is not stored in this repository. Query text is sent only to the
configured loopback embedder. Output contains aggregate hit-rate, reciprocal-rank,
negative false-positive, fallback/error, and latency metrics, plus per-case ranks
and empty-result flags; it omits queries, result IDs, and excerpts. Cases with no expected IDs are treated as negative
queries. `--top-k` controls the measured result window (default 5). An optional
`--cosine-floor` overrides the default for threshold-sensitivity comparisons.

`vector-build` performs a full rebuild from a consistent read-only SQLite
snapshot. Chunks target 1400 UTF-16 code units with 200 code units of overlap;
chunk offsets and hashes refer to the complete indexed message. Boundaries do
not split UTF-16 surrogate pairs. The embedder's contract truncates inputs at
512 tokens; character-based chunking does not guarantee a token-exact fit, so
some unusually token-dense chunks may be truncated by the model. The synthetic
`benchmark` command reports local health-request latency and repeated query and
passage embedding throughput (it does not start the service). It makes no
retrieval-quality claim and uses only built-in synthetic strings.

Each build uses a namespace derived from the canonical archive path and a new
versioned Qdrant collection. It verifies the exact point count before atomically
publishing `${index}.semantic.json` (private mode 0600); an incomplete build is
never selected. The previous collection is left in place and no Qdrant volume or
unknown collection is erased. Repeated builds currently retain old generations;
remove old known generations manually only after verifying which collection is
active. Sidecar settings contain local endpoints, model identity, collection,
and build metadata, but no credentials and do not alter Pi user settings.

Ingestion does not synchronize vector collections. Existing vectors are
checked against the current SQLite document content hash when dereferenced, so
stale/deleted vectors are ignored. Run `vector-build` (or let the background
`vector-refresh` run) after ingest to index new or changed messages. A full
rebuild is required; there is no incremental vector update. `vector-refresh`
deletes exactly the superseded generation named by the previous sidecar after a
successful rebuild; older generations from manual `vector-build` runs are still
retained and removed manually only after verifying which collection is active.

## Retrieval and provenance

Search modes are `lexical`, `hybrid`, `semantic`, and `auto` (default). Lexical
works without vector configuration or running services. `auto` uses hybrid when
a valid sidecar exists and otherwise uses lexical. Hybrid falls back to lexical
if local services are unavailable or their identity differs, with explicit
`retrieval.status: "fallback"` and a warning; it never labels that fallback
semantic. `semantic` fails clearly when no valid local index/services exist.
Force lexical for comparison. The default cosine floor is **0.75**, a visible,
configurable conservative filter (`--cosine-floor`). It was sanity-checked against
a small synthetic real-model query set, not calibrated broadly, and is not a
general quality threshold. A private 11-case local pilot (9 known positives, 2
checked negatives) found that lexical and hybrid each recovered 6/9 positives
in the top five; semantic-only recovered 1/9 at the default 0.75 floor. Lowering
the floor to 0.65 raised semantic-only recall to 3/9 but returned an unrelated
result for one negative; at 0.50 it returned results for both negatives. An
intermediate 0.70 sweep found 3/9 semantic positives with no results for the two
negatives; at 0.68 it retained those positives but returned a candidate for one
negative. At 0.70 hybrid stayed at 6/9 but MRR fell from 0.593 to 0.467. Hybrid
did not recover any of the three deliberately lexical-hard positives. A
post-hoc lexical gate requiring six distinct query-term hits removed the one
lexical negative but also reduced positive recall from 6/9 to 5/9, so no gate was
added. This small, selected set is diagnostic—not a general benchmark or basis
for automatic recall.

Full-corpus local cosine comparisons used the same 17,652 chunks and did not
justify replacing the active index. `snowflake/snowflake-arctic-embed-s` hit 1/9
positives at 0.75 and 2/9 at 0.65, while returning candidates for both negatives
at each floor. `BAAI/bge-base-en-v1.5` hit 0/9 at 0.75 and 3/9 at 0.65 with no
negative candidates; at 0.50 it remained at 3/9 and returned a candidate for one
negative. BGE-base is 768-dimensional and its full local evaluation took about
54 minutes.

A local audit of the current BGE-small ANN results found expected-message recall
of 3/9 at five, 4/9 at 20, 7/9 at 50 and 100, and 8/9 in the top 1,000 returned
vector points after message deduplication (approximate Qdrant ranks, no cosine
floor). Of the three lexical-hard positives, two were present at unique-message
ranks 28 and 141 with best chunk cosines 0.663 and 0.683. The rank-28 target's
best chunk is at vector-point 39, but it falls beyond the 20-message output
limit; the rank-141 target is at point 159, beyond the current 40-point fetch.
The third was absent from the returned top 1,000, with best target-chunk cosine
0.622. None of the expected
target-message chunks exceeded BGE-small's 512-token truncation limit (maximum
observed: 399 tokens). This rules out truncation for these labeled messages, but
not a mismatch between the expected answer span and its best-scoring chunk.

A provisional local reranker trial used `Xenova/ms-marco-MiniLM-L-6-v2` on the
union of the top 20 lexical excerpts and the top 50, 100, or 200 unfiltered
Qdrant chunk points. Message-level candidate recall was 7/9 at pools 50/100 and
8/9 at 200. Reranked hit@5 was 6/9 at pools 50/100 and 7/9 at 200, but MRR at
200 was 0.565 versus 0.593 for current hybrid; the new hit was the rank-141
candidate promoted to rank 4. The target absent from the top 1,000 remained
absent. This uses expected message IDs as a proxy, not human-judged answer spans,
so it is not sufficient to adopt the reranker. Weights were fetched separately;
the evaluation itself ran with networking disabled.

Retrieval uses reciprocal-rank fusion rather than adding BM25 and cosine scores,
with distinct cue coverage and parent-message deduplication. Treat embedding-only
matches as exploratory until they perform better on a wider set of paraphrased
recall questions. Each result has historical provenance and a match-centered
snippet with UTF-16 `snippet_start`/`snippet_end` offsets into the indexed
message. Vector results use their matching chunk as the excerpt. No raw source
text or vector payload dump is returned.

Search requires a project filter unless `--all` is explicit. Source, session,
project, and current-session exclusions are applied to lexical lookup and to
vector metadata filters; they are checked again against SQLite before returning
a vector result. Candidate counts and elapsed time are diagnostic metadata.
There is no neural reranker or automatic recall.

Expansion supports `--max-chars`, `--offset`, and `--direction`; the tool uses
`maxChars`, `offset`, and `direction` with the same bounds/meaning. The selected
message is kept ahead of context under the bounded output budget. Long target
messages return `nextOffset` and truncation metadata so callers can page through
the message without splitting UTF-16 surrogate pairs. If following replies do
not fit, expansion returns `nextResultId` so the caller can expand that reply as
a separate result. Default expansion retains preceding context. Explicit
forward Pi traversal follows a unique child chain, including non-indexed metadata nodes; at
a fork it stops and returns bounded branch choices with IDs. A supplied
`--branch-id` / `branchId` must be a descendant in that exact session and is
validated again on each page. No sibling is silently selected. Optional
following replies are included only when requested with forward/both direction
and remaining budget permits. OpenCode expansion is chronological within a
session; its fork lineage is unknown, and Pi parent traversal semantics are not
claimed for it. Traversal limits count metadata nodes as well as indexed text.

Search and expansion identify results as **historical evidence**, not current
instructions. Tool results use `origin: durable-memory` and `indexable: false`
to avoid re-ingestion as conversation evidence.

Pi ingestion supports version-3 JSONL only. It preserves entry IDs and parent
edges, including non-indexed metadata. It indexes original user/assistant text
blocks only; thinking, system, tool output, custom entries, and other
non-text blocks are excluded. Pi file ingestion sees the persisted tree, not an
unsaved live leaf selection. OpenCode imports eligible text parts only. Its
current importer performs bounded per-session reconciliation instead of
incremental event-sequence sync.

## Extension behavior and limitations

The extension registers `memory_search` and `memory_expand`. Each starts a
bounded Node CLI worker lazily per call (30-second process timeout, 128 KiB
output cap), with an absolute script path and no shell interpolation. The
worker makes no model calls. The extension does not change system prompts or
transcript context automatically. If the archive is missing, tools direct you
to run ingestion. Archive paths come from trusted environment/configuration,
not model-supplied paths.

Other bounds: search returns at most 20 messages, cues at most 8, query at most
1000 characters, and normalized messages at most 100,000 characters. Pi files
are capped at 256 MiB and lines at 4 MiB. OpenCode is bounded to 50,000
messages per session, 100,000 sessions, and 1,000 parts per message. OpenCode
uses full bounded session reconciliation. Source roots are bound to their first
configured path in an archive; use a separate archive to intentionally switch
source locations. Pi scans reject symlinks and abort rather than interpreting
walk/read errors as deletions.

## Entity gazetteer

`~/.pi/agent/wiki/entities.json` is a git-tracked registry of known entities
(canonical name, type, aliases, status: auto|confirmed|rejected). It was
seeded by a GLiNER NER pass over the archive and is curated by editing the
file. `npm run memory -- entity-scan` rebuilds
`~/.pi/agent/memory/entities.sqlite` — aggregated entity mentions across the
whole archive (entity → documents with counts and offsets) via Aho-Corasick
dictionary matching. The sidecar is derived data: safe to delete, rebuilt in
seconds. Matching is case-insensitive with token boundaries that treat `-`
and `_` as token characters, so `MAXL-CL-4070` does not match inside
`MAXL-CL-4070-15`; separator variants (`mcp server` / `mcp_server` /
`mcp-server`) are generated automatically at load time.

## Remote memory hub

`pi-memory-hub` serves the archive to authenticated remote spokes and accepts
pushed Pi sessions. It uses plain `node:http`, Bearer authentication, and JSON
responses. The endpoints are:

- `GET /status` — service version, archive schema, per-source session counts,
  uptime in seconds, and the calling token's spoke identity.
- `POST /search` — JSON fields `query`, optional `cues`, `limit` (1–10),
  `mode`, `cosineFloor`, `source`, `session`, `scope`, and optional `project`.
  Response fields match local memory search (`results`, `retrieval`, and
  `archive.latest`). When both `scope` and `project` are absent, hub search
  defaults to `all`; use `scope: "project"` with the archive's project value
  to restrict results. Semantic/hybrid retrieval uses the hub's configured
  vector services just like local retrieval.
- `POST /expand` — JSON fields `id`, optional `source`, `scope`, `project`,
  `maxChars`, `offset`, `direction`, `branchId`, and `includeReplies`; returns
  the local expansion result shape.
- `POST /ingest` — JSON `{ "source": "pi", "filename": "session.jsonl",
  "content_base64": "..." }`. It stores the payload as a content-addressed
  blob and ingests it with the authenticated spoke name as its origin. Pushes
  are serialized in-process. OpenCode push is not supported.

The hub binds to `127.0.0.1:6342` by default. Configure `PI_HUB_BIND` /
`PI_HUB_PORT` or `--bind` / `--port`; `resolveBindAddress` accepts only literal
IPv4/IPv6 addresses. Do not expose the plain-HTTP listener directly to an
untrusted network: use a trusted private network or a TLS-terminating reverse
proxy, and protect the bearer token as a credential. Search and expansion can
return archived conversation text to any holder of a valid spoke token.

Tokens are administered only on the hub host with the local memory CLI:

```sh
npm run memory -- hub-token add laptop
npm run memory -- hub-token list
npm run memory -- hub-token revoke laptop
```

`add` prints the generated token once; `list` prints spoke names and creation
times only. There is one active token per spoke; revoke before re-adding. The
private token map is `~/.pi/agent/memory/hub-tokens.json` (or beneath
`PI_CODING_AGENT_DIR`), mode 0600. Revocation takes effect on the next request.
Tokens are never managed over HTTP.

Install the user service alongside the other units with `make install-systemd`;
it is enabled immediately. Override its bind and port at install time, for
example `make install-systemd PI_HUB_BIND=0.0.0.0 PI_HUB_PORT=6342`. The service
uses the normal writable archive opener at startup, applying supported schema
migrations before opening a separate exact-schema read-only connection for
search/expand. It creates an empty archive if none exists; the first successful
push registers Pi as an import-backed blob source. Once that happens, regular
`memory ingest` reconciles the registered blob root rather than the local live
sessions directory. Imported Pi blobs are retained until explicitly forgotten;
normal watch-source pruning semantics remain unchanged for live session roots.
