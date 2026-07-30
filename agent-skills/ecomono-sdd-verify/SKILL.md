---
name: ecomono-sdd-verify
description: "Validate implementation against spec, design and tasks. Trigger: orchestrator launches verification for a change."
disable-model-invocation: true
user-invocable: false
license: MIT
metadata:
  author: gentleman-programming
  derived_from: Gentleman-Programming/gentle-ai (sdd-verify)
  modified: true
  version: "3.0"
  delegate_only: true
---

## Who runs this

**You are the executor.** Verify yourself. Do not delegate, do not call the Skill
tool, do not fix anything.

> **If you reached this through the `Skill` tool you are the ORCHESTRATOR — stop.**
> Delegate to the `ecomono-sdd-verify` sub-agent. Verifying inline also costs you the
> independence that makes the verdict worth anything.

Artifacts default to **English** — see the Language section of
[sdd-orchestrator.md](../ecomono-sdd-shared/sdd-orchestrator.md).

## Activation

Run when the orchestrator launches verification. You are the quality gate: prove
completion with source inspection **plus real execution evidence**.

Consume the structured status per
[sdd-status-contract.md](../ecomono-sdd-shared/sdd-status-contract.md) before judging
anything — artifact states, task progress, dependency states, `actionContext`.

Skills: section A of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Retrieval: section
B. Persistence: section C. Return envelope: section D.

## Hard rules

- **Execution, not inspection.** Static reading is never verification. A spec
  scenario is compliant only when a covering test **passed at runtime**. Source that
  looks correct is a hypothesis, not evidence.
- Read every available artifact before judging. Partial sets degrade as below; they
  do not license guessing at the missing dimension.
- Order matters: spec first, design second, task completion third. Task checkboxes
  are the weakest signal — they record intent, not behaviour.
- **Do not fix anything.** Report for the orchestrator. A verifier that patches what
  it found has no independent verdict left to give.
- Verify against the artifacts you fetch **this run**, never a prior `verify-report`
  or a summary of one. A report from before the last apply describes code that no
  longer exists — it costs what current evidence costs and misleads. Re-derive its
  findings or drop them; never carry one forward on the strength of having been said
  once.
- Strict TDD active → load [strict-tdd-verify.md](strict-tdd-verify.md). Inactive →
  never load it, so it costs nothing.

## Decision gates

| Condition | Action |
|---|---|
| Orchestrator says `STRICT TDD MODE IS ACTIVE` | Authoritative. Load the module |
| Cached `strict_tdd: true` and a runner exists | Strict TDD verify. Load the module |
| Strict TDD false, or no runner | Standard verify. Skip TDD checks |
| Only the tasks artifact exists | Verify task completion only. Record what you skipped |
| Tasks + spec | Verify completeness and correctness. Skip design coherence, record it |
| Proposal + spec + design + tasks | Verify every dimension |
| Any implementation task unchecked | **CRITICAL** — blocks archive readiness |
| A cleanup task unchecked | WARNING |
| Test command exits non-zero | **CRITICAL** |
| Spec scenario with no passing covering test | **CRITICAL** — `UNTESTED` or `FAILING` |
| Design deviation | WARNING, unless it breaks a spec — then CRITICAL |
| `MODIFIED` block with fewer scenarios than the main spec's requirement | **CRITICAL** — see below |
| `allowedEditRoots` cannot be proven | STOP. Report rather than verifying blind |

### Delta completeness

You run **before** archive, which is the last chance to catch a truncated delta before a
destructive merge.

For every `MODIFIED` requirement in `sdd/{change-name}/spec`, read the current
`spec/{capability}` and compare scenario counts. Fewer in the delta → **CRITICAL**,
naming the requirement and both counts. Archive replaces the requirement wholesale, so
the omitted scenarios would be deleted from the baseline with no git history to recover
them.

A deliberate drop belongs in `REMOVED` with its `Reason` and `Migration`, not in a
shorter MODIFIED block. Report the accounting either way — `{capability} / {requirement}: 4 → 5`.

## Sequence

1. Load skills (section A).
2. Retrieve artifacts (section B) — every one the status says exists.
3. Resolve the TDD mode from cached capabilities or the project files.
4. Count complete and incomplete tasks.
5. Spec exists → map every requirement and scenario to implementation evidence **and
   to a test**.
6. Design exists → check its decisions against the changed code. Missing → skip
   coherence and record why you skipped it.
7. Run the test, build/type-check and coverage commands available. This is the step
   that separates verification from review.
8. Build the behavioural compliance matrix from **actual test results**, not from
   what the code appears to do.
9. Persist and return, naming every dimension you skipped.

Report what you ran and what it printed. A verdict without command output is an
opinion.

## Graceful degradation

| Artifacts present | Verdict may reach | Never claim |
|---|---|---|
| Tasks only | `PASS WITH WARNINGS`, task completion only | Spec correctness, design coherence |
| Tasks + spec | Full spec verdict when runtime evidence exists | Design coherence |
| Full set | Any verdict | — |

Missing covering tests for a required scenario stay CRITICAL unless project config
explicitly allows manual verification. Unchecked implementation tasks stay CRITICAL
regardless of what else is missing — that one has no degraded form.

Say which dimensions you could not check. A verdict that hides its own blind spots is
worse than a `partial`, because the orchestrator will archive on it.

## Output

`## Verification Report` with: change and mode, a completeness table, build/test/coverage
evidence including the commands and their output, the spec compliance matrix, a
correctness table, design coherence, issues grouped CRITICAL / WARNING / SUGGESTION,
and a final verdict of `PASS`, `PASS WITH WARNINGS` or `FAIL`.

Full template and the compliance status values:
[references/report-format.md](references/report-format.md).
