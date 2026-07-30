---
name: ecomono-sdd-onboard
description: "Teach SDD by running one real cycle on the user's own codebase. Trigger: user asks to learn SDD or for a guided walkthrough."
disable-model-invocation: true
user-invocable: false
metadata:
  version: "1.0"
  delegate_only: false
---

> Runs **inline**, not delegated. It is an interactive walkthrough: the value is the
> conversation, and a sub-agent cannot have it.

Artifacts default to English — see the Language section of
[sdd-orchestrator.md](../ecomono-sdd-shared/sdd-orchestrator.md).

## Purpose

Take the user through one complete SDD cycle — explore to archive — on **their real
codebase**, producing real artifacts. Not a toy example. Teaching by doing, because the
point that lands is seeing their own code go through the pipeline.

Narrate every phase: what you are doing, and *why* the phase exists. The why is the part
they keep.

## 1. Pick something real

Explain what is about to happen, then scan for a genuine small improvement.

A good onboarding change is:

- **Small** — finishable in one session.
- **Low risk** — no breaking changes, no data migration.
- **Genuinely useful** — a toy change teaches the mechanics and none of the judgement.
- **Spec-worthy** — at least one clear requirement and two scenarios. Without that, spec
  and verify have nothing to demonstrate.

Good candidates: missing input validation on a form or endpoint, inconsistent error
messages in an auth flow, a utility worth extracting, a missing loading or error state, a
TODO whose intent is clear.

Offer 2–3 options. Let them pick, or take their own suggestion — their idea beats yours
here, because they will care about the outcome.

## 2. Run the cycle, narrating each phase

Follow each phase skill's actual format. The artifacts must be real, not illustrations.

| Phase | Say what it is for | Point out |
|---|---|---|
| **Explore** | We investigate before committing to anything | What the code actually does, versus what you assumed |
| **Propose** | We write down what and why. This is the contract | The Capabilities section — it tells spec exactly what to write |
| **Spec** | What the system must do, in testable terms. No implementation | GIVEN/WHEN/THEN — each scenario is a future test, and what verify checks |
| **Design** | How we build it | The decisions section: every choice carries its why, so it can be re-evaluated later |
| **Tasks** | The work, broken into checkable steps | "Implement feature" is not a task. "Create `src/utils/validate.ts` with `validateEmail()`" is |
| **Apply** | Now the code. Tasks guide, specs define done | Each task marked complete as it lands, not at the end |
| **Verify** | Prove it, do not assert it | Tests actually run. Source that looks correct is a hypothesis |
| **Archive** | Merge the delta into the baseline and close | The main spec is now the accumulated behaviour — this is what makes it spec-*driven* |

Strict TDD active during apply → walk the RED → GREEN → REFACTOR cycle out loud. Watching
a test fail first is the moment TDD stops being an abstraction.

Pause after each phase. Show what was produced, ask whether they want to adjust before
continuing. Approval is per phase — "continue" means this next one, not the rest.

## 3. Close

Recap what exists now that did not before: the artifacts, the code, the merged baseline.
Then name what they can do next — `/ecomono-sdd-new` for their own change,
`/ecomono-sdd-status` to see where one stands.

Be honest about the ceiling too. SDD is worth this overhead for substantial changes and
is pure friction for a one-line fix; someone who learns it as a ritual for everything
will abandon it. Say which of their real upcoming changes would suit it.

## Rules

- Real artifacts, real code, real archive. A simulated cycle teaches nothing they can
  repeat.
- Explain **why** before **how**, every phase. The mechanics are discoverable; the
  reasoning is not.
- Never skip verify to save time. It is the phase that makes the rest mean anything, and
  skipping it teaches that it is optional.
- Do not pick a change that needs a migration or touches auth, payments or security. The
  first cycle should not also be a risk conversation.
- Stop if they lose the thread. Finishing the checklist with a confused user is a
  completed demo and a failed onboarding.
