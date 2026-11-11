# Spoke onboarding wizard

**Type:** task
**Status:** implemented — awaiting live validation (second-machine onboarding run, the ticket's done-when)
**Blocked by:** None (re-scopes the closed memory join / git-hosting work into its human-facing shape)

## Question

Ticket 06 delivered `memory join` as one command, but the *full* onboarding is still a four-stage manual procedure in `docs/memory.md` with two cross-machine value shuttles (spoke token hub→spoke, SSH pubkey spoke→hub), sudo on the hub, and a known awkward failure: the first join fails at wiki clone when the key isn't enrolled yet, then the human enrolls, then re-runs with `--force`. That is exactly the shape the `wizard` skill exists for — a tedious multi-stage procedure with shown-once secrets and confirmation gates — and it recurs once per spoke, so it earns a committed wizard (the skill's repeatability exception), not an ephemeral one.

Re-scope onboarding around `scripts/spoke-onboard.sh`, a wizard-skill script (library from `skills/wizard/template.sh`, untouched above the STAGES marker):

- **Drive both machines from one run.** The operator already needs ssh+sudo on the hub for key enrollment; the wizard runs where the human is and performs hub-side steps over that ssh connection: `git` user + bare repo check, `hub-token add <spoke>`, `authorized_keys` append. The token is captured from command output directly — no human copy-paste of the shown-once secret, no transcript exposure.
- **Reorder around the known failure.** Enroll the SSH key *before* the first `memory join`, so the wiki clone succeeds on first pass and `--force` is reserved for genuine re-joins. The wizard runs `join` itself and finishes with `join --status` + a test `memory push` as its verification stage.
- **Keep agent-doable steps out of the wizard.** `make install-spoke` (already inside join), timer checks, token revoke/re-mint: single commands, stay CLI per the skill's own rule.
- **Nebula enrollment stays a human stage** — the wizard verifies reachability (ping/ssh to the hub overlay address) and stops with exact instructions if the machine isn't on the network; it does not attempt to automate Nebula onboarding.
- **Secrets discipline:** token handled via `ask_secret`-equivalent capture and lands only in `hub.json` (0600, via `memory join`); pubkey travels as a printed value the operator confirms, never the private key.

Done when: onboarding a real second machine is one wizard invocation with only confirmation gates and (where required) a sudo password, and `docs/memory.md` "Spoke onboarding" shrinks to "run the wizard" plus a manual fallback appendix.

## Resolution

Implemented `scripts/spoke-onboard.sh` as a five-stage wizard using the
`skills/wizard/template.sh` library unchanged through `run_wizard()`. It checks
overlay/SSH and spoke prerequisites, prepares the hub over SSH with confirmation
gates, captures the hub-minted token silently, enrolls the public SSH key before
first join, invokes `pi-memory join` with the token streamed on stdin, then
verifies status, push, and Git access. Pre-join aborts automatically revoke the
just-minted token where possible; matching partial hub configs are reused on
rerun with `--force`. The docs lead with the wizard and retain an ordered manual
fallback.

Validation: `bash -n scripts/spoke-onboard.sh` passed; `shellcheck` was not
installed; final `npm test` passed (160 tests), including the stdin-token join
and wizard structure checks. The wizard was not run end-to-end because it
requires an operator and a live hub.

Review (2026-11, post-implementation): wizard stages, token handling
(stdout capture → stdin handoff, 256-char/no-whitespace validation, revoke on
abort), hub CLI JSON shapes, and docs verified against `src/memory/`.
**Remaining gate:** run the wizard for real on a second machine (requires a
live hub + operator); close the ticket when that succeeds. Also confirm the
`join --status` reuse path against a real partial `hub.json` during that run.

Repair (2026-11, pre-live-run): the hub-side stage would have died on its own
check — the hub already has a `git` user (home `/`, from the transitional
Forgejo install), while the wizard expected to create one with home
`/home/git`. Hosting account renamed to `wikigit` throughout (wizard,
`join`, docs, tests; ticket 07 amended). `npm test` green after the rename.
