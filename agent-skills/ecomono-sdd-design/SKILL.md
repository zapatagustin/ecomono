---
name: ecomono-sdd-design
description: "Produce the technical design: architecture decisions, data flow, file changes. Trigger: orchestrator launches design for a change."
disable-model-invocation: true
user-invocable: false
metadata:
  version: "2.0"
  delegate_only: true
---

**You are the executor.** Design it yourself, do not delegate, do not call the Skill
tool. Reached this through `Skill`? You are the orchestrator — stop and delegate to the
`ecomono-sdd-design` sub-agent instead.

Skill loading, retrieval, persistence and the return envelope are sections A–D of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Artifacts default to
English.

## Purpose

Take the proposal and produce **how** the change gets built: architecture decisions,
data flow, file changes, rationale. The spec says what must be true; you say how.

**Reads:** `sdd/{change-name}/proposal` (required),
`sdd/{change-name}/spec` (optional — may not exist yet if spec and design run in
parallel).
**Writes:** artifact `design`, at `sdd/{change-name}/design`.

## Sequence

### 1. Read the actual code

Before designing anything: entry points and module structure, existing patterns and
conventions, dependencies and interfaces, the test infrastructure.

A design written against an imagined codebase is worse than no design — apply will
follow it, and the mismatch surfaces as failing tests nobody predicted.

### 2. Design

**Size budget: under 800 words.** Decisions as tables, code snippets only for a
non-obvious pattern. A design longer than the change is a design nobody reads before
implementing.

```markdown
# Design: {Change Title}

## Technical Approach
{The overall strategy, and how it maps to the proposal's approach}

## Architecture Decisions
### {Decision title}
**Choice**: {what} · **Rejected**: {alternatives} · **Why**: {rationale}

## Data Flow
{How data moves for this change. Simple ASCII when it helps — clarity over beauty}

    Component A ──→ Component B ──→ Component C
         └──────── Store ───────────┘

## File Changes
| File | Action | Description |
|---|---|---|
| `path/new.ext` | Create | {what it does} |
| `path/existing.ext` | Modify | {what changes and why} |
| `path/old.ext` | Delete | {why it goes} |

## Interfaces / Contracts
{New interfaces, API contracts, types, data structures — in the project's language}

## Testing Strategy
| Layer | What to test | Approach |
|---|---|---|

## Migration / Rollout
{Data migration, feature flags, phased rollout — or "No migration required."}

## Open Questions
- [ ] {unresolved technical question}
```

### 3. Persist and return

Section C, artifact `design`, topic key `sdd/{change-name}/design`.

```markdown
## Design Created

**Change**: {change-name}

### Summary
- Approach: {one line}
- Key decisions: {N} documented
- Files affected: {N} new, {M} modified, {K} deleted
- Testing: {planned coverage}

### Open Questions
{List, or "None"}

### Next
Ready for tasks (ecomono-sdd-tasks).
```

## Rules

- Read the codebase before designing. Never guess at what is there.
- Every decision carries its **why**. A choice without a rationale cannot be
  re-evaluated later, so it hardens into folklore.
- Concrete file paths, not abstract descriptions. Apply needs to act on this.
- Use the project's **actual** patterns, not generic best practice. Where the codebase
  does something you would not have chosen, note it and follow it anyway — unless this
  change is specifically about fixing that.
- An open question that **blocks** the design → say so and stop. A guessed decision
  looks identical to a made one three phases downstream.
