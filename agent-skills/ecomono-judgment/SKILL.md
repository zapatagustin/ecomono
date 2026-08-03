---
name: ecomono-judgment
description: "Trigger: judgment day, dual review, adversarial review, juzgar. Two blind judges review in parallel, confirmed issues get fixed, then re-judged."
metadata:
  version: "1.5"
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

A verdict is bound to exact bytes, never to a branch or an intent. Before launching the
judges, freeze the subject and record the hash:

```bash
git diff HEAD -- {target paths} | sha256sum | cut -c1-12
```

Use `--cached` or a commit range when that is what the target actually is. Target is not
a diff — an architecture slice, a whole component — then hash the file list plus each
file's own content. The shape does not matter; naming what the judges saw does.

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
4. Synthesize into confirmed / suspect / contradiction / INFO.
5. Ask before round-1 fixes. Delegate a **separate** fix agent, for approved confirmed
   issues only — the judges do not fix what they found.
6. Re-judge in parallel after fixes. Repeat until approved, escalated, or stopped.
7. Re-verify the subject hash, then write the receipt.
8. Before any terminal action, confirm every open judgment reached a terminal state. A
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
