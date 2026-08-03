---
name: ecomono-judgment
description: "Trigger: judgment day, dual review, adversarial review, juzgar. Two blind judges review in parallel, confirmed issues get fixed, then re-judged."
metadata:
  version: "1.11"
---

Two independent reviewers, neither of which saw the work being written, agreeing on a
finding. Agreement between blind judges is the signal; a single judge is a hypothesis.

Load only when explicitly asked — "judgment day", dual or adversarial review, `juzgar`,
`que lo juzguen`. Needs a concrete target: files, a feature, a PR, or an architecture
slice.

## Hard rules

- **Never review the code yourself.** You coordinate. Reviewing it inline forfeits the
  independence that makes the verdict mean anything, and costs you the context you need
  to run the rounds.
- Launch **both judges in parallel**, same target, same criteria, neither seeing the
  other. Sequential launches leak the first verdict into the second.
- Judges get exact skill paths, resolved from the registry per
  [skill-resolver.md](../ecomono-sdd-shared/skill-resolver.md) — the same block injected
  into judge and fix prompts alike. A judge reviewing against different standards than
  the fixer applies produces churn.
- Wait for both. Never synthesize from a partial verdict.
- **Ask before fixing** in round 1.
- After any fix agent runs, re-launch both judges **before** commit, push, done, or a
  session summary. A fix is a change, and an unreviewed change is what this skill exists
  to prevent.
- Terminal states are only `JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`. There is no
  third, and no "mostly fine".
- Two fix iterations with issues remaining → ask whether to continue rather than looping.

## Candidate freeze

A verdict is bound to exact bytes, never to a branch or an intent. This skill is the only
place the subject hash gets computed — nothing downstream, the orchestrator included,
re-derives it or forwards anything but this skill's own reported string. The recomputations
the sequence calls for detect drift in the reviewed bytes; they never replace the forwarded
value, which stays the one reported at freeze time.

One shape only:

```bash
git diff "$(git merge-base HEAD {base-branch})" | sha256sum | cut -c1-12
```

Resolve `{base-branch}` to the change's actual base branch — `master` in this repo — never
hardcode a name. `git diff <commit>` with no second ref compares that commit against the
**working tree**, so committed, staged and unstaged work all land in the same hash in one
shot.

`ecomono: the frozen subject is the whole branch diff and may carry bytes unrelated to
what the judges review, so a receipt over-claims coverage when the branch mixes concerns.
Relatedness isn't computable from git state, so nothing here checks it — keeping the
branch clean before freezing is the operator's job. The untracked check below is
repo-wide for the same reason and will fire on unrelated debris; scoping it to the diff
needs path comparison that prose cannot pin down without silently mis-firing. It also
misses untracked content inside a submodule, which the superproject reports as a modified
gitlink rather than `??` — invisible to the hash and to the check alike. Upgrade path for
all of it: code that compares a declared in-scope path list against the diff.`

**Target is not a diff** — an architecture slice, a whole component, a design question —
has no bytes to freeze. Say so explicitly: no hash, no receipt, and the verdict is
advisory rather than a delivery receipt. `ecomono-sdd-archive` will report the change as
unreviewed, which is correct: the judgment reviewed a design, not a candidate.

Two guards, checked before freezing, neither of which mutates anything:

- **Empty diff → refuse to freeze.** Write no receipt, and say why: on a clean tree at the
  merge base the diff is empty, and hashing an empty string always produces the same
  constant (`e3b0c44298fc`) regardless of repo or content. A receipt ever written under
  that key becomes a skeleton key that passes every later archive run on a clean tree.
- **Untracked files present → refuse and name them.** `git diff` never sees untracked
  files, so a new file beside a changed one hashes identically to no change at all. The
  check is `git -c status.showUntrackedFiles=all status --porcelain | grep '^??'` — any
  output refuses the freeze. The `-c` is not decoration: a repo or global
  `status.showUntrackedFiles=no`, which large repos set for speed, suppresses every `??`
  line and would make this pass silently. Do not stage anything (no `git add -N`) — the
  user commits the files or adds them to `.gitignore`, then re-freezes.

Report the computed hash verbatim in this skill's own output and in the receipt; every
later consumer carries that string forward instead of recomputing it.

Re-compute the hash before you synthesize, and again before any terminal verdict. Changed
→ the judges reviewed bytes that no longer exist. Discard the round, re-launch on the new
hash, and say why. A verdict with unreviewed edits under it is the exact thing this skill
exists to prevent, and it is indistinguishable from a real one once reported.

## The warning rubric

Classify a warning as `WARNING (real)` only when **normal intended use** can trigger it.
Otherwise downgrade to INFO as `WARNING (theoretical)`.

This distinction is the whole difference between a review that gets acted on and one that
gets ignored. A list where a genuine bug sits beside "this would break if someone passed
a negative array length" trains the reader to skim both.

## Gates

| Condition | Action |
|---|---|
| Target unclear | Ask for scope. Do not launch |
| Subject hash changed since the judges were launched | Discard the round. Re-launch on the new hash |
| No skill registry | Warn, use generic criteria, record `Skill Resolution: none` |
| Both judges find the same CRITICAL or real WARNING | **Confirmed.** Fix per the round rules |
| One judge finds it | **Suspect.** Report and triage. Never auto-fix |
| Judges contradict each other | **Escalate** for a human decision |
| Round 2+ has only theoretical warnings or suggestions | Report as INFO. Do not re-judge |

One judge finding something is not proof it is wrong — it is proof the two did not
converge, which is information about the finding, not about the judge.

## Sequence

1. Confirm the target and any custom criteria. Freeze the subject hash.
2. Resolve exact skill paths, or warn that you could not.
3. Launch Judge A and Judge B concurrently.
4. Re-compute the subject hash. Changed → discard the round and re-launch on the new hash
   rather than synthesizing verdicts about bytes that no longer exist.
5. Synthesize into confirmed / suspect / contradiction / INFO.
6. Ask before round-1 fixes. Delegate a **separate** fix agent, for approved confirmed
   issues only — the judges do not fix what they found.
7. Re-judge in parallel after fixes, from step 3. Repeat until approved, escalated, or
   stopped. Every round runs its own step 4.
8. Re-verify the subject hash, then write the receipt.
9. Before any terminal action, confirm every open judgment reached a terminal state. A
   round left hanging reads exactly like a round that passed.

## Receipt

Every terminal verdict writes exactly one receipt, `mem_save` with:

```
title:     review/{subject-hash}
topic_key: review/{subject-hash}
type:      decision
```

Body: the subject hash and how it was computed, the target, the judges or lenses run, the
round count, the confirmed / suspect / contradiction counts, fixes applied, and the
terminal verdict verbatim. `judgment_required` on the save → resolve each candidate with
its own `suggested_relation` per
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md) §C.

Keyed by the hash, not by a change name: the receipt records that *these bytes* were
reviewed, which is what a later gate needs to check. `ecomono-sdd-archive` searches
`review/{hash}` and treats a missing receipt as unreviewed.

No memory store reachable → say so explicitly and report the verdict as
conversation-scoped. A verdict that lives only in this conversation is gone at the next
compaction; do not let it pass for a receipt.

## Output

`## Judgment Day — {target}` with the subject hash, the round number, the verdict table,
counts for confirmed / suspect / contradiction, fixes applied, the re-judgment result,
`Skill Resolution`, the receipt key (`review/{subject-hash}`, or why none was written),
and a final `JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`.

Judge and fix prompts, the warning rubric in full, and the verdict tables:
[references/prompts-and-formats.md](references/prompts-and-formats.md).
