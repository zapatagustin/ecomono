---
name: ecomono-brainstorm
description: >
  Explore intent, requirements and design before any implementation. Use before
  creating a feature, building a component, adding functionality, or changing
  behavior — and before entering plan mode. Use when the user says "let's build",
  "I want to add", "brainstorm this", "how should we structure", "design this", or
  invokes /ecomono-brainstorm. Produces an agreed design, not code.
---

Understand the problem before shortening the solution. The build ladder shortens
solutions; it never shortens reading.

## Run inline

This is the ONE phase where shared context wins. The design lives in the
conversation — the user's corrections, the rejected options, the constraint they
mentioned in passing. Delegating it throws that away. Do not spawn a subagent to
brainstorm. Everything downstream of the agreed design gets isolated instead.

## Hard rules

- No code until the design is agreed. Not a sketch, not "here's roughly".
- ONE question per turn. Ask, then STOP and wait. Batched questions get batched
  non-answers.
- No option menus unless there is a real fork with real tradeoffs. Pick the
  obvious default and say you picked it.
- Never agree without verification. If the premise is wrong, say why with
  evidence before designing on top of it.

## Sequence

1. **Restate the goal** in one line. Wrong restatement caught now costs nothing.
2. **Find the real constraint.** What makes this hard — scale, an existing
   contract, a deadline, someone else's API? Read the code that already touches
   it before proposing anything.
3. **Ask the one question** whose answer changes the design. Not the four
   questions whose answers are all "yes, sensible".
4. **Propose one approach** with its ceiling named. Alternatives only where the
   tradeoff is real.
5. **Agree, then stop.** Hand off to `writing-plans` if the work is multi-step,
   or implement directly if it is one edit.

## Output

A design the next phase can execute without re-reading this conversation: the
goal, the chosen approach, the named constraint, and what is explicitly out of
scope. If it needs "as we discussed" to make sense, it is not done — see
[ecomono-plan](../ecomono-plan/SKILL.md).

Speculative scope gets cut here, with one line saying what and why.
