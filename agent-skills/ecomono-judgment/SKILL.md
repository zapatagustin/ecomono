---
name: ecomono-judgment
description: "Trigger: judgment day, dual review, adversarial review, juzgar. Two blind judges review in parallel, confirmed issues get fixed, then re-judged."
metadata:
  version: "1.15"
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
- **Judge and fix prompts carry the SAME standards block.** That symmetry is the
  requirement: a judge reviewing against different standards than the fixer applies
  produces churn. Exact file paths, never summaries — a summary is a second copy of
  someone else's rules with nothing keeping the two equal. For SDD-shaped work the block
  is the registry-resolved `SKILL.md` paths per
  [skill-resolver.md](../ecomono-sdd-shared/skill-resolver.md); for an arbitrary diff it
  is normally the project's own standards, since the registry lists skills and most of
  them say nothing about the code under review. Either way every sub-agent reports which
  it received, and a report of none is about the delegator, not about the sub-agent.
- Wait for both. Never synthesize from a partial verdict.
- **Ask before fixing** in round 1. The loop is bounded by steps 7-8: one approved batch
  plus one retry for the same blocker; everything else goes to the "Needs your decision"
  list.
- After any fix agent runs, re-launch both judges **before** commit, push, done, or a
  session summary. A fix is a change, and an unreviewed change is what this skill exists
  to prevent.
- Terminal states are only `JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`. There is no
  third, and no "mostly fine".

## Candidate freeze

A verdict is bound to exact bytes, never to a branch or an intent. This skill is the only
place the subject hash gets computed — nothing downstream, the orchestrator included,
re-derives it or forwards anything but this skill's own reported string. The forwarded value
is the hash of the round that produced the terminal verdict: a re-freeze after any fix
replaces it, drift never does — drift discards the round (step 4) — except after a guard
refusal (step 7).

One shape only:

```bash
git diff "$(git merge-base HEAD {base-branch})" | sha256sum | cut -c1-12
```

Resolve `{base-branch}` to the change's actual base branch — `master` in this repo — never
hardcode a name. `git diff <commit>` with no second ref compares that commit against the
**working tree**, so committed, staged and unstaged work all land in the same hash in one
shot.

**Measure the candidate, not just name it.** The same diff answers how big it is:

```bash
git diff --numstat "$(git merge-base HEAD {base-branch})" | awk '{for(i=1;i<=2;i++)t+=$i} END{print t+0}'
```

Report that count beside the hash, pass it to every judge, and record it in both copies of the
receipt. A judge handed more candidate than it can hold reviews part of it and returns a verdict
that reads exactly like full coverage. The size is not the defect — the silence about it is.

Over **400 changed lines** the round states what it covered instead of leaving coverage implied:
the judges are told the count and asked to report what they actually read against what the diff
contained; a round on a candidate that size without that statement is ESCALATED (step 9).
400 is not a new number invented here. It is `claude/hooks/check-diff-size.sh`'s `THRESHOLD`, the
reviewability budget this repo already committed to and already warns on. The THRESHOLD is shared;
the MEASUREMENT is not, and the two can disagree loudly. That hook counts `master...HEAD`, which
sees committed work only, so on a candidate that is still uncommitted it answers zero while the
formula above answers the real size — a gap that is structural, not a stale count to correct,
since the formula above measures the very diff this sentence lives in and would go stale again
on the next edit. The formula above is the one that matches the frozen hash, which is the point:
the count has to describe the bytes the judges were given.

This is **not** a reviewer tier. `sdd-orchestrator.md` is explicit that size is a reviewability
budget and never a risk signal — a large mechanical rename does not become dangerous by being
large, and a three-line change to a token path does not become safe by being small. The count
changes what the round DISCLOSES, never who reviews it or how many lenses run.

`ecomono:` nothing enforces the coverage statement, and the count reads "text lines" only: `--numstat` shows binary files as dashes, summed as zero. Ceilings and upgrade path: [references/receipt-gate.md](references/receipt-gate.md#coverage-ceilings).

`ecomono:` the frozen subject is the whole branch diff, so a mixed branch over-claims coverage; keep it clean before freezing. Ceilings and upgrade path: [references/receipt-gate.md](references/receipt-gate.md#freeze-ceilings).

**Target is not a diff** — an architecture slice, a whole component, a design question —
has no bytes to freeze. Say so explicitly: no hash, no receipt, `Baseline: none` in the
judge prompt, and the verdict is advisory rather than a delivery receipt.
`ecomono-sdd-archive` will report the change as unreviewed, which is correct: the judgment
reviewed a design, not a candidate.

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
  line and would make this pass silently. This skill stages nothing; the user stages the
  files with a full `git add` (not `git add -N`) or adds them to `.gitignore`, then
  re-freezes. Nothing is committed before the re-judge.

Report the computed hash verbatim in this skill's own output and in the receipt; every
later consumer carries that string forward instead of recomputing it.

## The warning rubric

Classify a warning as `WARNING (real)` only when **normal intended use** can trigger it.
Otherwise downgrade to INFO as `WARNING (theoretical)`.

This distinction is the whole difference between a review that gets acted on and one that
gets ignored. A list where a genuine bug sits beside "this would break if someone passed
a negative array length" trains the reader to skim both.

Pre-existing behaviour is never a blocker unless fixing it was the stated `Intent:`, in
which case it is judged normally. Otherwise the judge template's baseline rule classes it
`WARNING (theoretical)`, which step 6 records as INFO. A latent bug the candidate newly
makes reachable is not pre-existing.

## Gates

| Condition | Action |
|---|---|
| Target unclear | Ask for scope. Do not launch |
| Subject hash changed other than by a re-freeze | **Drift.** Write nothing, discard the round, re-freeze, re-launch (step 4) |
| No skill registry, SDD-shaped target | Say which skills you could not resolve, build the block from the project's own standards instead, and record `Skill Resolution: fallback-path`. A missing registry is never licence to send no block |
| A sub-agent reports it received no standards block | The round's SETUP was defective, not its findings. Name it beside the verdict, build the block before the next launch, and do NOT discard the round over it |
| Both judges find the same CRITICAL or real WARNING | **Confirmed** blocker. First confirmed in round 1 → step 7; first confirmed in round 2 or later → the list (step 8) |
| One judge finds it | **Suspect.** Triage per step 6. Never auto-fix unprompted |
| Judges contradict each other | Put to the user via the list. Never resolve it yourself |
| Round 2+ has only theoretical warnings or suggestions | Report as INFO or suspects per step 6. Do not re-judge |

One judge finding something is not proof it is wrong — it is proof the two did not
converge, which is information about the finding, not about the judge.

## Sequence

1. Confirm the target, its one-line intent and any custom criteria. Freeze the subject hash.
2. Build the standards block — exact file paths, one block for both sides — or warn that you
   could not. Build it BEFORE step 3, because the judges and the fix agent have to receive the
   same one, and the fix agent runs in steps 7 and 8 where the block is easy to forget.
3. Launch Judge A and Judge B concurrently. Each prompt carries `Baseline:`, the merge-base
   the subject hash was computed against, and `Intent:`, one line on what was asked for.
4. Re-compute the subject hash. Changed from the hash this round's judges saw → **drift**:
   write nothing under either hash, discard the round, re-run step 1's freeze, re-launch from
   step 3 with the discarded round's scope, and say why. List answers already recorded stay
   recorded; unanswered items stay open on the list for the re-launched round. A discarded
   round does not count in `rounds:`. A receipt is never written under bytes no judge pair
   saw. Every pre-write re-verification (step 9) applies the same rule.
5. Synthesize into confirmed / suspect / contradiction / INFO.
6. Triage. INFO is any WARNING (theoretical) and any SUGGESTION both judges raise; a
   SUGGESTION one judge raises is a suspect. INFO is recorded in the memory copy's body; it
   never blocks and needs no answer. A suspect is recorded there with its severity and the
   judge that raised it, and goes on the "Needs your decision" list only if you or the user
   want it answered; an open suspect does not block APPROVED by itself. A contradiction
   always goes on the list — you never resolve it; the user's answer is the human decision
   the Gates row asks for. A confirmed CRITICAL or real WARNING is a **blocker**, open until
   a re-judge stops reporting it or the review ends. Round 1 → step 7. First confirmed in
   round 2 or later → never auto-fixed, onto the list.
7. Ask before fixing the round-1 blockers. The first wait under a given hash — at
   this ask or at list return — write the ESCALATED receipt under it before the question is
   put; later writes under that hash only refresh `rounds:` or rewrite it to the terminal
   verdict (step 9). No answer at the ask leaves that ESCALATED standing. This decision, and
   on approval its loop, is settled first; the round's list is returned after, at once on
   decline.
   - **Approve** → one batch covering all of them, by a **separate** fix agent — the judges
     do not fix what they found. Then the **re-freeze**: re-run step 1 in full (hash,
     changed-line count, empty-diff and untracked-file guards); its hash is the next
     round's subject. Re-judge from step 3 — both judges, same standards block, scope
     limited to those blockers, round counter continuing. A blocker that still fails gets
     ONE more batch under the same approval; failing again makes it **exhausted**: open,
     fix no longer offered, onto the list with `stop` as its only answer.
   - **Decline** → the blockers stay open and the verdict is pinned at ESCALATED. A declined
     blocker is not a list item: its decision is made. The list carries only the other
     items, `fix` not offered: their answers, `accept` or `stop`, are recorded and change
     nothing.
   - **Re-freeze guard refusal** (the fix agent added an untracked file, or reverted
     everything to an empty diff) → there is no new hash, so nothing is written under
     the refused re-freeze: the verdict, on `stop`, no answer or session end here, is the
     ESCALATED under the last hash that carries one. Untracked files: name them; the user
     stages them with a full `git add` (not `git add -N`) or adds them to `.gitignore`, then
     the re-freeze is re-run — nothing is committed before the re-judge. An emptied diff:
     the user restores the change or stops.
8. Return the list whenever it is non-empty, loop or no loop. Each item carries severity,
   file and line, which judge(s) raised it, and one line on why it was not auto-fixed.
   Open items from earlier rounds that a limited re-judge did not re-examine stay on it
   until answered. Return is a wait: the receipt goes first per step 7, so a session that
   ends unanswered still leaves a record — no answer, and that receipt stands. Per item:
   - **fix** approves exactly one correction batch for that item, whatever its class — the
     Gates row on suspects covers unprompted fixes only — and is not offered after a
     decline. Separate fix agent, re-freeze per step 7, re-judge scope limited to the item,
     NO retry: still failing → back on the list, `stop` its only answer.
   - **accept**, for suspect and contradiction items only, records the item in the memory
     copy's body with its original severity and judge(s), a contradiction with both judges'
     positions. A blocker's answers are fix or stop; an exhausted one's, stop.
   - **stop** ends the review. The existing ESCALATED is left in place; `rounds:` is
     refreshed only if the hash still verifies, and after a guard refusal nothing is
     rewritten.
9. Close. APPROVED requires ALL of: no blocker open (none declined, exhausted or
   unanswered), no list item unanswered, and the hash verified unchanged since the last
   round's judges saw it — plus, over 400 changed lines, the round's coverage statement;
   without it the candidate is ESCALATED. Anything else is ESCALATED. Write the terminal
   verdict under the hash of the round that produced it. After a guard refusal there is no
   such hash: the verdict is the ESCALATED under the last hash that carries one (step 7).
   If the hash the verdict is written under already carries an
   ESCALATED (written at the round's first wait, no re-freeze since) → rewrite both copies
   in place, the only case a receipt can change verdict under one hash; otherwise write
   new. Every earlier ESCALATED under an earlier hash stays, certifying bytes that no longer
   exist. Every write or rewrite is preceded by the hash
   re-verification and goes file first, then memory copy, so a failing `mem_save` cannot
   leave a verdict with no durable record. `rounds:` is the judgment's total round count,
   refreshed on every rewrite.
10. Before any terminal action, confirm every open judgment reached a terminal state. A
    round left hanging reads exactly like a round that passed.

## Receipt

Every terminal verdict writes the same receipt twice: a file a shell gate can read, and a
memory observation a later session can search. Both are keyed by the subject hash, never by
a change name — the receipt records that *these bytes* were reviewed, which is what a gate
needs in order to check the claim instead of trusting it.

**The file.** One command, run after the final hash re-verification:

```bash
d="$(git rev-parse --git-common-dir)/ecomono/receipts" && mkdir -p "$d" && printf '%s\n' \
  '{APPROVED|ESCALATED}' 'hash: {subject-hash}' "base: $(git merge-base HEAD {base})" \
  'target: {target}' 'lines: {changed-lines}' 'rounds: {n}' > "$d/{subject-hash}"
```

The first line is the verdict token alone, so a gate reads one line and refuses on anything
but `APPROVED` — an `ESCALATED` receipt blocks rather than passes. When and under which
hash each copy is written or rewritten: steps 7-9.

Two lines carry a contract and the rest are for a human opening the file. The first is the
verdict. The second is `base:`, which must be the **full 40-hex merge-base commit** the subject
hash was computed against — the same `$(git merge-base HEAD <base>)` the formula uses, not the
branch name and not a revision expression like `HEAD~2`. It is what lets the gate honour this
receipt after the base branch has absorbed part of the reviewed work: the merge-base advances,
the diff narrows, the hash stops matching, and re-deriving from the recorded commit shows the
bytes never moved. A branch name or a rev expression names a different commit tomorrow, so the
gate refuses those spellings rather than resolving them; a malformed or missing `base:` forfeits only that tolerance and is not fatal.

The token is **bare**. `JUDGMENT: APPROVED` is the terminal state this skill reports in
conversation; the receipt's first line is `APPROVED` with nothing before it. The gate
compares for equality, so the prefixed spelling produces a receipt no delivery can ever
match and no diagnostic saying why.

Wrong path or first line and the gate finds nothing and refuses. The file lives under
`--git-common-dir` (not `--git-dir`, so every worktree sees it), never in the work tree: a receipt beside the reviewed code would alter
the bytes it certifies. Why `base:` is tolerant, how the gate is armed, and the opencode and
omp behaviour: [references/receipt-gate.md](references/receipt-gate.md).

**The memory copy.** `mem_save` with:

```
title:     review/{subject-hash}
topic_key: review/{subject-hash}
type:      decision
```

Body: the subject hash and how it was computed, the target, the candidate's changed-line
count, the judges or lenses run, the round count, the confirmed / suspect / contradiction
counts, the triaged suspects and INFO items, fixes applied, accepted items, and the terminal
verdict verbatim. `judgment_required` on the save → resolve each candidate with its own
`suggested_relation` per [sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md) §C.
`ecomono-sdd-archive` is the second gate that reads a receipt: it searches this copy for `review/{hash}` and treats a missing one as unreviewed.

No memory store reachable → write the file anyway, say the memory copy is missing, and
report the verdict as otherwise conversation-scoped. A verdict that lives only in this
conversation is gone at the next compaction; do not let it pass for a receipt.

No hash to freeze → neither copy is written. There is nothing to key them by, and a receipt
under an invented key is worse than no receipt.

## Output

`## Judgment Day — {target}` with the subject hash, the candidate's changed-line count, the
round number, the verdict table with `Skill Resolution` beside it rather than trailing after
the receipts — an omission that reads as a footnote gets skimmed past, and this one was, ten
launches running — counts for confirmed / suspect / contradiction, fixes applied, the
re-judgment result, the "Needs your decision" list when non-empty, both receipt locations —
the file path and the memory key `review/{subject-hash}`, or why neither was written — and a
final `JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`.

Judge and fix prompts, the warning rubric in full, and the verdict tables:
[references/prompts-and-formats.md](references/prompts-and-formats.md).
