---
name: implement
description: Implement a piece of work based on a spec or set of tickets (the local markdown files written by to-spec / to-tickets).
disable-model-invocation: true
metadata:
  upstream: "mattpocock/skills@4ae2317ddb (adapted: ticket refs are local file paths)"
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, read the file (usually under `.scratch/<feature-slug>/issues/`) and state its title before starting. If the reference is ambiguous, ask. If it names a spec instead, read the spec and the derived tickets, and agree with the user which ticket(s) this session covers before writing code.

Load the `tdd` skill and work test-first where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, load the `code-review` skill to review the work.

Check off the ticket's acceptance criteria in its file as they are met, set its **Status** to `done` when finished, and commit your work to the current branch.
