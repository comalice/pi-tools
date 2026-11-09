# Dirac Pi Tools

Standalone Pi package for porting selected tools from Dirac as Pi extensions.

Extensions belong in `extensions/`. Keep the Pi implementations independent
from the Dirac checkout so they can be versioned and installed as a Pi package.

`list_files` preserves recursive breadth-first listing, common generated/vendor
exclusions, modification-time ordering, line counts, and the 200-entry limit.
It omits Dirac's VS Code UI cards, telemetry, multi-root resolution,
`.diracignore` policy, and `.gitignore` filtering. Paths stay within the Pi
working directory and symlinks are not traversed.

`inspect_ast` currently implements the read-only `outline` and `implementation`
operations for JavaScript and TypeScript. It uses `ts-morph`, reports qualified
names, handles ambiguity instead of choosing a symbol arbitrarily, and returns
complete named definitions. Other languages, anchors, call graphs, and the
definitions/references/occurrences operations are not ported yet.

`read_file` reads UTF-8 text and inclusive line ranges. Optional line anchors
remain stable for unchanged lines across reads during one Pi process. Rich
document extraction and anchor persistence across process restarts are not
implemented.

`edit_file` applies non-overlapping anchored replacements and insertions. It
validates IDs and exact line content against current files, presents a diff for
explicit interactive approval, and refuses to write in non-interactive Pi
modes. It uses atomic per-file writes and limits each batch to a reviewable diff.

`search_files` runs ripgrep with optional globs and context. With
`include_anchors`, it shares line IDs with `read_file` and can provide coordinates
directly usable by `edit_file`; matched/context lines that changed during the
search are not emitted as anchors.

Upstream source and license attribution are recorded in `NOTICE`.

Once an extension is added, load this local package with:

```sh
pi install /home/albertlatham/git/dirac-pi-tools
```

Run the focused tests with `npm test`.

## Skills

`code-review` reviews the diff since a fixed point (`/skill:code-review main`)
along three axes — Standards, Spec, and Adversarial Bugs — each in an isolated
headless pi process with a fresh context, reported side by side and never
merged. It runs a tooling pre-pass (lint/typecheck/tests) first, requires a
citation on every finding, refuses to start on a bad ref or empty diff, and
offers to convert repeat findings into pre-commit hooks or
`CODING_STANDARDS.md` rules. Design informed by Matt Pocock's `code-review`
skill (MIT) and Geoff Huntley's writing on engineering away review slop.

`fresh_review` runs up to three independent read-only review tasks in parallel,
each in a fresh Pi process using the active model. Workers have read/grep/find/ls
only, with skills, extensions and MCP disabled; this is a tool allowlist, not an
OS sandbox. Prompts and results consume model tokens. The parent must pin the
scope and verify findings; workers cannot run git or see the parent session.

`documentation-review` audits documentation against code, configuration,
tests, and other evidence without editing it. Use
`/skill:documentation-review README.md` or supply a subsystem or comparison.
`technical-writing` writes or updates documentation for its audience; use `/skill:technical-writing` with
the requested scope. Both use shared, on-demand guidance for different document
types, rather than a separate skill for each type.

See [durable memory](docs/memory.md) for archive ingestion, lexical
and optional local hybrid/vector retrieval, navigable expansion, service setup,
and rebuild limitations. Memory has no automatic recall; the extension keeps
the archive current with a debounced background ingest at session start and
after agent turns, while semantic indexing requires an explicit vector rebuild.

See [language-server notes](docs/language-server-notes.md) for the deferred
semantic-inspection direction.
