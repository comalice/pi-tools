---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along three axes: Standards (does the diff follow this repo's documented coding standards?), Spec (does it implement what the originating issue/spec asked for?), and Adversarial Bugs (null paths, races, off-by-one, error handling, security). Each axis runs in a fresh, isolated headless pi sub-process and findings are reported side by side, never merged. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to 'review since X'."
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?
- **Adversarial Bugs**: hunt concrete defects — null/undefined paths, off-by-one, races, unhandled errors, resource leaks, injection, broken edge cases.

Each axis runs as a **separate headless pi process** with a fresh context window, so axes never pollute each other — and so the review never happens inside the session that wrote the code. ("Same context reviewing itself isn't review, it's confirmation bias with a slash command.") This skill aggregates their reports.

Design lineage: the two-axis Standards/Spec split and the smell baseline follow Matt Pocock's `code-review` skill (MIT); the adversarial-bug axis and the tooling-first pre-pass follow Geoff Huntley's position that review is an engineering gate, not a prose ritual.

## Process

### 1. Pin the fixed point

The fixed point is whatever the user supplied (commit SHA, branch, tag, `main`, `HEAD~5`). If they didn't supply one, ask — do not guess.

Validate **before** spawning anything:

```sh
git rev-parse --verify <fixed-point>
git diff <fixed-point>...HEAD --stat
```

Three-dot diff: comparison is against the merge-base. Note that staged and uncommitted work is **invisible** to this review — if the user wants that reviewed, tell them to commit first. A bad ref or an empty diff fails here, in front of the user, not inside three sub-processes.

### 2. Tooling pre-pass (Huntley layer)

If it can be checked by a machine, it must not become an LLM finding. Detect and run what the repo has:

- Lint / typecheck / build (`package.json` scripts, `Makefile`, `Cargo.toml`, etc.)
- The test suite, if it's fast enough to be practical.

Record the results verbatim. Pass a summary to every axis brief with the standing instruction: **skip anything tooling already enforces.** If the build, typecheck, or tests fail, say so prominently in the final report — a failing gate usually outranks every prose finding.

### 3. Identify the standards sources

Search the repo for every file documenting how code should be written: `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/` style guides. When such files exist they are the primary source and **the repo overrides the baseline**.

Regardless, the Standards axis carries the smell baseline in `references/smell-baseline.md` (Fowler, _Refactoring_ ch.3): labelled heuristics ("possible Feature Envy"), never hard violations.

### 4. Identify the spec source

In order:

1. Issue references in commit messages (`#123`, `Closes #45`, `!67`) — fetch via `gh`/`glab` if available.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch or feature.
4. Ask the user. If there is no spec, **skip the Spec axis** and report "no spec available" — never infer requirements from the code.

### 5. Spawn the three axes in parallel

For each axis, fill its brief template from `references/` and run `scripts/run-axis.sh` (paths relative to this skill directory):

```sh
scripts/run-axis.sh <fixed-point> <filled-brief-file> <output-file>
```

Run all three with a single bash invocation using `&` and `wait`, writing to `.scratch/code-review/<axis>.md` (create the dir). Fill each template's `{{PLACEHOLDERS}}` before launching:

- `references/standards-brief.md` — `{{STANDARDS_SOURCES}}` (file list), `{{SMELL_BASELINE}}` (paste `references/smell-baseline.md` in full), `{{TOOLING_RESULTS}}`.
- `references/spec-brief.md` — `{{SPEC}}` (path or fetched contents), `{{TOOLING_RESULTS}}`.
- `references/adversarial-brief.md` — `{{TOOLING_RESULTS}}`.

`run-axis.sh` captures the diff and commit list itself, launches `pi -p` with `--no-session --no-skills --no-extensions --no-mcp`, and restricts tools to `read,bash`. Sub-agents therefore **cannot** rediscover this skill or load other project machinery — this is the harness-level guard against recursive fan-out. Set `PI_REVIEW_MODEL` to override the model used by axis processes (a cheaper model is often fine; match the model to the task, not to your ego).

Skip the Spec axis if no spec exists. If an axis process fails, report its failure in place of its findings — never silently drop an axis.

### 6. Aggregate — do not blend

Present the reports under `## Standards`, `## Spec`, and `## Adversarial Bugs` headings, verbatim or lightly cleaned. **Never merge, deduplicate across, or re-rank the axes** — a change can pass one axis and fail another, and a blended verdict lets the passing axis hide the failing one.

Close with:

- The tooling pre-pass verdict (build/lint/tests).
- One line per axis: finding count and the worst issue **within that axis** (if any). Never pick a single overall winner.
- This footer, verbatim:

> Findings are hypotheses, not evidence. Every finding carries a citation — verify the citation before acting on it. This review has no convergence guarantee: fix the cited findings and stop. Do not re-run it in a loop waiting for a clean pass, because it never comes.

### 7. Convert repeat findings into enforcement

When a finding names a mistake class the repo will make again, offer to encode it instead of flagging it forever:

- A pre-commit hook, lint rule, or type-level constraint when the check is mechanical.
- A new rule in `CODING_STANDARDS.md` (or equivalent) when it needs judgement — the Standards axis reads that file next run.

Never give the same review feedback three times. The first time you flag it, the second time you automate it.
