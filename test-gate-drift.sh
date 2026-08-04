#!/usr/bin/env bash
# Fixtures for check-gate-drift.sh — bash test-gate-drift.sh
#
# The check itself is the thing that catches archive's gates drifting apart, so a
# regression in it is silent by construction: it keeps printing `ok` while the drift
# it was written to catch walks past. Six rounds of adversarial review found three
# separate ways it passed when it should have failed, each one a plausible edit
# rather than a contrived string. Those three are cases 4, 5 and 6 below.
#
# Every case copies the real files into a throwaway tree with the same relative
# layout and mutates the copy. The real repo is never touched — an earlier version
# of this test was run by hand against the live files, which is exactly how you lose
# an afternoon to a half-reverted fixture.

set -uo pipefail
cd "$(dirname "$0")"
repo=$PWD

fixture=$(mktemp -d) || exit 1
trap 'rm -rf "$fixture"' EXIT

skill=agent-skills/ecomono-sdd-archive/SKILL.md
agent=claude/agents/ecomono-sdd-archive.md
orch=agent-skills/ecomono-sdd-shared/sdd-orchestrator.md
ccmd=claude/commands/ecomono-sdd-archive.md
ocmd=opencode/commands/ecomono-sdd-archive.md

reset() {
  rm -rf "$fixture"/*
  for f in "$skill" "$agent" "$orch" "$ccmd" "$ocmd"; do
    mkdir -p "$fixture/$(dirname "$f")"
    cp "$repo/$f" "$fixture/$f"
  done
  cp "$repo/check-gate-drift.sh" "$fixture/"
}

fail=0
t() { # t <expected pass|fail> <description>
  local out rc got
  out=$(bash "$fixture/check-gate-drift.sh" 2>&1); rc=$?
  got=$([ $rc -eq 0 ] && echo pass || echo fail)
  if [ "$got" = "$1" ]; then
    echo "ok   $2"
  else
    echo "FAIL $2 — got $got, wanted $1"
    printf '     %s\n' "$out"
    fail=1
  fi
}

# 1 — the unmutated pair has to pass, or every other case below proves nothing.
reset
t pass "baseline: the real files agree"

# 2 — a gate added to the authority and forgotten in the agent's list.
reset
sed -i 's|^### Edit scope|### Fifth gate\n\nbody\n\n### Edit scope|' "$fixture/$skill"
t fail "gate added to the skill only"

# 3 — a gate renamed in the agent, leaving the skill's title unmatched.
reset
sed -i 's/- Review receipt —/- Receipt check —/' "$fixture/$agent"
t fail "gate renamed in the agent's list"

# 4 — round 3: renamed to a word that already appears elsewhere in the agent file
# (the Result Contract's `risks` field). The unscoped grep found it there and passed.
reset
sed -i 's|^### Edit scope|### risks|' "$fixture/$skill"
t fail "gate renamed to a word used elsewhere in the agent file"

# 5 — round 5: "Run all N gates" as the last numbered step. With only the
# next-numbered-step bound, the region ran to EOF and swallowed later prose back in.
# The mutation has to depend on that missing bound specifically: dropping a gate
# outright would DRIFT the same way regardless of where the region ends (the title
# is just gone), so it would pass even with the single bound reintroduced. Instead,
# rename a gate to text reused from the Result Contract's `risks` field — the same
# trick as case 4 — while making the gate list the last numbered step, so only the
# unbounded region's EOF swallow would let that reused text mask the rename.
reset
python3 - "$fixture/$agent" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
# Drop every numbered step after the gate list, so it is the last numbered step.
s = re.sub(r'\n3\. Merge each delta.*?(?=\n## )', '\n', s, flags=re.S)
open(p, 'w').write(s)
PY
sed -i 's|^### Edit scope|### risks|' "$fixture/$skill"
t fail "gate list is the last numbered step and a gate is renamed to reused trailing text"

# 6 — the spelled-out count in the agent no longer matches the gates that exist.
reset
sed -i 's/all four gates/all three gates/' "$fixture/$agent"
t fail "agent's spelled-out count is wrong"

# 7 — the count phrase removed entirely rather than changed. Mutate only the
# spelled-out count, not the "Run all ... gates" anchor the gate_list extraction
# matches on — breaking that anchor would make the script exit early with "no 'Run
# all N gates' step found", never reaching the empty-`actual` branch this case names.
reset
sed -i 's/Run all four gates/Run all of the gates/' "$fixture/$agent"
t fail "agent no longer spells out a count"

# 8 — the authority's own heading renamed, so no gates are found at all.
reset
sed -i 's/^## Gates.*/## Guardrails/' "$fixture/$skill"
t fail "the '## Gates' heading was renamed away"

# 9 — the third place the count is written: the orchestrator's model table.
reset
sed -i 's/behind four gates/behind three gates/' "$fixture/$orch"
t fail "orchestrator's model table count is wrong"

# 10 — that table stops spelling the count out.
reset
sed -i 's/behind four gates/after verification/' "$fixture/$orch"
t fail "orchestrator's model table drops the count"

# 11 & 12 — a command file that never forwards the hash leaves the gate unfed, so it
# fails closed forever and reports every archive unreviewed.
reset
sed -i 's/SUBJECT HASH/SUBJECT-HASH-REMOVED/g' "$fixture/$ccmd"
t fail "claude command file stops forwarding the subject hash"

reset
sed -i 's/SUBJECT HASH/SUBJECT-HASH-REMOVED/g' "$fixture/$ocmd"
t fail "opencode command file stops forwarding the subject hash"

# 13 — back to clean, proving no case leaked state into the fixture tree.
reset
t pass "baseline again after every mutation"

[ $fail -eq 0 ] && echo "gate-drift: 13 cases passed"
exit $fail
