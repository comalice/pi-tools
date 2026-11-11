# Git over hub HTTP + self-service enrollment

**Type:** task
**Status:** claimed
**Blocked by:** None. Supersedes ticket 07's git-shell hosting; retires ticket 10's wizard.

## Question

Field evidence from the first live onboarding attempt (2026-11-10): the
SSH-key + git-shell model made onboarding a saga — a new unix account,
`authorized_keys` surgery, and 10+ sudo prompts because every hub-side step
was its own ssh round-trip. The operator abandoned the run and set the bar:
"Defined's Nebula literally just shares a key and that's it. Precisely two
actions on any computer: install the thing, paste the key to the hub."

Redesign:

- **Git hosting moves into `pi-memory-hub`.** Token-gated smart-HTTP via
  `git http-backend` at `/git/*`. Bare repo owned by the hub service user at
  `~/.pi/agent/wiki.git`; the hub's working clone gets `origin` repointed to
  it. This reverses ticket 07's "smart-HTTP is weird" rejection: the cost of
  the SSH path was theoretical then and has now been paid in the field. One
  transport, one credential, revocation = revoke token.
- **Enrollment is spoke-generated, hub-registered** (the Nebula shape):
  `pi-memory enroll <hub-address>` on the spoke generates its own 32-byte
  secret, prints the single hub-side command
  (`pi-memory hub-token register <spoke> '<secret>'`), polls `/status` until
  the token is live, then completes setup — `hub.json` (0600), wiki clone
  over HTTP with an `Authorization` header persisted in the clone's config,
  push timer. The secret is displayed exactly once, travels only spoke→hub,
  and is never stored on the hub in plaintext beyond the existing token map.
- **`hub-token add` stays** for headless/automation flows and now also emits
  a versioned bundle `pih1.<base64url({hub})>.<secret>` so a minted token
  carries its own bootstrap address (advertised address from
  `--advertise`/`PI_HUB_BIND`; warn on loopback). `join <bundle>` parses it.
- **The wizard is retired** (`scripts/spoke-onboard.sh` deleted): two
  actions don't need one. Docs onboarding = install + enroll + one paste.
  No sudo, no unix accounts, no SSH keys, no `Host memory-hub` ssh block.

Done when: a second machine onboards with exactly — clone + `make
install-bin`, `pi-memory enroll`, one paste on the hub — and ticket 10's
live-validation gate is satisfied by that run.

## Resolution
