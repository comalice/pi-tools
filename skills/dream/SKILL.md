---
name: dream
description: "Walk archived conversations and extract durable knowledge — decisions, facts, processes, gotchas, and repetitive/failure-prone ops patterns — into the wiki staging area via the deterministic extraction harness. Use when the user asks to run dream mode, extract learnings from recent sessions, or refresh the wiki staging area."
---

Dream mode: a sweep over archived conversations that writes raw extractions to
the wiki **staging area**. It never writes curated pages directly — promotion
is the librarian's job. Staging is not indexed or trusted until curated.

## Architecture: the harness, not an agent

Extraction is a **deterministic state machine around single-turn model calls**
(`src/dream/worker.ts`), not an agent with tools. The model never executes
anything: per ~12k-char transcript chunk it returns a JSON array of
extractions; code validates (entry IDs must exist verbatim in the chunk, kinds
are enumerated, counts/lengths bounded), retries once with errors fed back,
and persists staging files itself. This design exists because agent-style
workers narrated plans instead of executing, invented citation IDs, and
tool-looped until timeouts — all three are impossible by construction here.

The runner (`src/dream/runner.ts`) enumerates sessions from the memory archive,
spawns workers with bounded concurrency, persists resumable state, retries
failed sessions once automatically at the end of a run, and serves a loopback
admin console at a per-startup token URL (printed on startup; the wiki
front-end links to the active run automatically).

## Running it

1. **Fresh archive first.** If sessions you know exist are missing from the
   sweep, run `node --experimental-strip-types <repo>/src/memory/cli.ts ingest`
   (`<repo>` is this skill's repository root: two levels up from this file).
   The systemd `pi-memory-ingest.timer` normally keeps this current.

2. **Launch or attach.** Preferred: the systemd unit
   `systemctl --user start pi-dream.service` (30-day window, nemotron, 3
   parallel, resumes existing state). Ad hoc:
   `npm run dream` or `node --experimental-strip-types <repo>/src/dream/runner.ts
   --since 7d --model gladiator/nemotron-3-super --parallel 3`.
   Only Pi and Claude sources are processed — OpenCode sessions have no
   readable raw files and are reported as skipped.

3. **Monitor.** The console URL prints at startup. Progress is per-session:
   pending/running/done/failed/skipped with errors. `done` rows may carry
   `chunk warnings` — chunks where the model's output was partly rejected;
   staged items from those chunks are still valid.

4. **Single session, manually:**
   `node --experimental-strip-types <repo>/src/dream/worker.ts --file F
   --source pi --session ID --project P [--origin HOST] --model gladiator/nemotron-3-super`
   (the runner passes `--origin` automatically from the archive; manual runs
   should too, so machine-specific extractions name their host)

## Guardrails

- Dream mode never writes to `pages/` and never edits existing pages.
- Dream output is derived, fallible material. It must not be fed back into the
  memory archive as conversation evidence — staging lives outside the indexed
  sources for exactly this reason.
- Sessions may contain secrets. Workers are instructed to redact; if you spot
  one in staging, delete the file and warn the user.
- Don't widen `--parallel` past ~4 against the gladiator endpoint without
  checking its tolerance; nemotron is slow but free.
- When a run finishes, tell the user staging is ready and that the librarian
  skill promotes entries into curated pages. Do not run the librarian unasked.
