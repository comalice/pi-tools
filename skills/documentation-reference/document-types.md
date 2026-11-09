# Documentation types

Read the relevant sections only. These are prompts for investigation, not mandatory templates; follow the repository's established conventions.

## Entry points and setup

Identify the reader, supported platforms and versions, prerequisites, install/build/start steps, expected outcomes, and where to go next. Separate development from production and actual commands from placeholders. Check commands against current scripts and CLI help when safe.

## Operational and safety procedures

Identify prerequisites, permissions, device or environment, expected state, observable success/failure, recovery and hazards. Preserve unit, power, data, and equipment warnings. State when behavior or procedures are unverified; ask an owner about consequential ambiguity. Never operate equipment to validate a document without explicit authorization.

## Architecture and as-built behavior

Explain the boundaries, responsibilities, dependencies, data/control flow and relevant deployment assumptions. Compare diagrams and prose to configuration, entry points, callers, and tests. Cite both the declaration and its use when they jointly establish a runtime claim. Label planned or legacy components. Link non-obvious behavior to durable source files where useful; do not claim tests prove undocumented intent.

## Specifications and decisions

A spec describes agreed intent, constraints, acceptance criteria and scope, not necessarily current implementation. An ADR records a consequential decision and its rationale; preserve rejected alternatives, status and supersession. If implementation differs, surface the conflict and establish intent rather than rewriting the spec to match code. Do not invent a decision or retrospective rationale.

## API, CLI and configuration

Check names, types, defaults, units, validation, error behavior, authentication, version and platform assumptions. A documented example needs accurate prerequisites and expected results. Treat examples that perform writes, deployment, network access or hardware operations as unsafe until confirmed otherwise.

## Glossaries

Keep project-specific terms and their boundaries concise. Derive definitions from the domain and confirm contested meanings with an owner. A glossary is not a dumping ground for specifications, implementation detail or inferred policy.

## Agent-facing instructions and skills

Describe actionable, project-specific behavior and when to load supporting references. Keep routine steps and completion criteria clear; disclose branch-specific reference on demand. Avoid repeated instructions or facts available cheaply from a canonical source. Test instruction changes for behavior, not merely length.

## Generated, published and historical artifacts

Locate the source, generator, published target and ownership before editing generated output. Validate or propose regeneration only when safe and authorized. Preserve historical records and label their scope; an old statement is not stale if it accurately describes a historical release. Identify external or unavailable sources rather than guessing.
