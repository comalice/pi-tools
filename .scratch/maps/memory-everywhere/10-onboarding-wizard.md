# Spoke onboarding wizard

**Type:** task
**Status:** open
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
