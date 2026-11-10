# Bind knobs on existing servers

**Type:** task
**Status:** open
**Blocked by:** None

## Question

Give `pi-wiki-serve` (and any other server that will ever face a network) a `--bind` flag + `PI_*_BIND` env, default loopback, accepting any address. Deployed unit binds the Nebula IP with `After=dnclient.service`. This is the first exercise of the deployment-seam principle: the knob is a generic address, nothing Nebula-shaped in the app.

## Resolution
