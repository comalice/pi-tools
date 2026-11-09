# Wiki: curated knowledge, dream mode, and the librarian

The wiki is the curated, cross-linked knowledge layer above the [memory
archive](memory.md). The archive holds immutable conversational **evidence**;
the wiki holds **derived knowledge** that cites it. The two are deliberately
different stores of trust: a wiki page asserts, the archive proves.

## Components

- **Wiki substrate** — a git-tracked directory at `$PI_WIKI_DIR` (default
  `~/.pi/agent/wiki`) with `pages/`, `staging/`, and `CONVENTIONS.md`.
  Initialize with `npm run wiki -- init`.
- **Dream mode** (`skills/dream`, `src/dream/`) — a runner enumerates archived
  conversation sessions in a window (`memory sessions --since`) and processes
  each with a deterministic extraction harness: the session is digested into
  ~12k-char transcript chunks, a single-turn model call per chunk returns a
  JSON array of extractions, code validates them (verbatim entry IDs,
  enumerated kinds, bounded counts), and validated extractions are persisted
  to `staging/`. The model never touches tools. The runner resumes after
  interruption, retries failed sessions once, and serves a loopback admin
  console at a per-startup token URL. Design lineage: the state-machine and
  context-budget ideas from `~/git/maelstrom-code`, minimally adapted.
- **Librarian** (`skills/librarian`) — reviews staging, verifies citations
  against the archive, and promotes, merges, updates, or discards. It keeps
  contradictions visible with provenance rather than silently resolving them,
  maintains `[[links]]` in both directions, and commits each run to git.
- **Archive integration** — `memory ingest` indexes `pages/` as source `wiki`;
  pages are searchable via `memory_search` and are exempt from project scope,
  because curated knowledge is cross-project by definition. `staging/` is
  never indexed.

## Page format

Markdown with strict YAML-lite frontmatter (see
`src/wiki/format.ts` and the installed `CONVENTIONS.md`):

```markdown
---
title: SQLite WAL gotchas
slug: sqlite-wal-gotchas
created: 2026-11-01
last_verified: 2026-11-05
tags: sqlite, ops
sources:
- pi:<session-id>:<entry-id>
- doc:0017
---

Body with [[other-slug]] links.

## Sources

- What each source supports, one line each.
```

The filename must be `<slug>.md`; the frontmatter field set is closed; every
claim must trace to the `sources` list. The `## Sources` body section keeps
provenance visible in search excerpts and expansions.

## CLI

```sh
npm run wiki -- init                      # create dirs, CONVENTIONS.md, git init
npm run wiki -- new --title "Page title" [--tags a,b]
npm run wiki -- stage --title T --session ID [--entry E]... < body.md
npm run wiki -- list [--staging]
npm run wiki -- survey                    # librarian pre-pass: verify citations, cluster, suggest dispositions
npm run wiki -- serve [--port 6341]       # read-only web front-end (loopback)
```

`serve` starts a read-only front-end bound to loopback: page index sorted by
verification staleness, rendered pages with clickable `[[links]]` (missing
targets shown as red links), clearly-marked unvetted staging visibility, and a
search bar backed by the memory archive's `wiki` source. The URL carries a
**persistent** unguessable token stored in `<wiki>/.admin-token` (mode 0600,
gitignored), so the bookmark is stable across restarts — unlike the dream
runner's console, whose token rotates per startup; when a dream run is active
the wiki index links to its console automatically. Editing stays in files +
git; the web UI never writes.

`stage` reads the body from stdin and fingerprints by session + entries, so a
retried dream worker overwrites its own staging file instead of duplicating.

## Trust model and feedback-loop guard

Dream output is derived and fallible. It must never re-enter the archive as
conversation evidence: staging lives outside the indexed sources, and only
librarian-curated pages — with verified citations — become searchable. Search
results label wiki rows as `curated wiki`, distinct from `historical evidence`.

This separation is what makes the dream → librarian loop safe to run
repeatedly: the archive only ever contains raw sessions and reviewed pages,
never an agent's unreviewed summary of an agent's summary.

## What this is not (yet)

- No external document intake (doc control with doc numbers, docling
  conversion, PDF/Word/Excel support). That is a parallel track; the `sources`
  field already reserves `doc:<number>` identifiers for it.
- The librarian remains a manually-invoked skill until its output is trusted.
- No devops/skill-extraction agent; dream mode's ops-pattern extractions are
  its intended feedstock.

## Entity autolinking

`npm run wiki -- link-entities` rewrites `pages/*.md`, converting the first
plain-text occurrence of each known entity (from `entities.json`) into
`[[entity:Name|original surface]]` links. It never touches frontmatter,
code, headings, existing links, or URLs, and it is idempotent — run it after
every page edit and after registry changes. LLMs should never hand-write
entity links; the linker owns them. The front-end renders them to
`/<token>/entities/<name>`, which lists every mentioning document with
session deep-links (data from the `entity-scan` sidecar).
