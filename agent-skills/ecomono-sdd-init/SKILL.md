---
name: ecomono-sdd-init
description: "Bootstrap SDD in a project: detect stack, resolve strict TDD, cache context and registry. Trigger: sdd init, iniciar sdd, or any SDD command finding no init."
disable-model-invocation: true
user-invocable: false
license: MIT
metadata:
  author: gentleman-programming
  derived_from: Gentleman-Programming/gentle-ai (sdd-init)
  modified: true
  version: "3.0"
  delegate_only: true
---

**You are the executor.** Detect and persist yourself, do not delegate, do not call the
Skill tool. Reached this through `Skill`? You are the orchestrator — stop and delegate to
the `ecomono-sdd-init` sub-agent instead.

Skill loading, retrieval, persistence and the return envelope are sections A–D of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Artifacts default to
English.

## Purpose

Bootstrap SDD for a project: detect what is really there, resolve whether strict TDD
applies, cache both so every later phase runs with project context instead of guessing.

Every SDD command checks for this first, and nothing downstream works well without it.
Undetected testing capabilities mean strict TDD never activates; missing conventions mean
phases fall back to generic best practice instead of the project's own.

**Writes:** `ecomono-sdd-init/{project}` — stack, conventions, testing capabilities — and
`.atl/skill-registry.md`.

## Hard rules

- **Detect, never guess.** Read the real files. An invented convention is worse than none,
  because every later phase will faithfully follow it.
- Detection is read-only. The only file you produce is the skill registry; no SDD
  artifacts go into the project tree.
- Persist testing capabilities separately so `apply` and `verify` resolve TDD mode from
  cache instead of re-detecting on every launch.

## Detection

1. **Stack and conventions** — `package.json`, `go.mod`, `pyproject.toml`, CI config,
   lint and format config. Summarize what the project actually does, and specifically
   where it diverges from the ecosystem default: that divergence is what later phases
   must match.
2. **Testing capabilities** — test runner and its exact command, available layers (unit,
   integration, E2E), coverage tool, linter, type checker, formatter.
3. **Strict TDD**, resolved in this order:

| Signal | Result |
|---|---|
| Explicit marker or project config | Use that value — stated intent wins |
| No marker, but a test runner exists | `strict_tdd: true` |
| No test runner | `strict_tdd: false`, and say why it is unavailable |

Defaulting to `true` when a runner exists is deliberate. A project with tests and no
stated preference gets the stricter path and the user can switch it off; the reverse drops
the discipline silently, which nobody notices until verify has nothing to check.

## Then

4. Persist project context and testing capabilities to `ecomono-sdd-init/{project}`.
5. Build the registry: `node ~/.claude/hooks/ecomono-skill-registry.js --cwd <repo>`.
   Also save it to memory as `skill-registry` when the backend answers, so a delegator can
   recover its selection after a compaction.
6. Return the envelope.

Detection checklist, payload shapes and output templates:
[references/init-details.md](references/init-details.md). Artifact naming:
[memory-convention.md](../ecomono-sdd-shared/memory-convention.md).

## Output

Beyond the section D envelope: project name, stack, persistence mode, strict TDD status
**with the signal that decided it**, the testing capability table, saved observation IDs,
the registry path, and the next step (`/ecomono-sdd-explore` or `/ecomono-sdd-new`).

Name the deciding signal, not just the verdict. `strict_tdd: true` tells the user nothing
they can act on; `true — vitest detected, no explicit preference set` tells them where the
switch is.

Anything you could not detect goes in `risks`, named. A silent gap here becomes a
confident wrong assumption in every phase that follows.
