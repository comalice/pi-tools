# dirac-pi-tools

Tools, extensions, and skills for pi: memory archive, wiki, entity layer, dream/librarian pipeline, scheduling.

## Hard rules

- **Work in a git worktree on a branch, never uncommitted in the main checkout.** Multiple agents operate in this repo concurrently; uncommitted work in the main tree blocks merges and gets destroyed by them. `git worktree add /tmp/<name> -b worker/<slug>` and symlink `node_modules`.
- Conventions: `node:sqlite` `DatabaseSync`, `node:test`, no zod, `.ts` extensions on relative imports, no logger abstraction.
- `npm test` must pass; the baseline is on `main`.

## Pointers

- `docs/` — memory, wiki, scheduling, memory services (Qdrant/embedder), language-server notes
- `.scratch/maps/` — wayfinder maps (active: `memory-everywhere`)
- `skills/VENDORED.md` — provenance and adaptation notes for vendored skills
- `deploy/systemd/` — unit templates; install via the Makefile
