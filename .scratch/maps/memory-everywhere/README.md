# Memory Everywhere

## Destination

A pi session on any of the user's machines gets the full memory/wiki tool surface served by a single **hub**; spokes push their session data to the hub; the hub is a *role* movable between machines via a documented command pair. Done = the second machine runs pi with working `memory_search`/`memory_expand`/wiki reads against the hub, its sessions flow into the archive, and the migration runbook has been executed at least once for real.

## Notes

- Domain: dirac-pi-tools memory/wiki/entity/dream stack (see `docs/memory.md`, `docs/wiki.md`, `docs/scheduling.md`).
- **This map carries execution.** Decisions were settled up front by grilling (see Decisions so far); tickets are build/ops work, not open questions.
- Skills to consult: `tdd` (every build ticket), `codebase-design` (seam choices), `implement` + `to-tickets` if a ticket needs further slicing, `code-review` at ticket close.
- Standing preferences:
  - **Transport/binding is a deployment seam.** Nothing in the app layer assumes Nebula, loopback, or any particular topology; bind address and tokens are per-deployment config. A future managed-service target (TLS, public ingress, tenancy) must be possible without redesign.
  - Derived state never crosses machines: Qdrant vectors, mentions sidecar, dossiers, staging, dream state, session summaries are hub-local and rebuildable from source.
  - Single-writer discipline: the archive is written only by the hub's ingest path.
  - Repo conventions: `node:sqlite` `DatabaseSync`, `node:test`, no zod, `.ts` import extensions, no logger.
  - Security pattern: bind-scoped + token-gated; per-spoke revocable tokens, never one shared credential.

## Decisions so far

Settled in the charting grilling (rounds 1–2, 2026-11-10 session), no ticket files:

- **Hub-and-spoke for one user.** One hub serves the user's machines; not peer-to-peer, not multi-tenant.
- **The hub is a movable role.** Spokes reference it via `~/.pi/agent/memory/hub.json`; migration = `hub-export`/`hub-init` command pair + `memory join` re-run per spoke.
- **Only source-of-truth crosses machines.** Wiki (git), archive (via hub ingest), entity registry (rides with wiki). Everything derived stays hub-local.
- **Writes through the hub API, never file sync.** No rsync/syncthing of live SQLite; single writer stays singular.
- **Compute centralizes on the hub.** Dream, librarian, entity-scan, summaries, dossiers run hub-side only; spokes are thin.
- **Session files don't replicate in v1.** No `pi --resume` of a laptop session from the desktop; derived memory only.
- **Overlay binding via config knob.** Servers bind the Nebula IP (`100.100.0.21`) through `--bind`/`PI_*_BIND`; `After=dnclient.service` in units. Nebula is one deployment of the seam, not an assumption.
- **One new service: `pi-memory-hub`.** Token-gated HTTP: `/search`, `/expand`, `/ingest`, `/status`.
- **Extension remote mode.** With `hub.json` present, `memory_search`/`memory_expand` call the hub; identical tool surface on spokes.
- **Origin provenance.** Archive entries capture `origin` (spoke hostname) at ingest; ids unchanged.
- **Spoke ingest is push.** `memory push` timer on each spoke; pi sessions shipped raw, opencode/claude via existing digest adapters.
- **Wiki over git with real hosting.** Hub hosts the canonical remote; spokes clone/push over SSH (per-spoke keys); dossiers/staging hub-only.
- **Per-spoke revocable tokens**, listed in hub config.
- [memory join onboarding](06-memory-join.md): one-command spoke setup — status verify, `hub.json`, managed ssh `Host memory-hub` block, wiki clone decision paths, push timer; key enrollment stays HITL. **Re-evaluated against the wizard skill (2026-11):** the join command is right, but the surrounding four-stage human procedure is wizard-shaped — see ticket 10.
- [Extension remote mode](04-extension-remote-mode.md): `hub.json` switches `memory_search`/`memory_expand` to the hub API; validated config, no silent local fallback, errors name the hub.
- [Spoke push adapter + timer](05-spoke-push-adapter.md): `pi-memory push` with sha256 watermarks; hashed relative-path filenames; hub replaces prior snapshot on update; `make install-spoke` for spoke-side units.
- [pi-memory-hub service](03-memory-hub-service.md): `/status` `/search` `/expand` `/ingest` behind per-spoke Bearer tokens (hub-local `memory hub-token` management only); token identity is the origin assertion; ingest serialized in-process; live on loopback with the full mint→auth→revoke lifecycle verified.
- [Origin provenance column](01-origin-provenance.md): `entries.origin` (schema v3, hostname default), captured at ingest with explicit-option > env > hostname precedence; grok adapter threaded on rebase; unchanged sessions keep their original origin.
- [Bind knobs on existing servers](02-bind-knobs.md): `src/shared/bind.ts` IP-literal validation, `--bind`/`PI_WIKI_BIND`/`PI_DREAM_ADMIN_BIND`, deploy via `make PI_WIKI_BIND=`, overlay ordering as documented drop-in (deployment seam exercised).
- [Blob store + import surfaces](09-blob-store.md) (phase A landed): content-addressed blobs under `memory/blobs/<source>/<origin>/`; claude/grok are import-mode (watch-mode pi/opencode/wiki unchanged); backfill executed 2026-11-10 — roots flipped, zero sessions lost; import roots never cascade-prune; `memory forget` is the only deletion path. Phase B (hub `/import`, admin upload, extension tool) rides with ticket 03.
- [Git hosting on the hub](07-git-hosting.md): **superseded by ticket 11** after the first live onboarding attempt — git-shell hosting (account + per-spoke SSH keys) was the worst part of the flow. Kept for the record; the per-spoke-key model survives only as the future Forgejo path.
- [Spoke onboarding wizard](10-onboarding-wizard.md): **closed, retired before its live run** — the operator abandoned the attempt (10+ sudo prompts, three credential systems). Replaced by ticket 11, whose successful run satisfied this ticket's validation gate.
- [Git over hub HTTP + self-service enrollment](11-git-over-http-enroll.md): the onboarding bar — *two actions on any computer: install the thing, paste the key to the hub*. Git served from `pi-memory-hub` as token-gated smart-HTTP; `pi-memory enroll` generates the spoke secret locally and waits for the one hub-side `hub-token register` paste; `hub-token add` emits a versioned `pih1.` bundle carrying the hub's advertised address for headless joins. No sudo, no unix accounts, no SSH keys. **Closed 2026-11-10** — live-validated by the `Intermezzo` enrollment.
- [hub-export / hub-init + runbook](08-hub-export-init.md): open; scope extended to deliver the migration runbook *as* a wizard (`scripts/hub-migrate.sh`) with confirmation gates around the irreversible steps.

## Field issues from the Intermezzo bring-up (2026-11-10)

Bugs and frictions observed during the first real spoke enrollment + push. Each needs a ticket or a fix; none are designed behavior.

- **FIXED — hub 500 `Maximum call stack size exceeded` on spoke push.** Cause: `hub.ts` validated `content_base64` with a whole-body regex (`^(?:[A-Za-z0-9+/]{4})*...$`); V8's regex engine recurses per repetition and overflows the stack at ~5 MiB of base64 — every Intermezzo session over ~4 MiB 500'd. Fix: deleted the regex; the adjacent decode + canonical round-trip check already subsumes it. Regression test: 9 MiB multi-line session POST (`tests/memory-hub.test.ts`). Diagnosis path worked as designed: journaled stack pointed straight at the line.
- **`make install-systemd` resets ALL units to template defaults.** Reinstalling the ingest unit also regenerated `pi-memory-hub.service` with the default loopback bind, silently wiping the `PI_HUB_BIND=100.100.0.21` customization; the next restart moved the hub off the overlay and every spoke push failed with `fetch failed`. Bit us live. Deploy should either preserve existing per-unit customization, install units individually, or fail loudly when an installed unit's bind differs from the template default.
- **`pi install` missing from the onboarding story.** The "two actions" (install + enroll) give a working push timer but no `memory_search`/`memory_expand` in pi sessions — that needs `pi install <checkout>`, which docs never mention. Either fold into `make install-bin` or make it an explicit documented step; the two-action promise is currently false.
- **Re-running `enroll` after a failed attempt collides with the stale token.** Each run mints a fresh secret; `hub-token register` refuses a second token for the same spoke name, so a retry requires a manual `revoke` first. Enroll's timeout message should say so (it currently just says "no hub.json was written"), or register should offer `--replace`.
- **Push re-ingests the entire pi blob root per uploaded file.** `importPayload` → `ingestSource(db, source, sourceRoot)` walks/re-fingerprints every blob (458+ files) for each single-file POST. Fine at 457 files, quadratic-feeling at scale. Also a provenance hazard: that ingest runs with the *spoke's* `origin`, so a hub-local blob whose fingerprint changed since last ingest would be re-tagged with the spoke's origin during the spoke's push. Ingest should be scoped to the imported file (or origin should only apply to the file actually imported).
- **Hub 500 responses leak internal detail to spokes.** Raw internal error text (including hub-local filesystem paths, e.g. the backfill guard's `/home/albertlatham/...`) is returned in the 500 body. Low stakes for one user, but the error hygiene pattern (generic 500 body + detailed journal) is the right shape now that stacks are journaled.
- **Cosmetic: `Invalid URL` warnings from the hub unit.** systemd complains about the `Documentation=` line in `pi-memory-hub.service` (a repo-relative docs path, not a URL). Fix the template.

## Not yet specified

- **Zero-touch hub rediscovery** — a DNS name the user controls, or overlay-level DNS, so `memory join` re-runs aren't needed on hub moves. Upgrade path from the command-pair migration.
- **Session roaming** — `pi --resume` any session from any box. Has its own locking questions; separate map if ever.
- **Managed-service topology** — TLS termination, public ingress, what "tenancy" would even mean for one user's agents on rented compute. The deployment seam keeps this possible; nothing here designs it.
- **Offline queueing guarantees** — v1 push is best-effort on timer cadence; durable spool with backoff is unspecified.
- **Multi-address bind** — the bind knob takes one address; moving the wiki front-end to the overlay broke loopback/SSH-forward access (outage 2026-11-10). Services should accept a bind list (loopback + overlay) so human and spoke paths coexist.
- **Claude Code as a first-class spoke source** — export path exists and rides the push adapter, but no spoke-side claude tooling is specified.
- **Nebula enrollment automation** — wizard re-evaluation (ticket 10) confirmed adding a machine to the overlay is human-only; the wizard verifies reachability and stops with instructions. Whether anything smarter is possible (overlay DNS, enrollment tokens) is unexamined.
- **`enroll` reachability preflight** — an unreachable hub (firewall REJECT, no route) is indistinguishable from an unregistered token today; enroll polls silently for 15 minutes. Should probe `/status` unauthenticated up front and fail loudly with the firewall hint. Field-found during the Intermezzo run.
- **Hub request logging** — partially addressed 2026-11-10: 5xx errors now log with stack to the journal (hotwired during the push-500 hunt). Full per-request logging (method, path class, spoke, status) remains unscoped.
- **Firewall rule in deploy** — the nftables 6342 rule was added by hand post-incident; `make install` / deploy templates don't manage host firewall. Whether deploy should own it (drop-in, documented snippet) is undecided.

## Out of scope

- Peer-to-peer sync of the archive between machines (rejected in favor of hub-and-spoke, round 1 Q1).
- Multi-user tenancy, accounts, or sharing (rejected round 1 Q1; managed-service fog may revisit the question, never in this map).
- Syncing any derived store (vectors, mentions, dossiers, staging, dream state) — rejected round 1 Q2; rebuild instead.
