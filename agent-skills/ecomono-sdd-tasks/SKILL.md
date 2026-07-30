---
name: ecomono-sdd-tasks
description: "Break a change into ordered, verifiable tasks and forecast the review budget. Trigger: orchestrator launches tasks after spec and design."
disable-model-invocation: true
user-invocable: false
metadata:
  version: "2.0"
  delegate_only: true
---

**You are the executor.** Write the breakdown yourself, do not delegate, do not call the
Skill tool. Reached this through `Skill`? You are the orchestrator — stop and delegate to
the `ecomono-sdd-tasks` sub-agent instead.

Skill loading, retrieval, persistence and the return envelope are sections A–D of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Artifacts default to
English.

## Purpose

Turn proposal, spec and design into ordered, actionable tasks — and forecast whether the
implementation will blow the review budget, because that decision has to happen here,
before anyone writes code.

**Reads:** `sdd/{change-name}/proposal`, `sdd/{change-name}/spec`,
`sdd/{change-name}/design` — all three required.
**Also receives:** `delivery_strategy` from the orchestrator.
**Writes:** artifact `tasks`, at `sdd/{change-name}/tasks`.

## Every task must be

| Criterion | Yes | No |
|---|---|---|
| Specific | "Create `internal/auth/middleware.go` with JWT validation" | "Add auth" |
| Actionable | "Add `ValidateToken()` to `AuthService`" | "Handle tokens" |
| Verifiable | "Test: `POST /login` returns 401 without token" | "Make sure it works" |
| Small | One file, or one logical unit | "Implement the feature" |

A task apply cannot start without asking a question is not a task. Apply runs in a fresh
context and cannot ask.

## Phases, by dependency

Order by what unblocks what, not by importance:

1. **Foundation** — new types, interfaces, schema, config. What other tasks depend on.
2. **Core** — the main logic and business rules.
3. **Integration** — wiring, routes, UI. Making the pieces meet.
4. **Testing** — against spec scenarios specifically, not against the implementation.
5. **Cleanup** — docs, dead code. Only if there is any.

Skip a phase that has nothing in it. Empty phases are scaffolding.

## Review workload forecast

Estimate whether implementation will exceed the **400 changed-line** review budget
(`additions + deletions`). This is a planning guard, not a diff count — signals are file
count, phases, integration points, tests, docs, generated artifacts, migrations, and how
many concerns the change crosses.

**High, or likely over 400:**

1. Mark `Chained PRs recommended: Yes`.
2. Split into **work units** that can each become a PR — each with a clear start, a clear
   finish, its own verification, and autonomous scope. Split along deliverables, never
   along line counts.
3. Ask which chain strategy applies. This is a team decision, not yours:
   - **`stacked-to-main`** — each PR merges to main in order. Fast, fix as you go. Best
     for independent slices.
   - **`feature-branch-chain`** — PR #1 targets the tracker branch, each later PR targets
     the previous PR's branch, only the tracker reaches main. Best for rollback control.
   - **`size-exception`** — one PR with maintainer approval. Best for generated code,
     migrations, vendor diffs.
4. Set `Decision needed before apply` from `delivery_strategy`:

| Strategy | Decision needed | Because |
|---|---|---|
| `ask-on-risk` | `Yes` | Orchestrator asks before apply |
| `auto-chain` | `No` | Orchestrator proceeds with the first slice |
| `single-pr` | `Yes` | `size:exception` must be recorded first |
| `exception-ok` | `No` | Maintainer already accepted it |

Put the forecast at the **top** of the artifact. Buried in prose, the user sees it after
implementation started, which is too late for it to be a decision.

### The guard contract

These four lines must appear **verbatim**. Downstream guards match them literally, so
rephrasing silently disables the guard:

```text
Decision needed before apply: Yes|No
Chained PRs recommended: Yes|No
Chain strategy: stacked-to-main|feature-branch-chain|size-exception|pending
400-line budget risk: Low|Medium|High
```

Keep the readable table too if you like — but the plain lines are the contract.

For `feature-branch-chain`, each work unit names its intended base: PR #1 → tracker
branch, PR #2 → PR #1's branch, and so on. A child PR showing previous slices means the
base is wrong; it gets retargeted or rebased before review.

## Artifact

```markdown
# Tasks: {Change Title}

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | {estimate or range} |
| 400-line budget risk | Low \| Medium \| High |
| Chained PRs recommended | Yes \| No |
| Suggested split | {single PR, or PR 1 → PR 2 → PR 3} |
| Delivery strategy | {as passed} |
| Chain strategy | {chosen, or pending} |

Decision needed before apply: {Yes|No}
Chained PRs recommended: {Yes|No}
Chain strategy: {…}
400-line budget risk: {…}

### Suggested Work Units
| Unit | Goal | Likely PR | Base branch | Notes |
|---|---|---|---|---|
| 1 | {standalone deliverable} | PR 1 | {tracker} | tests and docs included |

## Phase 1: Foundation
- [ ] 1.1 {concrete action — which file, which change}

## Phase 2: Core
- [ ] 2.1 {concrete action}
```

## Rules

- Every task traces to a spec requirement or a design decision. A task tracing to
  neither is scope creep with a checkbox.
- Cover the spec completely. A requirement with no task is how a change ships missing
  behaviour that verify then flags as CRITICAL.
- Tests are tasks, written against spec scenarios. Not "add tests" — which scenario.
- Order by dependency and say so where it is not obvious.
- The forecast is mandatory even when the answer is `Low`. A missing forecast reads
  identical to a small change.
- Do not decide the chain strategy yourself. Forecast, recommend, and let the team
  choose.
