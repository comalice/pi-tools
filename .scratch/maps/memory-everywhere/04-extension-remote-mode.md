# Extension remote mode

**Type:** task
**Status:** open
**Blocked by:** pi-memory-hub service

## Question

The pi memory extension reads `~/.pi/agent/memory/hub.json` when present and routes `memory_search`/`memory_expand` over HTTP to the hub with the spoke's token — identical tool surface, identical output shape, local archive untouched. Failure mode: clear error naming the hub and the failure, never a silent fallback to an empty local DB.

## Resolution
