# Bind knobs on existing servers

**Type:** task
**Status:** closed
**Blocked by:** None

## Question

Give `pi-wiki-serve` (and any other server that will ever face a network) a `--bind` flag + `PI_*_BIND` env, default loopback, accepting any address. Deployed unit binds the Nebula IP with `After=dnclient.service`. This is the first exercise of the deployment-seam principle: the knob is a generic address, nothing Nebula-shaped in the app.

## Resolution

- Added validated IPv4/IPv6 literal bind addresses for the wiki and dream admin servers. Both default to `127.0.0.1`; each CLI flag overrides its matching environment variable (`PI_WIKI_BIND` or `PI_DREAM_ADMIN_BIND`). Hostnames and malformed values fail with an explicit error.
- Made the wiki unit's `PI_WIKI_BIND` configurable through `make install-systemd PI_WIKI_BIND=...` (default loopback). No overlay-client dependency was added to the unit; docs show an optional ordering drop-in.
- Documented loopback security defaults and overlay-bind examples in `docs/wiki.md`. The app remains overlay-agnostic.
- Added node:test coverage for validation, default selection, and precedence. Final `npm test`: 125 passing, 0 failing; manually checked invalid binds fail in both CLI entry points.

Reviewer focus: confirm that literal-IP-only validation matches the intended meaning of `<addr>`, and that the deployment-time `PI_WIKI_BIND` substitution is the desired operator interface.
