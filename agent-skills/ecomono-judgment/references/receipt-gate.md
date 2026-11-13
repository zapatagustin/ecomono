# Receipt gate details

Reference for the Receipt section of [SKILL.md](../SKILL.md): rationale and gate internals, consulted on demand.

Getting the receipt's `base:` line wrong is not fatal, and neither is omitting it. The receipt lives at
`$(git rev-parse --git-common-dir)/ecomono/receipts/{subject-hash}` (SKILL.md, Receipt). A value the receipt gate
will not accept fails its pattern exactly the way an absent line does, so the receipt still matches any delivery
whose base has not moved. A malformed `base:` value and a missing `base:` line behave identically: each forfeits
only the tolerance for the base branch absorbing part of the reviewed work (SKILL.md, Receipt), nothing else.

The receipt file lives under the git directory and never in the work tree. The subject hash covers
`git diff <merge-base>`, so a receipt written beside the reviewed code would alter the exact
bytes it certifies and invalidate itself as it was written. `--git-common-dir`, not
`--git-dir`, so a receipt stays visible from every worktree of the repo: the reviewed bytes
are the same bytes whichever worktree you push from.

`claude/hooks/review-receipt-gate.sh` reads the receipt file on `git push` and `gh pr create`, and
refuses the delivery when no receipt matches the bytes being pushed. It is armed per
repository by an `ecomono/review-mode` marker beside the receipts directory, so writing the
receipt file does nothing in a repo that never armed it — and everything in one that did. Get
the receipt path above or its first line (the verdict token, SKILL.md, Receipt) wrong and the gate finds nothing and refuses.

On opencode the same hook script runs: `opencode/plugins/review-receipt-gate.ts` intercepts the
`shell` tool and shells out to it rather than reimplementing it, so there is one hash formula
and one detector on Claude Code, opencode and omp (whose extension runs the script too). The
behavioural differences are in the `ask` of the two states where the gate cannot run — no
base resolves, `git diff` failed. On Claude Code those ask in the prompting modes and are
advisory under `bypassPermissions` (the command runs). opencode has no `ask`, so those refuse
there instead of prompting. omp confirms an `ask` in its TUI and, with nobody to answer (print
or json mode, and every subagent, which Claude Code would prompt interactively), blocks it.

ecomono: two gates read a receipt — `claude/hooks/review-receipt-gate.sh`, and one of the four gates of `ecomono-sdd-archive`,
which reads the memory copy because the archive agent has no `Bash`. Upstream validates at
five delivery boundaries; this port validates at the two that deliver — `pre-push` and
`pre-pr` — and declines `post-apply` (the receipt would have to predate the bytes it
certifies), `pre-commit` (a commit delivers nowhere, and committing reviewed bytes does not
move the hash) and `release` (does not exist here). See docs/DESIGN.md, "What the port took,
and what it declined".

## Freeze ceilings

ecomono: the frozen subject is the whole branch diff and may carry bytes unrelated to
what the judges review, so a receipt over-claims coverage when the branch mixes concerns.
Relatedness isn't computable from git state, so nothing in this repo checks it — keeping the
branch clean before freezing is the operator's job. The untracked-file guard in SKILL.md is
repo-wide for the same reason and will fire on unrelated debris; scoping it to the diff
needs path comparison that prose cannot pin down without silently mis-firing. It also
misses untracked content inside a submodule, which the superproject reports as a modified
gitlink rather than `??` — invisible to the hash and to the check alike. Upgrade path for
all of it: code that compares a declared in-scope path list against the diff.

## Coverage ceilings

ecomono: nothing enforces the coverage statement (SKILL.md, Receipt). It is a judgment the coordinator makes, and
this repo has buried two checks that tried to answer a question about what a sentence means. What
is mechanical here is the changed-line count, and a receipt carrying it is what makes a missing coverage
statement visible to the next reader instead of indistinguishable from full coverage. Upgrade
path: have each judge return the list of paths it actually read and compare that against the
diff's own path list, which is a comparison of two lists rather than a claim about prose.

ecomono: the changed-line count has one measured blind spot, stated rather than left to be discovered:
`--numstat` reports binary files as a pair of dashes, which the line sum treats as zero, so a candidate
of nothing but binary files reports 0 changed lines. Verified. Lines are the wrong unit for those
bytes and no threshold in this repo has a right one, so the number is honest about text and silent
about the rest — read it as "text lines", never as "size of the candidate".
