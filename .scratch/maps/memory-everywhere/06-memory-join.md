# memory join onboarding

**Type:** task
**Status:** closed — partially superseded
**Blocked by:** pi-memory-hub service, Git hosting on the hub

**Supersession (ticket 11):** the SSH parts of the shipped `join` — the managed
`Host memory-hub` config block and HITL key enrollment — were removed when
ticket 11 replaced SSH hosting with git-over-hub-HTTP and spoke-generated
enrollment. `join` now takes a `pih1` bundle, writes `hub.json`, clones the
wiki over token-gated HTTP, and enables the push timer. The status-verify,
hub.json, clone, and push-timer resolutions below still stand.

## Question

`memory join <hub-address> --token <spoke-token>`: writes `hub.json`, verifies against hub `/status`, clones the wiki remote, installs the push timer. The full new-machine story in one command + a docs page. HITL for the parts only the human can do (enrolling the spoke's SSH key on the hub, adding the machine to the Nebula network).

## Resolution

Implemented `pi-memory join <hub-host> [--port] --token` and `join --status`. Join authenticates against `/status`, reports the assigned spoke identity, securely writes/backups `hub.json`, idempotently manages the marked SSH config block, and clones or fast-forwards only the expected wiki origin. SSH authentication failures provide the manual authorized_keys/key-generation next step; no privileged commands are run. `--no-push` skips `make install-spoke`; normal joins report timer state. Added staged hub/spoke/key-enrollment/verification instructions to `docs/memory.md`.

Validation: `npm test` passes (157 tests, 0 failures).