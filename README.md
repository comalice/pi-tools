# Dirac Pi Tools

Standalone Pi package for porting selected tools from Dirac as Pi extensions.

Extensions belong in `extensions/`. Keep the Pi implementations independent
from the Dirac checkout so they can be versioned and installed as a Pi package.

The first port is Dirac's `list_files` tool. It preserves recursive breadth-first
listing, common generated/vendor exclusions, modification-time ordering, line
counts, and the 200-entry limit. It intentionally does not carry over Dirac's
VS Code UI cards, telemetry, multi-root resolution, `.diracignore` policy, or
`.gitignore` filtering. For safety, paths are limited to the Pi working
directory and symlinks are not traversed.
The upstream source and license attribution are recorded in `NOTICE`.

Once an extension is added, load this local package with:

```sh
pi install /home/albertlatham/git/dirac-pi-tools
```

Run the focused tests with `npm test`.
