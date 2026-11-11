# Memory vectors: local services, builds, and refreshes

The optional semantic index. Root doc: [`memory.md`](memory.md). Deployment of
the service stack itself: [`memory-services.md`](memory-services.md) and
[`services/memory/compose.yaml`](../services/memory/compose.yaml).

## Services

The integration accepts only unauthenticated HTTP on loopback endpoints
(`PI_MEMORY_QDRANT_URL`, default `http://127.0.0.1:6333`;
`PI_MEMORY_EMBEDDER_URL`, default `http://127.0.0.1:6335`) and rejects
redirects. This constrains the integration's destinations; it is not
firewall-enforced outbound isolation for the local services. The embedder
`/health` identity includes model and artifact digest revision; a build/search
requires that revision to match. Vectors are 384-dimensional cosine vectors.
Embeddings are requested in batches of at most 32 with request timeouts,
cancellation, finite-value and dimension checks.

## Builds

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

## Refreshes

Semantic indexing is opted into by an explicit first `vector-build`; after
that, the extension runs a debounced background `vector-refresh` chained to the
background ingest: it rebuilds the vector index only when services answer, the
archive document set changed since the last build, and the active sidecar is at
least 24 hours old (override with `PI_MEMORY_VECTOR_REFRESH_HOURS` or
`vector-refresh --max-age-hours`). A changed embedder identity or a
missing/broken collection forces a rebuild regardless of age. Refresh failure
surfaces as a warning notification, then backs off for 6 hours; when services
are down the refresh skips quietly.

Ingestion does not synchronize vector collections. Existing vectors are
checked against the current SQLite document content hash when dereferenced, so
stale/deleted vectors are ignored. Run `vector-build` (or let the background
`vector-refresh` run) after ingest to index new or changed messages. A full
rebuild is required; there is no incremental vector update. `vector-refresh`
deletes exactly the superseded generation named by the previous sidecar after a
successful rebuild — repeated refreshes do not accumulate collections; older
generations from manual `vector-build` runs are still
retained and removed manually only after verifying which collection is active.
