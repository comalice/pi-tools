# Memory ingestion: sources, blobs, and reconciliation

How data enters the archive. Root doc: [`memory.md`](memory.md). Ingestion
triggered by hub pushes is covered in [`memory-hub.md`](memory-hub.md).

## Sources

`ingest` reads Pi sessions from `$PI_CODING_AGENT_DIR/sessions` (normally
`~/.pi/agent/sessions`), OpenCode from
`~/.local/share/opencode/opencode.db`, and curated wiki pages from
`$PI_WIKI_DIR/pages` (normally `~/.pi/agent/wiki/pages`; see
[`docs/wiki.md`](wiki.md)). Override with `--pi-sessions DIR`,
`--opencode-db FILE`, or `--wiki-dir DIR`. Missing sources are reported but
are not fatal.

## Background ingest

To keep the archive current, the extension runs a debounced background ingest
at `session_start` and after each `agent_end`: at most one ingest at a time,
skipped when the archive was written within the last 15 minutes, with a
10-minute worker timeout. Failure surfaces as a warning notification and never
blocks the session. Source reconciliation logic remains the explicit `ingest`
command's. On a spoke (a machine with `memory/hub.json`), the background
ingest is skipped — the hub owns the archive.

## Watch sources and imported exports

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

Existing watch registrations (Claude, Grok, and — on hubs that predate the
spoke-push receiver — Pi) must be migrated before hub pushes or further
imports can proceed: the push receiver imports through blobs and refuses
watch-registered sources. Run `memory import --backfill` while those registered
roots still exist. Backfill copies their current files, maps every existing
manifest row to exactly one blob by content hash, rewrites the manifest paths,
and changes each registered root to its blob directory; an ambiguous or
missing content match fails rather than partially rewriting the manifest.
Then run `memory ingest` and verify it reports unchanged files and zero removed
sessions. After a successful backfill, the original export directories are no
longer load-bearing and may be moved or deleted. Future imports add blobs to
the same source store. For import roots, a missing blob is not treated as a
prune; use `memory forget --source pi|claude|grok --session ID` (or
`--file PATH`) to explicitly remove an imported item and its derived archive
rows. The forget command only operates on sources registered in blob-store
mode. On a hub whose Pi source is backfilled to blob mode, the hub's own
sessions no longer arrive via plain `ingest`; the `pi-memory-ingest` unit
imports them first (`memory import --source pi ~/.pi/agent/sessions`) before
reconciling the remaining watch sources.

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
unsupported snapshots do not prune valid entries. Deleted files from watch
roots (and legacy Claude/Grok roots until backfill)
are removed on the next successful reconciliation. Once Pi/Claude/Grok are in
blob-store mode, pruning is explicit via `memory forget`.

OpenCode's `session`, `message`, and `part` projections are read-only, with
`query_only`, a busy timeout, bounded per-session queries, and bounded message
and session counts. The 6GB-scale event log is not read. OpenCode session-parent
and assistant-message parent references remain distinct. Fork lineage is
unknown; session parent is not treated as message ancestry. Session revert
hides messages after the recorded revert point from default search. A missing
revert boundary is diagnosed and does not replace the prior session snapshot.

## Adapter semantics

Pi ingestion supports version-3 JSONL only. It preserves entry IDs and parent
edges, including non-indexed metadata. It indexes original user/assistant text
blocks only; thinking, system, tool output, custom entries, and other
non-text blocks are excluded. Pi file ingestion sees the persisted tree, not an
unsaved live leaf selection. OpenCode imports eligible text parts only. Its
importer performs bounded per-session reconciliation rather than incremental
event-sequence sync.

## Bounds

Pi files are capped at 256 MiB and lines at 4 MiB. OpenCode is bounded to
50,000 messages per session, 100,000 sessions, and 1,000 parts per message, and
uses full bounded session reconciliation. Source roots are bound to their
first configured path in an archive; use a separate archive to intentionally
switch source locations. Pi scans reject symlinks and abort rather than
interpreting walk/read errors as deletions.

## CLI contract

The CLI emits one JSON object on stdout. Errors return nonzero status with a
JSON diagnostic. `status` includes counts and semantic-index metadata, never
source text; vector readiness is checked against the saved model identity and
live Qdrant collection/count when services are reachable. Incompatible archive
schema versions are refused rather than overwritten.
