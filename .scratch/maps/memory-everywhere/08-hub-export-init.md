# hub-export / hub-init command pair + runbook

**Type:** task
**Status:** open
**Blocked by:** pi-memory-hub service

## Question

`memory hub-export` produces a portable bundle: archive SQLite, entities registry, wiki repos (bare), dream state + session summaries, hub config minus secrets. `memory hub-init` on a new box: restores the bundle, installs all units, rebuilds every derived store (vectors, mentions, dossiers) from source, binds, starts. Plus the runbook in docs/ covering the full move including `memory join` re-runs per spoke. The test of this ticket is executing the runbook for real.

## Resolution
