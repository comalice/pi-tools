---
name: implement
description: Implement a piece of work based on a spec or set of tickets (local git-tracked markdown under `.scratch/`).
disable-model-invocation: true
metadata:
  upstream: "mattpocock/skills@4ae2317ddb (adapted: ticket refs are wayfinder map files under .scratch/maps/<map-slug>/)"
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, read the file and state its title before starting. Tickets are wayfinder ticket files: `<NN>-<slug>.md` siblings inside a map under `.scratch/maps/<map-slug>/`, each with `**Type:**`, `**Status:**`, and `**Blocked by:**` lines, Status one of `open`, `claimed`, or `closed`. If the reference is ambiguous, ask. If it names a spec instead, read the spec and the derived tickets, and agree with the user which ticket(s) this session covers before writing code.

Load the `tdd` skill and work test-first where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, load the `code-review` skill and review the diff since the commit this session started from — pass that commit as the fixed point so the review doesn't end at a question (the skill asks rather than guesses).

Close the ticket the way wayfinder does: append a `## Resolution` section with what was built, set its **Status** to `closed`, add a one-line gist with a link to the map's Decisions-so-far, and commit your work to the current branch.
