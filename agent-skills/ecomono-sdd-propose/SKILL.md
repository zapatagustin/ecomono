---
name: ecomono-sdd-propose
description: "Turn exploration into a change proposal: intent, scope, approach, risks. Trigger: orchestrator launches propose for a change."
disable-model-invocation: true
user-invocable: false
license: MIT
metadata:
  author: gentleman-programming
  derived_from: Gentleman-Programming/gentle-ai (sdd-propose)
  modified: true
  version: "2.0"
  delegate_only: true
---

**You are the executor.** Write the proposal yourself, do not delegate, do not call the
Skill tool. Reached this through `Skill`? You are the orchestrator — stop and delegate
to the `ecomono-sdd-propose` sub-agent instead.

Skill loading, retrieval, persistence and the return envelope are sections A–D of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Artifacts default to
English.

## Purpose

Turn the exploration — or the user's direct description — into a proposal: what problem,
what scope, which approach, what risk. This is the phase where **product** decisions get
made explicit, before anyone writes a spec against them.

**Reads:** `sdd/{change-name}/explore` (optional),
`ecomono-sdd-init/{project}` (optional).
**Writes:** artifact `proposal`, at `sdd/{change-name}/proposal`.

## Question round

In interactive mode, do **not** silently decide the request is clear enough. Offer a
question round first, and say what it is for: surfacing business rules, implications,
edge cases and product tradeoffs so the proposal is not built on an assumption nobody
checked.

**3–5 concrete product questions per round.** Then summarize the assumptions your
answers produced and ask whether to correct them or run a second round.

Draw from the smallest useful subset of:

1. **Business problem** — what pain, opportunity, confusion or operational cost makes
   this worth doing *now*.
2. **Target users and situations** — who, in which workflow, at what moment, how urgent.
3. **Business rules** — policies, permissions, thresholds, lifecycle rules,
   compliance expectations, domain invariants the proposal must respect.
4. **Product outcome** — what should feel, work or become possible afterwards.
5. **Current-state gap** — what is wrong, inconsistent, missing or hard to explain today.
6. **Implications** — which teams, workflows, data, UX expectations, support burden or
   operations get touched.
7. **Edge cases** — empty states, partial data, failures, permissions, slow paths,
   unusual customers, migration states, conflicting needs.
8. **Decision gaps** — which unknowns would make this ambiguous, risky, or easy to
   overbuild.
9. **Scope boundaries and non-goals** — first slice, later refinement, and what must
   stay unchanged even though it is related.
10. **Business tradeoff** — the downside that matters most if this picks the wrong
    direction.

**Do not ask about test commands, PR shape, or line budgets.** That is harness
mechanics, and raising it here derails a product conversation. Delivery gets decided at
tasks time.

Cannot ask directly → write a `## Proposal question round` section into the proposal
with the questions and the assumptions that need review, rather than guessing and
presenting the guess as settled.

## The proposal

```markdown
# Proposal: {Change Title}

## Intent
{What problem, and why now. Specific about the user need or the debt being paid.}

## Scope
### In Scope
- {concrete deliverable}
### Out of Scope
- {explicitly not doing, or deferred}

## Capabilities
> The contract between this phase and spec. ecomono-sdd-spec reads it to know exactly
> which capabilities to write requirements for.

### New
- `capability-name`: {what it covers}   <!-- kebab-case. Empty if none -->
### Modified
- `existing-capability`: {which requirement changes}   <!-- spec-level behaviour only -->

## Approach
{High-level technical approach. Reference exploration's recommendation when there is one.}

## Affected Areas
| Area | Impact | Description |
|---|---|---|
| `path/to/area` | New \| Modified \| Removed | {what changes} |

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|

## Rollback Plan
{How to revert. Specific — "revert the commit" is not a plan if there is a migration.}

## Dependencies
- {external prerequisite, if any}

## Success Criteria
- [ ] {how we know it worked — measurable}
```

The **Capabilities** section is a contract, not commentary. A capability listed here
becomes requirements in spec; one omitted gets no spec and then no tasks, and the gap
surfaces at verify.

## Rules

- Scope is the deliverable. Vague scope is what produces a change that never ends.
- Out of Scope is not optional. Naming what you are *not* doing is what stops the
  proposal from silently growing between here and apply.
- Rollback plan must be real. If the change is irreversible, say that instead of
  inventing a reassuring sentence.
- Success criteria measurable. "Works better" cannot be verified, so verify will not
  be able to.
- Reference exploration where it exists, including the approaches it rejected — a
  rejected option re-proposed here wastes the whole chain.
