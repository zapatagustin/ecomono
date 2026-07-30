---
name: ecomono-pr
description: >
  Prepare a branch and open a pull request: branch naming, conventional commits, a
  body a reviewer can act on, and the review-size budget. Use when creating, opening
  or preparing a PR, when the user says "open a PR" or "prepare this branch", or
  invokes /ecomono-pr.
metadata:
  version: "2.0"
---

Open a PR someone can actually review. The binding constraint is reviewer attention, not
process compliance.

## Branch naming

```
^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)/[a-z0-9._-]+$
```

`type/description`, lowercase, only `a-z0-9._-` after the slash. `feat/user-login`,
`fix/zsh-glob-error`, `refactor/extract-shared-logic`.

The prefix matches the conventional-commit type, so the branch and the history agree.

## Before opening

1. **Never work on the default branch.** Branch first.
2. Conventional commits throughout: `type(scope): subject`, subject ≤50 chars,
   imperative. Body only when the *why* is not obvious from the diff. No AI attribution,
   no `Co-Authored-By`.
3. Run what the project actually checks — its linter, its tests, `shellcheck` on modified
   shell. Detect from the project; never assume a stack.
4. **Measure the diff**: `additions + deletions` against the merge base.

## PR body

Four sections, in this order. A reviewer reads top-down and stops once they have enough.

```markdown
## What
{One or two sentences. What changed, not how.}

## Why
{The problem this solves. `Closes #N` when an issue exists.}

## How to verify
{A command, a flow, or a test name. Something the reviewer can run.}

## Notes
{Deliberate tradeoffs, known ceilings, what was left out and why. Omit if none.}
```

**How to verify** is the section reviewers use most and the one most often missing. Without
it you are asking them to reverse-engineer your intent from the diff.

Declare deliberate omissions in Notes. A shortcut the reviewer finds themselves reads as
an oversight; the same shortcut stated reads as a decision.

## Review size

Past roughly **400 changed lines** review quality drops — the reviewer starts skimming,
and a skimmed approval is worse than a slow one because it looks identical.

Over budget → split along **deliverable** units, never along line counts. Each slice needs
a clear start, a clear finish, its own verification, and a sane rollback.

| Strategy | Base branches |
|---|---|
| Stacked to main | Each PR merges to main in order. Independent slices, fast iteration |
| Feature branch chain | PR #1 → tracker branch, each later PR → the previous PR's branch. Only the tracker reaches main |

In a chain, a child PR whose diff shows earlier slices has the wrong base. Retarget or
rebase until the diff is only this slice, or the split bought nothing.

Genuinely unsplittable — generated code, a migration, a vendor bump — say so in the body
and ask for an explicit size exception. Do not open a 2,000-line PR and hope.

## Project gates: detect, do not assume

Some repos enforce issue linkage, required labels, or CI checks. Read `.github/` for a PR
template and workflows, and check the real label list, before requiring any of it.

Present → follow exactly. Absent → do not invent ceremony the project does not have.
Demanding a label that does not exist produces instructions nobody can follow.

## Rules

- Branch before committing. Never push work to the default branch.
- One logical change per PR. "While I was in there" is how a 200-line PR becomes 900.
- Tests and docs travel in the same PR as the code that needs them.
- Never claim checks pass without running them and reading the output.
- Work incomplete → draft PR, not a ready PR with a WIP note.
