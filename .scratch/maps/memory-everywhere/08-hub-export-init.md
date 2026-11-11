# hub-export / hub-init command pair + runbook

**Type:** task
**Status:** open
**Blocked by:** pi-memory-hub service, Blob store + import surfaces

## Question

`memory hub-export` produces a portable bundle: archive SQLite, entities registry, wiki repos (bare), dream state + session summaries, hub config minus secrets. `memory hub-init` on a new box: restores the bundle, installs all units, rebuilds every derived store (vectors, mentions, dossiers) from source, binds, starts. Plus the runbook in docs/ covering the full move including `memory join` re-runs per spoke. The test of this ticket is executing the runbook for real.

**Wizard re-evaluation (2026-11):** a hub move is the `wizard` skill's canonical case — one-off cutover with irreversible steps — so the runbook is delivered *as* a wizard (`scripts/hub-migrate.sh`, built from `skills/wizard/template.sh`), not just a docs page. Stages: export on old hub; bundle transfer (operator supplies path/credentials); `hub-init` on the new box; rebind/service start; per-spoke re-join with a confirmation gate per machine (ticket 10's wizard can be reused here); final verification; explicit `confirm` gate before old-hub decommission. Ephemeral by the skill's default, but hub moves recur, so commit it alongside ticket 10's wizard. Agent-doable substeps (export, init, rebuilds) stay commands — the wizard sequences and gates them, it doesn't reimplement them.

## Resolution
