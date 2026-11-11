---
name: librarian
description: "Curate the wiki: review dream-mode staging entries, promote or merge them into cross-linked pages, keep contradictions visible with provenance, update links both directions, and commit. Use when the user asks to run the librarian, curate the wiki, or process staging."
---

The librarian turns raw dream-mode extractions into the curated, cross-linked
wiki. You are the judgment layer; dream mode was the recall layer. The wiki's
value is that everything in it is traceable — guard that.

The wiki root is `$PI_WIKI_DIR` (default `~/.pi/agent/wiki`). Read its
`CONVENTIONS.md` first and follow it exactly; the rules below summarize, the
conventions file governs. The wiki CLI is
`node --experimental-strip-types <repo>/src/wiki/cli.ts` (`<repo>` is this
skill's repository root: two levels up from this file).

## Process

### 1. Survey (deterministic — never do this by hand)

```sh
node --experimental-strip-types <repo>/src/wiki/cli.ts survey
```

(`<repo>` is this skill's repository root: two levels up from this file.) The
survey verifies every citation against the memory archive, clusters entries by
shared session and title overlap, detects collisions with existing pages, and
suggests dispositions. **Trust its mechanics**: citations it reports broken are
broken — do not re-verify them by hand, and do not rescue an entry whose
citations do not resolve. If the underlying topic matters, the fix is
re-extracting the source session through the dream harness, not rehabilitating
the entry.

If staging is empty, say so and stop. Process at most **50** staging entries
per run; report any remainder.

### 2. Plan, then wait for confirmation

Before touching any file, present the disposition plan: every staging entry
marked promote / merge / update / discard, with its target page and one line
of rationale. **Wait for the user's approval before executing.** Only skip the
gate if the user has previously told you to run unattended.

### 3. Execute the dispositions

For each staging entry, choose exactly one disposition:

- **Promote** — new topic, well-supported: create a page (`wiki new`), fold the
  extraction in, keep the cited sources. Merging is the default posture:
  justify a new page rather than justify a merge.
- **Merge** — an existing page covers the topic, or the survey clustered the
  entry with siblings from the same session: integrate the material into one
  page, adding the staging entry's sources.
- **Update** — the extraction contradicts or supersedes an existing page:
  record both claims with dates and provenance. Prefer the newer claim in the
  summary text; keep the older claim visibly marked with its date and source.
  Never silently rewrite history.
- **Discard** — broken citations, unsupported, redundant, or ephemeral: delete
  the staging file and record the reason in the commit message.

The survey verifies citation *existence*; you verify citation *adequacy* for
claims you are unsure about, using `memory_expand` or the raw session file.
The survey also reports each citation's `origin` (machine) and `project`
(working directory): when material is specific to a machine, path, or
deployment — procedures, file locations, local configuration — the page must
name that machine and folder in the body, and a page drawing on multiple
origins scopes each claim to its source machine.
Normalize tags toward a small controlled vocabulary (`decision`, `fact`,
`process`, `gotcha`, `ops-pattern` plus topic tags) — staging tags are noisy.

### 4. Cross-link

For every page you create or materially edit, add `[[links]]` to genuinely
related pages, and add the backlink on the target page. A link asserts a real
relationship — if you cannot say what it is, do not link.

### 5. Dates

Set `last_verified` to today **only** on pages whose claims you actually
checked against sources in this run. Merging new material into a page counts;
fixing a typo does not.

### 6. Commit

One commit per run:

```sh
git -C "$PI_WIKI_DIR" add -A
git -C "$PI_WIKI_DIR" commit -m "curate: <pages touched>; consumed staging: <entries>; discarded: <entries + reasons>"
```

Delete staging files for every consumed or discarded entry — staging must
drain to empty or be explicitly reported as deferred.

### 7. Refresh the archive

Curated pages become searchable through the memory archive's `wiki` source
after the next ingest (it runs in the background, debounced). Tell the user if
you want it immediate: `node --experimental-strip-types <repo>/src/memory/cli.ts ingest`.

## Hard rules

- No claim without a source in the page's frontmatter `sources` list. If you
  know something true that has no source, that knowledge does not go in the
  wiki until a source exists.
- Never edit `staging/` files except to delete them after a decision.
- Never write secrets into pages; redact and warn if a staging entry contains
  one.
- Pages are prose for future agents and humans: dense, specific, dated. No
  filler, no "this page is about".
