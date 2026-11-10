# Vendored skills

The following skills are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, © 2026 Matt Pocock), upstream commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`. Each `SKILL.md` carries an `upstream` metadata line. Edit them freely — they are ours now; sync with upstream by hand if ever needed.

## Adopted

| Skill | Adaptation |
|---|---|
| grilling | sub-agent dispatch → look facts up yourself |
| grill-with-docs | "Skill tool" → load `grilling` + `domain-modeling` |
| tdd | "Skill tool" → load `codebase-design` |
| diagnosing-bugs | verbatim |
| codebase-design | parallel sub-agents → sequential/headless designs |
| domain-modeling | verbatim |
| prototype | verbatim |
| research | verbatim |
| retro | verbatim (AGENTS.md guidance applies as-is) |
| handoff | "Skill tool" → `/skill:<name>` |
| teach | verbatim |
| wait-what | verbatim |
| writing-for-agents | verbatim |
| wizard | verbatim |
| to-spec | publishes to `.scratch/specs/<slug>.md` (git-tracked) instead of an issue tracker |
| to-tickets | local files only (`.scratch/<slug>/issues/NN-slug.md`); tracker branches and triage labels removed |
| implement | ticket refs are local file paths; chains into our `tdd` and `code-review` skills |
| wayfinder | maps/tickets are files under `.scratch/maps/<slug>/`; type/status/blocking as text lines instead of labels, assignment, and native blocking links |

## Excluded (and why)

- `code-review` — name collision with our three-axis review harness (ours is purpose-built)
- `ask-matt`, `setup-matt-pocock-skills` — upstream repo plumbing
- `implement-spec` — overlaps `implement`
- `grill-me` — alias for `grilling`
- `pr`, `triage` — inbound-contribution workflows; solo repos
- `improve-codebase-architecture` — heavyweight HTML-report flow; revisit if wanted
- `to-questionnaire` — marginal for a solo practitioner
- `in-progress/*`, `deprecated/*` — upstream marks them not ready
- `misc/*` — Claude Code-specific (`git-guardrails-claude-code`), one-off migrations, or tooling we don't use (Husky/lint-staged)

## Conventions the adopted set assumes

- Specs: `.scratch/specs/<slug>.md`; tickets: `.scratch/<slug>/issues/NN-slug.md`; maps: `.scratch/maps/<slug>/`. All git-tracked.
- `GLOSSARY.md` at repo root for domain vocabulary; ADRs as markdown (see `domain-modeling`).
- Cross-skill references use pi skill loading (`/skill:<name>` or natural load-by-description), not Claude's Skill tool.
