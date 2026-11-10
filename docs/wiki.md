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
npm run wiki -- serve [--port 6341] [--bind ADDR]  # read-only web front-end (loopback by default)
```

`serve` starts a read-only front-end bound to `127.0.0.1` by default. Set
`PI_WIKI_BIND` or pass `--bind <addr>` to select an IPv4 or IPv6 address; the
flag takes precedence over the environment variable. For example, to bind a
Nebula interface at `100.64.12.34`, run `npm run wiki -- serve --bind
100.64.12.34` (or set `PI_WIKI_BIND=100.64.12.34`). The application treats
this as an ordinary address and has no overlay-network dependency.

The loopback default is a security boundary: the wiki and dream consoles have
no transport encryption, and their unguessable URL tokens are bearer secrets.
Binding a non-loopback address makes the console reachable from that network;
use only a trusted interface/network and protect the token URLs. The wiki URL
carries a **persistent** unguessable token stored in `<wiki>/.admin-token`
(mode 0600, gitignored), so the bookmark is stable across restarts — unlike the
dream runner's console, whose token rotates per startup; when a dream run is
active the wiki index links to its console automatically. Editing stays in
files + git; the web UI never writes. The dream admin console also defaults to
loopback and accepts `--bind <addr>` or `PI_DREAM_ADMIN_BIND`; for example,
`npm run dream -- --bind 100.64.12.34` binds it to that overlay address. The
same trusted-network warning applies.

The systemd template defaults to loopback. To deploy the wiki on an overlay
address, substitute the address when installing the unit:

```sh
make install-systemd PI_WIKI_BIND=100.64.12.34
```

If the interface is brought up by a service that needs ordering, add that
machine-specific dependency as a user-unit drop-in rather than coupling the
repository unit to one overlay client:

```ini
# ~/.config/systemd/user/pi-wiki-serve.service.d/overlay.conf
[Unit]
After=dnclient.service
```

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

## Entity dossiers

`npm run memory -- entity-dossier --entity "Name" [--rebuild] [--max-docs N]`
(or `--top N`) maintains derived per-entity dossiers in `wiki/dossiers/`
(git-ignored, never indexed, never hand-edited). An update run feeds the
worker only mention documents newer than the entity's watermark; every
existing fragment must be explicitly kept/amended/retired/merged, so nothing
is lost silently; retired fragments are logged. Citations validate against
the entity's mention set (DOC ids, truncated ids, and hallucinated ids are
normalized or stripped; unverifiable fragments are dropped). Dossiers may
split into refinement pages (hub + suffixes, Wikipedia-style). Tempo: manual
for now; when scheduled, run weekly after the dream timer, watermark-gated
per entity. Model: `PI_DOSSIER_MODEL` (default `gladiator/gpt-oss-120b`;
nemotron-3-super hangs on dossier prompts).

## Canonical links and session summaries

`src/wiki/links.ts` is the single component that renders canonical
references (typed sources, entities, sessions) as links — used by page meta
tables, mention tables, and dossier citations. Session labels come from
`~/.pi/agent/memory/session-summaries.json`, a durable store of AI-generated
one-line summaries (may be inaccurate; session id and dates are always in
the link title). Regenerate/extend with
`npm run memory -- session-summaries [--limit N] [--rebuild]`; it covers
sessions cited by wiki pages and present in the entity mention sidecar.
Tags on wiki pages link to `/tags/<tag>`, which mirrors the entity-page
format.

## Interlinking

Pages interlink three ways, by editorial cost. **See also sections**
(curated; `[[page:slug|title]]` wikilinks) carry judged relations — they are
navigation, never provenance, and never enter frontmatter `sources`.
**`wiki link-pages`** mechanically links prose mentions of page titles/slugs
(zone-aware, first occurrence, no self-links); run it after edits like
`link-entities`. Dangling `[[page:...]]` links are kept and render red as a
discovery queue. The server shows a "linked from" backlink rail per page.
Wiki search results (`memory_search`, all retrieval modes) carry
`page_links` and `linked_from`, so agents can traverse the graph from any
hit. Relation scoring for bootstrap/suggestions: 3x shared cited sessions +
2x shared rare entities (linked by <= 4 pages) + topical tags only — status
tags (fact/gotcha/decision/process) and common entities carry no signal.
