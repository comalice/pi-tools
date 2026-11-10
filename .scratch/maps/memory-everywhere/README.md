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
- [Origin provenance column](01-origin-provenance.md): `entries.origin` (schema v3, hostname default), captured at ingest with explicit-option > env > hostname precedence; grok adapter threaded on rebase; unchanged sessions keep their original origin.
- [Bind knobs on existing servers](02-bind-knobs.md): `src/shared/bind.ts` IP-literal validation, `--bind`/`PI_WIKI_BIND`/`PI_DREAM_ADMIN_BIND`, deploy via `make PI_WIKI_BIND=`, overlay ordering as documented drop-in (deployment seam exercised).
- [Blob store + import surfaces](09-blob-store.md) (phase A landed): content-addressed blobs under `memory/blobs/<source>/<origin>/`; claude/grok are import-mode (watch-mode pi/opencode/wiki unchanged); backfill executed 2026-11-10 — roots flipped, zero sessions lost; import roots never cascade-prune; `memory forget` is the only deletion path. Phase B (hub `/import`, admin upload, extension tool) rides with ticket 03.
- [Git hosting on the hub](07-git-hosting.md): bare repo over SSH, dedicated `git` user + `git-shell`, per-spoke keys; spokes address the hub via a `Host memory-hub` SSH alias written by `memory join` — no IPs in remotes.

## Not yet specified

- **Zero-touch hub rediscovery** — a DNS name the user controls, or overlay-level DNS, so `memory join` re-runs aren't needed on hub moves. Upgrade path from the command-pair migration.
- **Session roaming** — `pi --resume` any session from any box. Has its own locking questions; separate map if ever.
- **Managed-service topology** — TLS termination, public ingress, what "tenancy" would even mean for one user's agents on rented compute. The deployment seam keeps this possible; nothing here designs it.
- **Offline queueing guarantees** — v1 push is best-effort on timer cadence; durable spool with backoff is unspecified.
- **Claude Code as a first-class spoke source** — export path exists and rides the push adapter, but no spoke-side claude tooling is specified.

## Out of scope

- Peer-to-peer sync of the archive between machines (rejected in favor of hub-and-spoke, round 1 Q1).
- Multi-user tenancy, accounts, or sharing (rejected round 1 Q1; managed-service fog may revisit the question, never in this map).
- Syncing any derived store (vectors, mentions, dossiers, staging, dream state) — rejected round 1 Q2; rebuild instead.
