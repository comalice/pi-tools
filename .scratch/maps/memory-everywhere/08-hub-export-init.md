# hub-export / hub-init command pair + runbook

**Type:** task
**Status:** open
**Blocked by:** pi-memory-hub service, Blob store + import surfaces

## Question

`memory hub-export` produces a portable bundle: archive SQLite, entities registry, wiki repos (bare), dream state + session summaries, hub config minus secrets. `memory hub-init` on a new box: restores the bundle, installs all units, rebuilds every derived store (vectors, mentions, dossiers) from source, binds, starts. Plus the runbook in docs/ covering the full move including `memory join` re-runs per spoke. The test of this ticket is executing the runbook for real.

**Wizard re-evaluation (2026-11):** a hub move is the `wizard` skill's canonical case — one-off cutover with irreversible steps — so the runbook is delivered *as* a wizard (`scripts/hub-migrate.sh`, built from `skills/wizard/template.sh`), not just a docs page. Stages: export on old hub; bundle transfer (operator supplies path/credentials); `hub-init` on the new box; rebind/service start; per-spoke re-join with a confirmation gate per machine; final verification; explicit `confirm` gate before old-hub decommission. Ephemeral by the skill's default, but hub moves recur, so commit it. Agent-doable substeps (export, init, rebuilds) stay commands — the wizard sequences and gates them, it doesn't reimplement them.

**Correction (2026-11):** the earlier draft of this paragraph pointed at "ticket 10's wizard" as the reusable per-spoke re-join stage. Ticket 10 was retired and its wizard deleted after the failed live run; re-join must be re-scoped onto the enroll/join flow (spoke runs `pi-memory enroll <pih1-bundle>` against the new hub, one `hub-token register` paste) — no SSH, no keys. An open spec question for this ticket: whether the `hub-export` bundle carries `hub-tokens.json` (spokes keep working after a move) or omits it (every spoke re-enrolls).

## Resolution
