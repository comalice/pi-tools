# Vendored skills

Skills adapted from other repos, one section per upstream. Each `SKILL.md` carries an `upstream` metadata line. Edit them freely — they are ours now; sync with upstream by hand if ever needed.

## mattpocock/skills

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, © 2026 Matt Pocock), upstream commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`.

### Adopted

| Skill | Adaptation |
|---|---|
| grilling | sub-agent dispatch → look facts up yourself |
| grill-with-docs | "Skill tool" → load `grilling` + `domain-modeling` |
| tdd | "Skill tool" → load `codebase-design`; code-review pointer reworded — refactoring/fixes happen after the review reports its findings |
| diagnosing-bugs | verbatim |
| codebase-design | parallel sub-agents → sequential/headless designs; GLOSSARY.md reference guarded in DESIGN-IT-TWICE |
| domain-modeling | ADR offer criteria consolidated in ADR-FORMAT.md; the SKILL.md section is a pointer |
| prototype | verbatim |
| research | background agent → headless pi run |
| retro | verbatim (AGENTS.md guidance applies as-is) |
| handoff | "Skill tool" → `/skill:<name>`; argument-hint line removed (pi appends skill arguments regardless) |
| teach | argument-hint line removed (pi appends skill arguments regardless); GLOSSARY-FORMAT.md pointers added (it was referenced nowhere) |
| wait-what | GLOSSARY.md reference guarded for repos without one |
| writing-for-agents | verbatim |
| wizard | verbatim |
| to-spec | publishes to `.scratch/specs/<slug>.md` (git-tracked) instead of an issue tracker |
| implement | ticket refs are wayfinder map files under `.scratch/maps/<slug>/`; code-review fixed point named up front; chains into our `tdd` and `code-review` skills |
| wayfinder | maps/tickets are files under `.scratch/maps/<slug>/`; type/status/blocking as text lines instead of labels, assignment, and native blocking links |

### Excluded (and why)

- `code-review` — name collision with our three-axis review harness (ours is purpose-built)
- `ask-matt`, `setup-matt-pocock-skills` — upstream repo plumbing
- `implement-spec` — overlaps `implement`
- `grill-me` — alias for `grilling`
- `pr`, `triage` — inbound-contribution workflows; solo repos
- `improve-codebase-architecture` — heavyweight HTML-report flow; revisit if wanted
- `to-questionnaire` — marginal for a solo practitioner
- `to-tickets` — overlaps the wayfinder ticket maps; the repo's established practice is wayfinder (owner decision, 2026-11-16)
- `in-progress/*`, `deprecated/*` — upstream marks them not ready
- `misc/*` — Claude Code-specific (`git-guardrails-claude-code`), one-off migrations, or tooling we don't use (Husky/lint-staged)

## cursor/plugins — pstack

Adapted from [cursor/plugins](https://github.com/cursor/plugins) (`pstack/`), Lauren Tan's skill set from the "potato pyramid" talk (transcript: `docs/pateto-pyramid.md`). MIT, © 2026 Lauren Tan, upstream commit `bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7`. Upstream's own framing: "fork it. improve it. make it yours." — this is that.

Cross-harness note: pstack ships `docs/harness/claude-code.md`, a Cursor→Claude Code name map, so porting across harnesses is a supported path. Our map: `Task`/subagent spawn → headless pi process (`pi -p`, backgrounded), usually one git worktree per worker; `~/.cursor/rules/pstack-models.mdc` model lines → the models configured for this pi setup; `.cursor/skills/` → `.agents/skills/`; `/name` slash commands → skill names.

### Adopted

| Skill | Upstream | Adaptation |
|---|---|---|
| correct | `skills/correct` | verbatim |
| benchmark-checklist | `skills/benchmark-checklist` | verbatim |
| unslop | `skills/unslop` | verbatim |
| 24 × principle-* | `skills/principle-*` | verbatim; `explain-the-number`'s relative link to `benchmark-checklist` resolves in-repo |
| no-comments | `skills/no-comments` + `agents/comment-sicko.md` | Comment Sicko agent file → `no-comments/references/comment-sicko.md`; Cursor `Task`/`subagent_type` spawn → fresh isolated read-only review (`fresh_review` or headless pi); `/why` → read the commit history that introduced it |
| architect | `skills/architect` | runner-panel mechanics → "follows the **arena** skill"; todolist → state the phases in the reply; `/why` → commit history; `interrogate` pointer → inline "adversarial review that keeps only findings a run proves" (interrogate not vendored) |
| arena | `skills/arena` | Cursor model-slug/Task mechanics → pi headless processes in worktrees; runner and cross-judge selection → "models configured for this pi setup", cross-judge degrades to skip when no other family is configured; todolist → state the phases in the reply |
| swarm | `skills/swarm` | Cursor `Task`/cloud-environment mechanics → pi headless processes, one git worktree each (the repo's worktree convention); worker model → session model by default; todolist → state the phases in the reply |
| create-verification-skill | `skills/create-verification-skill` | generated-skill output path `.cursor/skills/verify-<app>/` → `.agents/skills/verify-<app>/` |
| maintain-verification-skill | `skills/maintain-verification-skill` | same path change; "subagent" → "fresh read-only review process" |
| create-formal-verification-skill | `skills/create-formal-verification-skill` | `/statechart` → the **statechart** skill by name; slash commands → skill names |
| maintain-formal-verification-skill | `skills/maintain-formal-verification-skill` | slash commands → skill names |
| statechart | `skills/statechart` | verbatim except `scripts/package.json` name `@cursor-skill/statechart` → `statechart-scripts` (private, cosmetic). First run installs TLC + Java via mise (needs network); `fast-check` is a scripts-only test dep. The scripts are a side-by-side tool launched by the agent that uses the skill (not loaded as a pi skill directly) |

### Excluded (and why)

- **interrogate** — overlaps our three-axis `code-review`; its "finding survives only when a run proves it" brief is a candidate for our Adversarial Bugs axis (discuss)
- **tdd, teach, technical-writing** — name collisions with our mattpocock-adapted skills (discuss)
- **poteto-mode, poteto-help, setup-pstack** — the Cursor working-style layer: plan mode, custom modes, `/loop`, model-role rules, multi-model panels. Revisit if we want her voice in pi
- **how, why, recall, ketchup, ketchup-video, bro, in-your-own-words, sharpen, reflect, automate-me, figure-it-out, show-me-your-work** — pstack's conversational layer; `recall` assumes Cursor chat-history tooling, the rest are working style, not pyramid building
- **make-bot-ui, benny automations** — Grokbot/Cursor-automation specific
- **typescript-best-practices** — language-specific list; lint + type checker already carry it in this repo

## Conventions the adopted set assumes

- Specs: `.scratch/specs/<slug>.md`; tickets and maps: `.scratch/maps/<slug>/`; research findings: `.scratch/research/<name>.md`. All git-tracked.
- `skills/documentation-reference/` is a shared reference bundle (no SKILL.md, not a loadable skill) that `documentation-review` and `technical-writing` point at.
- `GLOSSARY.md` at repo root for domain vocabulary; ADRs as markdown (see `domain-modeling`).
- Cross-skill references use pi skill loading (`/skill:<name>` or natural load-by-description), not Claude's Skill tool.
- Generated project-local skills (from the verification-skill pairs) land in `.agents/skills/`.
