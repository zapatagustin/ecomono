---
name: ecomono-sdd-apply
description: "Implement SDD tasks from spec and design. Trigger: orchestrator launches apply for one or more change tasks."
disable-model-invocation: true
user-invocable: false
metadata:
  version: "3.0"
  delegate_only: true
---

## Who runs this

**You are the executor.** Implement the assigned tasks yourself. Do not delegate, do
not call the Skill tool, do not spawn sub-agents.

> **If you reached this through the `Skill` tool you are the ORCHESTRATOR — stop.**
> Delegate to the `ecomono-sdd-apply` sub-agent instead. Running a phase inline is
> how an orchestrator's context ends up holding every file the phase touched.

Artifacts default to **English** — see the Language section of
[sdd-orchestrator.md](../ecomono-sdd-shared/sdd-orchestrator.md). Do not inherit the
conversation's language or the persona's voice into code, comments or artifacts.

## Inputs

From the orchestrator: change name, the specific tasks to implement, artifact store
mode, the structured status per
[sdd-status-contract.md](../ecomono-sdd-shared/sdd-status-contract.md), and the
resolved delivery decision (`delivery_strategy`, `chain_strategy`, and any accepted
`size:exception`).

Skills: section A of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Retrieval: section
B. Persistence: section C. Return envelope: section D.

## Gate before any edit

Consume the structured status first, or rebuild it from artifacts. Readiness is never
inferred from the conversation.

| `applyState` | Do |
|---|---|
| `blocked` | STOP. Return `blocked` naming the missing artifact or unsafe context |
| `all_done` | Do not edit. Return `success`, `next_recommended` per dependency state |
| `ready` | Proceed, on the assigned pending tasks only |

Edit scope is a safety boundary, not bookkeeping:

- `allowedEditRoots` present → edit only inside those roots.
- A needed edit falls outside them → STOP and report the path. Do not widen your own
  scope.
- Cannot prove a file is inside the workspace → STOP and ask.

## Sequence

### 1. Read before writing

In this order, because each one constrains the next:

1. The tasks artifact — what you were asked for.
2. The spec — what the code must do. These are your acceptance criteria.
3. The design — how it must be structured. These constrain your approach.
4. The existing code in the affected files — the patterns you must match.

Read all four before the first edit. Writing code against a half-read spec produces
work that passes review and fails verification.

### 2. Enforce the workload decision

Inspect the tasks artifact for `Review Workload Forecast`. If any of
`400-line budget risk: High`, `Chained PRs recommended: Yes`, or
`Decision needed before apply: Yes`, a resolved delivery path MUST already be in your
prompt:

| Resolution | Do |
|---|---|
| `auto-chain`, or a chosen chained/stacked mode | Implement only the assigned work-unit slice. Keep it autonomous. Report the PR boundary |
| `exception-ok`, or single PR with exception | Continue only if the prompt explicitly records that `size:exception` was accepted |
| `single-pr` above budget | Continue only after the prompt records `size:exception` |

Follow `Chain strategy` when present and not `pending`:

- `stacked-to-main` — each PR targets the previous PR's branch, or `main` once that
  one merged.
- `feature-branch-chain` — PR #1 targets the tracker branch, each later PR targets
  the immediately previous PR branch. Only the tracker reaches `main`. A child diff
  showing earlier slices defeats the point; retarget or rebase until it is clean.

Neither present → STOP before writing code and return `blocked` with:
`Workload decision required before apply: estimated work may exceed 400 changed lines. Ask which chain strategy to use (stacked-to-main, feature-branch-chain, or size-exception).`

### 3. Read previous progress

Search `sdd/{change-name}/apply-progress`. Found → `mem_get_observation`, read it in
full, and start from the first incomplete task.

**If the orchestrator told you previous progress exists, reading it is mandatory.**
Saving over it without reading permanently loses every batch before yours.

### 4. Resolve the mode

Read cached testing capabilities from `ecomono-sdd-init/{project}`, falling back to
the project files (`package.json`, `go.mod`, …).

- `strict_tdd: true` **and** a test runner exists → **strict TDD**. Read
  [strict-tdd.md](strict-tdd.md) and follow its cycle instead of step 5.
- Otherwise → **standard**. `strict-tdd.md` is never read, so it costs nothing.

Cache the resolved mode for your return summary.

**Strict TDD has no silent fallback.** If you resolved it active, you follow it or
you report failure. Quietly switching to standard mode makes the verify phase's
evidence check meaningless.

Under strict TDD you MUST emit a **TDD Cycle Evidence** table in apply-progress, one
row per task with RED (test written first) → GREEN (implementation passes) →
REFACTOR. A task completed without a test written first is marked FAILED in that
table, honestly. Verify rejects work whose evidence table is missing or incomplete.

### 5. Implement (standard mode)

Per task: read the task, then its spec scenarios, then the design constraints, then
the surrounding code patterns. Write the code. Mark the task `[x]` in the persisted
tasks artifact **immediately**, not at the end of the batch — a crash between task 3
and the final save otherwise loses three tasks of state.

Note deviations and issues as they happen; reconstructing them at the end loses the
reason.

### 6. Persist

Mandatory. Section C, artifact `apply-progress`, topic key
`sdd/{change-name}/apply-progress`. Also mark the completed tasks `[x]` in the tasks
artifact via `mem_update(id: {tasks-observation-id}, …)`.

**Merge, never overwrite.** Your saved artifact must carry every previously completed
task — status and evidence — plus your own, as one cumulative record across all
batches.

Once merged and saved, the previous apply-progress is superseded: carry its task
status forward and stop quoting its reasoning. A task closed in batch 1 does not get
re-litigated in batch 3, and superseded rationale costs exactly what current
rationale costs while pointing at code that has moved. Need its detail again →
re-fetch the current artifact rather than citing the copy from earlier in the thread.

### 7. Return

Before returning, re-read the persisted tasks artifact and confirm every task you
report complete is actually `[x]` there. Fix any that are not. Internal todo state is
not completion evidence, and reporting `Ready for verify` while completion exists
only in your own notes sends verify looking for work that was never recorded.

```markdown
## Implementation Progress

**Change**: {change-name}
**Mode**: {Strict TDD | Standard}

### Completed
- [x] {task 1.1}

### Files changed
| File | Action | What |
|---|---|---|
| `path/to/file.ext` | Created \| Modified | {brief} |

{Strict TDD → the TDD Cycle Evidence table}

### Deviations from design
{Where and why, or "None — implementation matches design."}

### Issues found
{What surfaced, or "None."}

### Remaining
- [ ] {next task}

### Workload / PR boundary
- Mode: {single PR | chained slice | stacked slice | size:exception}
- Work unit: {name or N/A}
- Boundary: {what this batch starts from and ends with}

### Status
{N}/{total} complete. {Ready for next batch | Ready for verify | Blocked by X}
```

## Rules

- Spec before implementation. It is the acceptance criteria, not background reading.
- Follow the design. Finding a better approach mid-task is not licence to take it —
  note it and continue, or stop and report.
- Match the project's existing patterns over your own preference.
- Implement only what was assigned. Adjacent work that "was right there" is scope
  creep and lands unreviewed.
- Design wrong or incomplete → say so in the return summary. Never silently deviate;
  a deviation nobody was told about becomes the next phase's mystery.
- Task blocked by something unexpected → STOP and report. Do not improvise around it.
- Applying a slice → keep the batch autonomous: one deliverable scope, its
  verification, a clean rollback boundary.
- Applying `size:exception` → state it in both apply-progress and the return summary.
- Follow every skill loaded in section A strictly while writing code.
