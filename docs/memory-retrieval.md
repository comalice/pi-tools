# Memory retrieval: search, expansion, and provenance

How data comes back out. Root doc: [`memory.md`](memory.md). Why the defaults
are what they are: [`memory-history.md`](memory-history.md).

## Search modes

Search modes are `lexical`, `hybrid`, `semantic`, and `auto` (default). Lexical
works without vector configuration or running services. `auto` uses hybrid when
a valid sidecar exists and otherwise uses lexical. Hybrid falls back to lexical
if local services are unavailable or their identity differs, with explicit
`retrieval.status: "fallback"` and a warning; it never labels that fallback
semantic. `semantic` fails clearly when no valid local index/services exist.
Force lexical for comparison. The default cosine floor is **0.75**, a visible,
configurable conservative filter (`--cosine-floor`). It was sanity-checked against
a small synthetic real-model query set, not calibrated broadly, and is not a
general quality threshold.

The defaults encode what local evaluation showed: semantic-only retrieval was
weak at conservative floors, and the evaluated alternatives — different
embedders, a lexical gate, a neural reranker — did not justify changing the
design. That is why hybrid fusion is the default when vectors exist, why
embedding-only matches should be treated as exploratory, and why no reranker
ships. The evaluation narratives are preserved in
[`memory-history.md`](memory-history.md).

Retrieval uses reciprocal-rank fusion rather than adding BM25 and cosine scores,
with distinct cue coverage and parent-message deduplication. Each result has
historical provenance and a match-centered
snippet with UTF-16 `snippet_start`/`snippet_end` offsets into the indexed
message. Vector results use their matching chunk as the excerpt. No raw source
text or vector payload dump is returned.

Search requires a project filter unless `--all` is explicit. Source, session,
project, and current-session exclusions are applied to lexical lookup and to
vector metadata filters; they are checked again against SQLite before returning
a vector result. Candidate counts and elapsed time are diagnostic metadata.

## Expansion

Expansion supports `--max-chars`, `--offset`, and `--direction`; the tool uses
`maxChars`, `offset`, and `direction` with the same bounds/meaning. The selected
message is kept ahead of context under the bounded output budget. Long target
messages return `nextOffset` and truncation metadata so callers can page through
the message without splitting UTF-16 surrogate pairs. If following replies do
not fit, expansion returns `nextResultId` so the caller can expand that reply as
a separate result. Default expansion retains preceding context. Explicit
forward Pi traversal follows a unique child chain, including non-indexed
metadata nodes; at a fork it stops and returns bounded branch choices with
IDs. A supplied
`--branch-id` / `branchId` must be a descendant in that exact session and is
validated again on each page. No sibling is silently selected. Optional
following replies are included only when requested with forward/both direction
and remaining budget permits. OpenCode expansion is chronological within a
session; its fork lineage is unknown, and Pi parent traversal semantics are not
claimed for it. Traversal limits count metadata nodes as well as indexed text.

Search and expansion identify results as **historical evidence**, not current
instructions. Tool results use `origin: durable-memory` and `indexable: false`
to avoid re-ingestion as conversation evidence.

## Bounds

Search returns at most 20 messages, cues at most 8, query at most 1000
characters, and normalized messages at most 100,000 characters.

## Measuring retrieval

`evaluate` compares lexical, semantic, and hybrid search on a private local JSON
fixture containing queries, optional scope/cues, and expected result IDs (not
source excerpts). The fixture must be a regular owner-only file, at most 128
KiB; it is not stored in this repository. Query text is sent only to the
configured loopback embedder. Output contains aggregate hit-rate,
reciprocal-rank, negative false-positive, fallback/error, and latency metrics,
plus per-case ranks and empty-result flags; it omits queries, result IDs, and
excerpts. Cases with no expected IDs are treated as negative
queries. `--top-k` controls the measured result window (default 5). An optional
`--cosine-floor` overrides the default for threshold-sensitivity comparisons.
