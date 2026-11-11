# Wiki conventions

This wiki is the curated, cross-linked knowledge base maintained by the
librarian agent from dream-mode extractions and external documents. It is
**derived knowledge**, not evidence: every claim must be traceable to a source.

## Layout

- `pages/<slug>.md` — curated pages. One topic per page.
- `staging/` — raw dream-mode extractions awaiting librarian review. Nothing in
  `staging/` is indexed or trusted; the librarian promotes, merges, or discards.
- `CONVENTIONS.md` — this file.

## Page format

```markdown
---
title: Human-readable title
slug: lowercase-hyphenated-slug
created: YYYY-MM-DD
last_verified: YYYY-MM-DD
tags: topic, another-topic
sources:
- pi:<session-id>:<entry-id>
- doc:0017
---

Body in markdown. Link to other pages with [[other-slug]].

## Sources

- What each source supports, one line each, with the same identifiers as the
  frontmatter `sources` list.
```

Rules:

- The filename must be `<slug>.md` and the frontmatter `slug` must match.
- Frontmatter fields are exactly: `title`, `slug`, `created`, `last_verified`,
  `tags`, `sources`. Unknown fields are rejected by the tooling.
- `sources` uses typed identifiers: `pi:<session>:<entry>`,
  `opencode:<session>:<entry>`, `doc:<number>`, `web:<url>`, `wiki:<slug>`.
- Every page carries a `## Sources` body section so provenance is visible in
  search excerpts and expansions, not only in frontmatter.

## Curation rules for the librarian

1. **Never assert what a source does not support.** Every claim traces to a
   frontmatter source. No source, no claim.
2. **Contradictions are kept, not resolved silently.** Record both claims with
   dates and provenance; prefer the newer claim in the summary text but keep
   the older one visible.
3. **`last_verified` changes only when the page's claims were actually checked
   against sources on that date.**
4. **Link generously but honestly.** Add `[[links]]` where a real relationship
   exists, and add the backlink on the target page.
5. **One topic per page.** Split pages that grow past ~400 lines.
6. Staging entries are deleted after they are promoted, merged, or explicitly
   discarded; record the decision in the git commit message.
7. Commit curated changes to git with a message naming the pages touched and
   the staging entries consumed.
8. **Scope machine- and path-specific claims.** Procedures, paths, and
   deployments tied to one machine or working directory must name that
   machine (the archive `origin`) and the folder path in the page body. The
   librarian survey reports `origin` and `project` per citation; a page that
   draws on multiple origins scopes each claim to its source machine.
