# Git over hub HTTP + self-service enrollment

**Type:** task
**Status:** closed
**Blocked by:** None. Supersedes ticket 07's git-shell hosting; retires ticket 10's wizard.

## Question

Field evidence from the first live onboarding attempt (2026-11-10): the
SSH-key + git-shell model made onboarding a saga — a new unix account,
`authorized_keys` surgery, and 10+ sudo prompts because every hub-side step was
its own ssh round-trip. The operator abandoned the run and set the bar:
"Defined's Nebula literally just shares a key and that's it. Precisely two
actions on any computer: install the thing, paste the key to the hub."

Redesign:

- **Git hosting moves into `pi-memory-hub`.** Token-gated smart-HTTP via
  `git http-backend` at `/git/*`. Bare repo owned by the hub service user at
  `~/.pi/agent/wiki-git/wiki.git`; the hub's working clone gets `origin`
  repointed to it by `pi-memory hub-git-init`. One transport, one credential,
  revocation = revoke token.
- **Enrollment is spoke-generated, hub-registered.**
  `pi-memory enroll <hub-address>` generates a 32-byte secret locally, prints
  the single hub-side command (`pi-memory hub-token register <spoke> '<secret>'`)
  exactly once, polls `/status`, then completes the same setup path as `join`:
  private `hub.json`, authenticated HTTP wiki clone, and push timer. The secret
  is not persisted on the spoke until the hub accepts it.
- **`hub-token add` stays** for headless/automation flows and emits a versioned
  `pih1.<base64url({hub})>.<secret>` bundle. `join <bundle>` parses it; raw
  `--token` and `--token-stdin` remain supported. Loopback advertised addresses
  warn that the bundle is only useful on the hub itself.
- **The wizard and SSH Git machinery are retired.** `scripts/spoke-onboard.sh`
  and its tests were deleted. No SSH aliases, Git hosting Unix account, or
  `authorized_keys` enrollment remain in the join path.

## Resolution

Implemented the ticket in the hub, CLI, join flow, tests, and
[`docs/memory.md`](../../../docs/memory.md).

- The hub authenticates `/git/...` with its ordinary Bearer token lookup and
  serves only `wiki.git`. It validates the decoded CGI path (including all
  suffix components), lazily creates the bare repo under
  `$PI_CODING_AGENT_DIR/wiki-git/` (default `~/.pi/agent/wiki-git/`), and
  delegates smart-HTTP requests to a `git http-backend` child process. The
  hub supplies `GIT_PROJECT_ROOT`, `PATH_INFO`, `PATH_TRANSLATED`,
  `GIT_HTTP_EXPORT_ALL`, request method/query/content metadata, CGI request
  headers, and `REMOTE_USER` set to the authenticated spoke identity. Request
  bodies stream to CGI stdin; CGI headers are translated to the Node response
  and stdout bodies stream back. Git's receive-pack is enabled by the
  authenticated `REMOTE_USER` context. `pi-memory hub-git-init` initializes
  that repo and sets the hub checkout's `origin` to its local bare path.
- Added `pi-memory enroll` with hostname default, custom spoke name, port and
  `--no-push` options. The secret is generated as 32 random bytes encoded
  base64url, displayed only in the registration command, and polled at an
  injectable interval/timeout. Cancellation and timeout leave no `hub.json`.
  Enrollment and `join` share the same completion path.
- Added validated `hub-token register`; `hub-token add` now emits an advertised
  address bundle and warns for loopback. `join <pih1-bundle>` and raw token
  automation paths are covered.
- Replaced SSH wiki cloning with authenticated HTTP clone/fetch/pull. The
  Authorization header is persisted in the clone's `.git/config`; the clone
  directory is set to 0700 and `.git/config` to 0600. Matching existing HTTP
  origins are updated with fetch + fast-forward-only pull; mismatched origins
  are refused. Removed SSH diagnostics, SSH config mutation, and the obsolete
  onboarding script/test. The docs now lead with install + enroll/paste and
  cover bundles, token administration, the hub Git origin setup, and private
  credential storage.

**Validation:** `npm test` passed: 161 tests, 0 failures, 0 skips. Coverage
includes unauthenticated/invalid Git auth rejection, path traversal rejection,
a real Git clone + push + ls-remote against an ephemeral hub (skipped when Git
is unavailable), hub Git initialization/origin repointing, fast-poll enrollment
against a stub that returns 401 before registration and 200 after, timeout with
no pending config, token registration validation, bundle mint/parse, bundle
join through the CLI, and raw stdin-token join. `git diff --check` is clean.

**Deferred:** the ticket's deployment gate still needs an operator run on a
second machine with the real hub and push timer. Tests exercise the CGI bridge
and Git round-trip locally, but do not validate the live private network,
service-user deployment, or a real user's systemd user manager. TLS remains an
operator/reverse-proxy concern; the hub's HTTP listener should stay on the
trusted private network. V1 intentionally serves one repository, `wiki.git`.

**Live run (2026-11-10, deferred gate satisfied):** spoke `Intermezzo`
enrolled end-to-end with the two actions — install, `pi-memory enroll
100.100.0.21`, one register paste; wiki cloned, push timer enabled. Field
findings: (1) the hub's nftables allowed SSH from the overlay but not 6342 —
rule added, requirement now documented in `docs/memory.md`; (2) `enroll`
cannot distinguish an unreachable hub from an unregistered token and polls
silently — follow-up gap (needs a reachability preflight with a loud error);
(3) the hub logs no per-request activity, which left the hub side blind
during debugging — follow-up gap.
