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
cases=0
t() { # t <expected pass|fail> <description>
  local out rc got
  cases=$((cases + 1))
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

# 13 — the carrier renamed in the ORCHESTRATOR. The presence loop covers all five files, so
# this file now lacks the literal on its own and fails there directly; the census also fails,
# since the other four files still contribute `SUBJECT HASH`. Both mechanisms catch this one.
reset
sed -i 's/SUBJECT HASH/SUBJECT_HASH/g' "$fixture/$orch"
t fail "the carrier is renamed in the orchestrator only"

# 14 — renamed consistently EVERYWHERE. This is refused, and the case exists to pin WHY rather
# than to leave a reader guessing which check owns it: the presence loop requires the literal
# `SUBJECT HASH` in each of the five files, so the carrier's name is fixed and not a free choice.
# Measured when this case was written: it fails on the presence loop AND on the carrier count
# simultaneously, which is why neither check's comment may claim a consistent rename survives.
reset
for f in "$skill" "$agent" "$orch" "$ccmd" "$ocmd"; do
  sed -i 's/SUBJECT HASH/CANDIDATE FINGERPRINT/g' "$fixture/$f"
done
t fail "the carrier renamed consistently in every file is still refused"

# 15 — shape (a): the rename ESCAPES the carrier-shaped pattern entirely, in one file only.
# The census cannot fail on this: the mutated file contributes zero matching tokens and drops
# out of the vote silently, while the other four still agree, so `n_carriers` stays 1 and a
# census-only check would print `ok`. A census over pattern matches cannot notice an absence —
# this is caught by the per-file presence loop, which requires the literal in THIS file too.
reset
sed -i 's/SUBJECT HASH: {hash}/REVIEW TOKEN: {hash}/' "$fixture/$orch"
t fail "carrier renamed to text outside the pattern, in one file only"

# 16 — shape (b): text appended with no separator, in one file only. A prefix match (no `\b`)
# still extracts the literal `SUBJECT HASH` out of the widened `SUBJECT HASHES`, so both the
# old presence loop and the census would stay green. Caught only by requiring a trailing word
# boundary on the literal — not by adding another alternative to the carrier-shaped pattern,
# which is the fix this repo has buried twice already.
reset
sed -i 's/`SUBJECT HASH`/`SUBJECT HASHES`/' "$fixture/$skill"
t fail "carrier widened in place in one file, no separator"

# 17 — shape (c): text glued to the FRONT of the literal, in one file only. The trailing `\b`
# added for case 16 does not help here — a match may start anywhere in the line, so `NONSUBJECT
# HASH` satisfies it — and the census is blind too, because `grep -o` returns only the matched
# substring and discards the prefix, leaving the pooled spelling unchanged. Caught only by the
# LEADING `\b`. Found by a judge one round after case 16, in the fix for case 16.
reset
sed -i 's/SUBJECT HASH: {hash}/NONSUBJECT HASH: {hash}/' "$fixture/$orch"
t fail "carrier widened at the front in one file, no separator"

# 18 — a second spelling ADDED while the literal stays intact. This is the only case the census
# owns: every file still carries `SUBJECT HASH`, so the per-file presence loop is satisfied and
# reads green, and the drift is visible only by pooling the tokens and finding two distinct
# values. Written because deleting the census left all other cases passing — an assertion nothing
# can fail is not a check, and the census's own comment claimed exactly this capability.
reset
printf '\nForward `SUBJECT_HASH: {hash}` into the launch prompt.\n' >> "$fixture/$orch"
t fail "a second carrier spelling added alongside the literal"

# 19 — the census's disclosed ceiling, asserted as a PASS so the boundary is pinned rather than
# implied. A lowercase second spelling added alongside the intact literal is NOT caught: the
# census is case-sensitive on purpose, because all five files already use the lowercase form in
# ordinary prose about the `review/{subject-hash}` memory key, so `-i` finds several spellings on
# a clean tree and refuses it. No count here — two earlier versions carried one, both wrong.
# Two judges reproduced this escape plus variants with a dot, CamelCase and a non-breaking space.
# The day someone finds a way to tell the carrier token from prose about it, this is the case that
# flips.
#
# This case cannot fail on its own, which two judges checked and is worth stating where a reader
# will see it: a `t pass` assertion holds against a census-less check, a presence-loop-less one,
# and one that exits 0 unconditionally. Its discriminating power is borrowed from case 18 directly
# above — the only case that fails when the census is deleted. Delete 18 and this stops meaning
# anything while still printing `ok`.
reset
printf '\nForward `subject_hash={hash}` into the environment.\n' >> "$fixture/$orch"
t pass "a lowercase second spelling is outside the census, by design"

# 20 — back to clean, proving no case leaked state into the fixture tree.
reset
t pass "baseline again after every mutation"

# The count is computed, never typed. Three hand-maintained tallies in this repo rotted and were
# deleted rather than corrected a fourth time; a test that reports its own case count is the
# cheapest place to stop making the mistake.
[ $fail -eq 0 ] && echo "gate-drift: $cases cases passed"
exit $fail
