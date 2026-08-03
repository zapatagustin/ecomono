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
# The count and the receipt gate's existence turned out to live in four files, not two.
# The other two are checked here too: the orchestrator's model-assignments table spells
# the count out again in prose, and the two `/ecomono-sdd-archive` command files are the
# entry points that have to forward the subject hash the gate searches on. Both were
# stale for a while precisely because nothing looked at them.
#
# ecomono: archive only, and it checks presence and count, not wording — the ceiling is
# that a gate whose *body* drifts still passes, and that the command-file check only
# asks whether the subject hash is mentioned, not whether the instruction is correct.
# Upgrade path: if a second phase ever grows a `## Gates` section, take the file set as
# arguments and loop.

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

# The two command files are the entry points. The receipt gate searches on a hash only
# the caller can compute, so a command file that never mentions it leaves the gate
# permanently unfed — it fails closed and reports every archive unreviewed.
for cmd in claude/commands/ecomono-sdd-archive.md opencode/commands/ecomono-sdd-archive.md; do
  [ -r "$cmd" ] || { echo "MISSING: $cmd" >&2; exit 1; }
  grep -qF 'SUBJECT HASH' "$cmd" || {
    echo "DRIFT — $cmd never mentions SUBJECT HASH, so the receipt gate is never fed"
    fail=1
  }
done

[ $fail -eq 0 ] && echo "ok   archive gates agree ($count gates; count in 3 files, hash forwarded from 2)"
exit $fail
