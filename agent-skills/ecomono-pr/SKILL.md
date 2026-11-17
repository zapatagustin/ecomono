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
5. **Show the draft first.** The last step before opening, after the size and project-gate
   checks below. One stop per branch, draft PRs included, even when the user asked for the
   PR outright. Print the PR title and body, plus a brief when it has entries: "Needs your
   decision" (parts left undone: options, recommendation, cost to revert) and "Taken
   provisionally" (decisions taken on your recommendation, one line each). An approval, in
   any wording, opens the PR as shown and confirms the provisional decisions only; red
   parts stay undone until the user answers each one. A size-exception request is an entry
   under "Needs your decision", not a separate question. A change request, a
   reversal or a mixed reply → revise and show it again; that loop is still the one stop.
   A refusal → do not open, leave the branch as it is. Nobody to answer → do not open; end
   with the draft and the brief.

## PR body

Four sections, in this order. A reviewer reads top-down and stops once they have enough.

```markdown
## What
{One or two sentences. What changed, not how.}

## Why
{The problem this solves. `Closes #N` when an issue exists; `Refs #N` when related but it must not close.}

## How to verify
{A command, a flow, or a test name. Something the reviewer can run.}

## Notes
{Deliberate tradeoffs, known ceilings, what was left out and why. Omit if none.}
```

Budget: about 12 lines, headings included, unless the project's template sets its own
shape; a size-exception note does not count. Write it the way the author would by hand:
plain sentences, nothing the diff already says, no filler. A body that reads as generated
does not get read, and an unread body explains nothing.

The decision brief is for the author and stays in the conversation. Only a tradeoff the
reviewer needs goes in Notes.

**How to verify** is the section reviewers use most and the one most often missing. Without
it you are asking them to reverse-engineer your intent from the diff.

Declare deliberate omissions in Notes. A shortcut the reviewer finds themselves reads as
an oversight; the same shortcut stated reads as a decision.

## Review size

Past roughly **400 changed lines** review quality drops — the reviewer starts skimming,
and a skimmed approval is worse than a slow one because it looks identical.

Over budget → split along **deliverable** units, never along line counts. Each slice needs
a clear start, a clear finish, its own verification, and a sane rollback.
Give a high-risk unit — one carrying pre-pr tier-4 evidence: auth, security or payments
code, a credential or token path, an installer, a destructive operation — its own slice,
so it gets the tier-4 review, all four lenses, without dragging the rest into tier 4.
A dev or test database that a seed or backup rebuilds does not count as a destructive
operation (tier-4 evidence list in `sdd-orchestrator.md`, which owns this rule).

Shrink by removing scope, never by reformatting. Collapsing whitespace or compacting code
to duck under the line count games the gate — the reviewer still reads the same change.

| Strategy | Base branches |
|---|---|
| Stacked to main | Each PR merges to main in order. Independent slices, fast iteration |
| Feature branch chain | PR #1 → tracker branch, each later PR → the previous PR's branch. Only the tracker reaches main |

In a chain, a child PR whose diff shows earlier slices has the wrong base. Retarget or
rebase until the diff is only this slice, or the split bought nothing.

Genuinely unsplittable — generated code, a migration, a vendor bump — say so in the body
and list the size exception under "Needs your decision" in the step 5 stop, not as a
separate question. Do not open a 2,000-line PR and hope.

## Project gates: detect, do not assume

Open the PR against the base repo, not the fork's `origin`, and read `CONTRIBUTING.md`
first.

Some repos enforce issue linkage, required labels, or CI checks. Read `.github/` for a PR
template, and check the real label list, before requiring any of it. Required CI checks
come from branch protection or rulesets (`gh api repos/{owner}/{repo}/rulesets`,
`gh api repos/{owner}/{repo}/branches/{branch}/protection`), not workflow files; a pending
check that is optional does not make the PR merge-ready.

Present → follow exactly. Absent → do not invent ceremony the project does not have.
Demanding a label that does not exist produces instructions nobody can follow.

## Rules

- Branch before committing. Never push work to the default branch.
- One logical change per PR. "While I was in there" is how a 200-line PR becomes 900.
- Tests and docs travel in the same PR as the code that needs them.
- Never claim checks pass without running them and reading the output.
- Work incomplete → draft PR, not a ready PR with a WIP note.
