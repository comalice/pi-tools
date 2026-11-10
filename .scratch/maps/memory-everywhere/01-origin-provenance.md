# Origin provenance column

**Type:** task
**Status:** closed
**Blocked by:** None

## Question

Add an `origin` column (spoke hostname) to the archive's entries, captured at ingest; thread it through the store, the search/expand surfaces (extension output, admin console, wiki server), and the dream/librarian provenance views. Migration path for the existing 2M-entry archive (default origin = this host). Ids unchanged: `pi:<session>:<entry>` stays globally unique.

## Resolution

Schema v3: `entries.origin` added; transactional `ALTER TABLE` migration defaults existing rows to this host's hostname; fresh databases get the column in DDL. Origin is captured at ingest with precedence explicit `origin` option > `PI_MEMORY_ORIGIN` env > `os.hostname()`; validated 1-255 chars. All five ingest adapters (`pi`, `opencode`, `claude`, `grok`, `wiki`) accept the option — grok threaded when this work was rebased onto the grok adapter. Surfaced in `memory_search`/`memory_expand` output, the wiki server, the dream admin console (new origin column), and the survey. Policy decision: sessions that don't change on a re-ingest keep the origin captured at their original ingest (origin records where the ingest ran, not where the source files happen to sit now). Provenance ids unchanged: `pi:<session>:<entry>`.
