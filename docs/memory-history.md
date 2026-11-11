# Memory retrieval: evaluation history

Development history for [`docs/memory.md`](memory.md). The evaluations below
are point-in-time diagnostics run against a small private local fixture (11
cases: 9 known positives, 2 checked negatives — not stored in this repository).
They explain *why* the current retrieval design looks the way it does; they are
not benchmarks, not general quality claims, and not a basis for automatic
recall. Current behavior is documented in memory.md and the subsystem docs it
links to; this file preserves how that behavior was chosen.

## Vector index milestones

The archive began as an explicit SQLite/FTS5 store with lexical search only.
The second milestone added the optional, rebuildable local vector index
(384-dim BGE-small via a loopback FastEmbed service, Qdrant storage). A neural
reranker was evaluated and rejected (below); none is deployed.

## The 11-case pilot (cosine-floor and mode selection)

A private 11-case local pilot (9 known positives, 2 checked negatives) found
that lexical and hybrid each recovered 6/9 positives in the top five;
semantic-only recovered 1/9 at the default 0.75 floor. Lowering the floor to
0.65 raised semantic-only recall to 3/9 but returned an unrelated result for
one negative; at 0.50 it returned results for both negatives. An intermediate
0.70 sweep found 3/9 semantic positives with no results for the two negatives;
at 0.68 it retained those positives but returned a candidate for one negative.
At 0.70 hybrid stayed at 6/9 but MRR fell from 0.593 to 0.467. Hybrid did not
recover any of the three deliberately lexical-hard positives. A post-hoc
lexical gate requiring six distinct query-term hits removed the one lexical
negative but also reduced positive recall from 6/9 to 5/9, so no gate was
added. The 0.75 floor was sanity-checked against a small synthetic real-model
query set, not calibrated broadly — it ships as a visible, configurable
conservative default, not a general quality threshold.

## Full-corpus model comparisons

Full-corpus local cosine comparisons used the same 17,652 chunks and did not
justify replacing the active index. `snowflake/snowflake-arctic-embed-s` hit
1/9 positives at 0.75 and 2/9 at 0.65, while returning candidates for both
negatives at each floor. `BAAI/bge-base-en-v1.5` hit 0/9 at 0.75 and 3/9 at
0.65 with no negative candidates; at 0.50 it remained at 3/9 and returned a
candidate for one negative. BGE-base is 768-dimensional and its full local
evaluation took about 54 minutes. BGE-small remained the active model.

## BGE-small ANN recall audit

A local audit of the BGE-small ANN results found expected-message recall of
3/9 at five, 4/9 at 20, 7/9 at 50 and 100, and 8/9 in the top 1,000 returned
vector points after message deduplication (approximate Qdrant ranks, no cosine
floor). Of the three lexical-hard positives, two were present at
unique-message ranks 28 and 141 with best chunk cosines 0.663 and 0.683. The
rank-28 target's best chunk is at vector-point 39, but it falls beyond the
20-message output limit; the rank-141 target is at point 159, beyond the
40-point fetch. The third was absent from the returned top 1,000, with best
target-chunk cosine 0.622. None of the expected target-message chunks exceeded
BGE-small's 512-token truncation limit (maximum observed: 399 tokens). This
ruled out truncation for these labeled messages, but not a mismatch between
the expected answer span and its best-scoring chunk.

## Reranker trial (rejected)

A provisional local reranker trial used `Xenova/ms-marco-MiniLM-L-6-v2` on the
union of the top 20 lexical excerpts and the top 50, 100, or 200 unfiltered
Qdrant chunk points. Message-level candidate recall was 7/9 at pools 50/100
and 8/9 at 200. Reranked hit@5 was 6/9 at pools 50/100 and 7/9 at 200, but MRR
at 200 was 0.565 versus 0.593 for the existing hybrid; the new hit was the
rank-141 candidate promoted to rank 4. The target absent from the top 1,000
remained absent. The trial used expected message IDs as a proxy, not
human-judged answer spans, so it was not sufficient to adopt the reranker.
Weights were fetched separately; the evaluation itself ran with networking
disabled.

## Entity registry seeding

`~/.pi/agent/wiki/entities.json` (the gazetteer behind `entity-scan` and
`entity-dossier`) was seeded by a GLiNER NER pass over the archive. It has
been curated by hand since; the seeding method is history, not a pipeline that
re-runs.
