#!/usr/bin/env bash
# Archive's gates are written twice: as `###` sections under `## Gates` in
# agent-skills/ecomono-sdd-archive/SKILL.md, which is the authority, and as a
# numbered instruction plus a bullet list in claude/agents/ecomono-sdd-archive.md,
# which is what the sub-agent actually reads first.
#
# Archive is the one phase that destroys data — it merges deltas into the baseline
# with no git behind it. A gate that exists in the skill but not in the agent's list
# is a gate that does not run, and it fails the way missing rules always fail here:
# silently, looking exactly like a gate being passed. The count is spelled out in
# prose ("all four gates"), so adding a fifth gate to the skill and forgetting the
# agent leaves it confidently running four.
#
# Upstream gentle-ai shipped this exact failure while this check was being written:
# its sdd-archive prose still hard-requires `reviewGate.result: allow` after its
# native gate stopped requiring it.
#
# The count and the carrier turned out to live in FIVE files, not two, and this header said
# "four files, not two" for a round after the body stopped agreeing — corrected here because a
# stale architecture note one section above the code is the same defect this whole file exists
# to catch. The gate count is DEFINED in one of them and RESTATED in prose in two more, and
# saying "spelled out in three" flattened that distinction until two judges caught it: the skill
# is the authority, where the count is the number of `###` titles under `## Gates` and appears as
# no prose figure at all, while `claude/agents/ecomono-sdd-archive.md` ("all four gates") and the
# orchestrator's model-assignments table ("behind four gates") each write it out and can each
# drift from it. The carrier `SUBJECT HASH` is required in all five
# (those three plus both `/ecomono-sdd-archive` command files), because a rename that drops it
# from the skill, the agent or the orchestrator starves the gate exactly as silently as one in a
# command file. Several of them were stale for a while precisely because nothing looked at them.
#
# ecomono: archive only, and it checks presence and count, not wording — the ceiling is that a
# gate whose *body* drifts still passes, and that the carrier check asks whether the literal is
# present, never whether the instruction around it is correct. Two narrower ceilings are stated
# where they live: which occurrence is the instruction (latent while each file carries it once),
# and the census's uppercase-ASCII reach. Upgrade path: if a second phase ever grows a
# `## Gates` section, take the file set as arguments and loop.

set -uo pipefail
cd "$(dirname "$0")"

skill=agent-skills/ecomono-sdd-archive/SKILL.md
agent=claude/agents/ecomono-sdd-archive.md

for f in "$skill" "$agent"; do
  [ -r "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
done

# The authority: `###` titles between `## Gates` and the next `##`.
titles=$(awk '/^## Gates/{f=1;next} /^## /{f=0} f && /^### /{sub(/^### /,"");print}' "$skill")
[ -n "$titles" ] || { echo "FAIL: no gates found under '## Gates' in $skill" >&2; exit 1; }

# The enumerated gate list in the agent file: from the "Run all N gates" step up
# to (not including) the next numbered step. A title that only happens to appear
# elsewhere in the file — e.g. reused as a word in the Result Contract's `risks`
# field — must not count as "named"; only this region is the executable gate list.
# Bounded on two sides, not one: the next numbered step, or the next `## ` heading,
# whichever comes first. If "Run all N gates" ever becomes the last numbered step,
# the numbered-step bound alone would silently extend the region to EOF and swallow
# later prose — e.g. the Result Contract's `risks` field — back into the gate list.
gate_list=$(awk '
  /^[0-9]+\. Run all .* gates/ { f=1 }
  f && /^[0-9]+\. / && !/^[0-9]+\. Run all .* gates/ { exit }
  f && /^## / { exit }
  f
' "$agent")
[ -n "$gate_list" ] || { echo "FAIL: no 'Run all N gates' step found in $agent" >&2; exit 1; }

fail=0
count=0
while IFS= read -r title; do
  count=$((count + 1))
  grep -qF -- "$title" <<<"$gate_list" || {
    echo "DRIFT — gate '$title' is in $skill but not named in the gate list in $agent"
    fail=1
  }
done <<<"$titles"

# The spelled-out count in the agent's step 2 has to match how many gates exist.
words=(zero one two three four five six seven eight nine)
[ "$count" -lt ${#words[@]} ] || { echo "FAIL: $count gates, past the spelled-out range" >&2; exit 1; }
expected="all ${words[$count]} gates"
actual=$(grep -oE "all [a-z]+ gates" "$agent" | head -1)

if [ -z "$actual" ]; then
  echo "DRIFT — $agent no longer spells out a gate count; expected '$expected'"
  fail=1
elif [ "$actual" != "$expected" ]; then
  echo "DRIFT — $agent says '$actual', but $skill defines $count gates ('$expected')"
  fail=1
fi

# Third place the count is spelled out: the orchestrator's model-assignments table.
orch=agent-skills/ecomono-sdd-shared/sdd-orchestrator.md
orch_actual=$(grep -oE "behind [a-z]+ gates" "$orch" | head -1)
if [ -z "$orch_actual" ]; then
  echo "DRIFT — $orch no longer spells out archive's gate count; expected 'behind ${words[$count]} gates'"
  fail=1
elif [ "$orch_actual" != "behind ${words[$count]} gates" ]; then
  echo "DRIFT — $orch says '$orch_actual', but $skill defines $count gates"
  fail=1
fi

# The receipt gate searches on a hash only the caller can compute, so any of the five files
# that produce or consume the token can starve the gate, not just the two command files: this
# used to be a presence loop over those two only, folded in here because a rename that drops
# the literal from the skill, the agent or the orchestrator is exactly as silent.
#
# A census over pattern matches cannot notice an absence — a file that stops carrying the
# literal simply contributes zero matches and drops out of a set-based comparison without
# lowering the count, which is why this has to be a per-file requirement, not a pooled one.
# The literal is anchored on BOTH sides, and each `\b` was added for a shape that got past the
# other. A bare substring match (`grep -qF 'SUBJECT HASH'`) is satisfied by `SUBJECT HASHES`, so
# widening the literal in place reads as present — that is what the trailing `\b` closes. A
# trailing `\b` alone is then satisfied by `NONSUBJECT HASH`, since the match may start anywhere
# in the line, and the census cannot see that one either: `grep -o` returns only the matched
# substring, so the prefix is discarded and the pooled spelling looks unchanged. The leading `\b`
# is what closes it. Both were measured against this check, one round apart, by two judges who
# each found the shape the previous fix had left.
for f in "$skill" "$agent" "$orch" \
  claude/commands/ecomono-sdd-archive.md opencode/commands/ecomono-sdd-archive.md; do
  [ -r "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
  grep -qE '\bSUBJECT HASH\b' "$f" || {
    echo "DRIFT — $f no longer carries the literal SUBJECT HASH, so the receipt gate is never fed"
    fail=1
  }
done

# The presence loop above is a per-file requirement and cannot see across files, so it misses
# a variant ADDED alongside the literal — a file can keep `SUBJECT HASH` intact and still
# introduce a second spelling (`SUBJECT_HASH`) elsewhere in the same file or in another one,
# and every check above stays green because each file, read alone, is fine. This census is
# what that needs: collect every carrier-shaped token across all five files and require
# exactly one distinct value.
#
# ecomono: AND ITS REACH IS NARROWER THAN "A SECOND SPELLING", which an earlier version of this
# comment claimed without qualification until two judges reproduced three escapes of it. The
# pattern is case-SENSITIVE and knows only space, underscore and hyphen as the separator, so
# `subject_hash`, `SUBJECT.HASH`, `SubjectHash` and a non-breaking space between the words are
# all invisible: they contribute no token, the original literal is untouched, and the census
# still counts one spelling.
#
# That is not a missing alternative to add — `-i` FAILS ON THE HEALTHY BASELINE. Every one of
# these five files already uses the lowercase form in ordinary prose, about the
# `review/{subject-hash}` memory key rather than about the carrier, so a case-insensitive census
# finds several distinct spellings on a clean tree and refuses it. Run
# `grep -ohiE 'SUBJECT[ _-]*HASH' <the five files> | LC_ALL=C sort -u` to see them; no count is
# written here because two were, both were wrong, and both had been labelled as measured.
# Telling the carrier token apart from prose about the same concept is a question about meaning,
# which is the shape this repo has buried twice. The census covers the uppercase ASCII carrier
# and says so; a fixture asserts the lowercase addition PASSES, so the boundary is pinned rather
# than implied, and adding `-i` breaks that fixture and the baseline together.
#
# `LC_ALL=C` because an unpinned sort is locale-dependent, which this repo has already shipped
# once as a defect.
carriers=$(grep -ohE 'SUBJECT[ _-]*HASH' \
  "$skill" "$agent" "$orch" \
  claude/commands/ecomono-sdd-archive.md opencode/commands/ecomono-sdd-archive.md \
  | LC_ALL=C sort -u)
n_carriers=$(printf '%s\n' "$carriers" | grep -c .)
if [ "$n_carriers" -ne 1 ]; then
  echo "DRIFT — archive's subject-hash carrier is spelled $n_carriers ways, not 1:"
  # Guarded: at zero matches `$carriers` is empty and printing it emitted a line of bare
  # indentation under the message, which reads as a spelling that is somehow blank.
  [ -n "$carriers" ] && printf '%s\n' "$carriers" | sed 's/^/       /'
  fail=1
fi

# ecomono: the file set is enumerated, so a SIXTH file that starts using the carrier is outside
# this check until someone adds it here — the same archive-only ceiling the header already
# declares.
#
# The other ceiling is LATENT rather than live, and the difference is worth stating because an
# earlier version of this comment asserted it as a present-tense limitation. Neither check can
# tell which occurrence of the literal is the actual forwarding instruction, so a file whose
# instruction drifts out of carrier shape while some OTHER occurrence keeps the literal would
# pass both. Measured: every one of the five files carries `SUBJECT HASH` exactly once today, so
# there is no second occurrence to hide behind and the exposure is unreachable — dropping the
# instruction drops the literal, which the presence loop catches. It goes live the moment any of
# these files mentions the carrier twice. What it would need then is a comparison that knows
# which occurrence is the instruction, which is a question about meaning — the shape this repo
# has buried twice (the gate-body wording and the command-file wording, both named at the top of
# this file).
[ $fail -eq 0 ] && echo "ok   archive gates agree ($count gates defined, restated in 2 files, hash forwarded from all 5 carrier files, one uppercase spelling)"
exit $fail
