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

Upstream source and license attribution are recorded in `NOTICE`.

Once an extension is added, load this local package with:

```sh
pi install /home/albertlatham/git/dirac-pi-tools
```

Run the focused tests with `npm test`.

See [language-server notes](docs/language-server-notes.md) for the deferred
semantic-inspection direction.
