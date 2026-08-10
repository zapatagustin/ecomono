#!/usr/bin/env bash
# Fixtures for check-judge-twins.sh — bash test-judge-twins.sh
#
# The check is one diff, so the risk is not that it fails to compare — it is that the
# normalisation is too wide and quietly erases a real difference. Most cases below exist
# for that direction rather than for the obvious one.
#
# Every case copies the two real agent files into a throwaway tree and mutates the copy.
# The real repo is never touched.

set -uo pipefail
cd "$(dirname "$0")"
repo=$PWD

fixture=$(mktemp -d) || exit 1
trap 'rm -rf "$fixture"' EXIT

a=claude/agents/ecomono-judge-a.md
b=claude/agents/ecomono-judge-b.md

reset() {
  rm -rf "$fixture"/*
  for f in "$a" "$b"; do
    mkdir -p "$fixture/$(dirname "$f")"
    cp "$repo/$f" "$fixture/$f"
  done
  cp "$repo/check-judge-twins.sh" "$fixture/"
}

fail=0
cases=0
t() { # t <expected pass|fail> <description>
  local out rc got
  cases=$((cases + 1))
  out=$(bash "$fixture/check-judge-twins.sh" 2>&1); rc=$?
  got=$([ $rc -eq 0 ] && echo pass || echo fail)
  if [ "$got" = "$1" ]; then
    echo "ok   $2"
  else
    echo "FAIL $2 — got $got, wanted $1"
    printf '     %s\n' "$out"
    fail=1
  fi
}

# 1 — the real pair has to pass, or every case below proves nothing. This is also the case that
# fails if the normalisation is too NARROW: the letter appears in both files by design.
reset
t pass "the real judges are twins"

# 2 — the asymmetry that matters most. A judge with a capability the other lacks is not a peer,
# and both still return verdicts, so nothing else would notice.
reset
sed -i 's/^tools: \(.*\)$/tools: \1, Write/' "$fixture/$a"
t fail "one judge gains a tool the other lacks"

# 3 — an instruction present in one and absent in the other. This is the shape the round that
# motivated the check nearly shipped: one reporting sentence added to a single file.
reset
printf -- '- Extra instruction only this judge receives.\n' >> "$fixture/$b"
t fail "an instruction reaches only one judge"

# 4 — a wording difference with no semantic weight still fails, because the comparison is bytes
# and the alternative is deciding which differences are meaningful.
reset
sed -i 's/adversarial/adversarial and thorough/' "$fixture/$a"
t fail "a reworded line in one file only"

# 5 — the normalisation must not be wider than the identity letter. A standalone A/B used for
# anything else has to survive as a difference; collapsing it would erase real drift wherever the
# files happen to enumerate options.
reset
printf -- '- Prefer criterion A when the two conflict.\n' >> "$fixture/$a"
printf -- '- Prefer criterion B when the two conflict.\n' >> "$fixture/$b"
t fail "a standalone A/B outside the identity tokens is not collapsed"

# 6 — the copy-paste error the per-file normalisation exists for: judge-b's own text calling
# itself judge A. Normalising both files with both letters maps this onto the same string on both
# sides and passes it. Change `norm` to take both letters and this is the case that flips.
reset
sed -i 's/judge B/judge A/' "$fixture/$b"
t fail "judge-b describing itself as judge A"

# 7 — same shape in the hyphenated identity token, which is the one that appears in paths and
# agent names rather than in prose.
reset
sed -i 's/ecomono-judge-b/ecomono-judge-a/g' "$fixture/$b"
t fail "judge-b naming itself with judge-a's identifier"

# 8 — a missing file must be loud, not a silent pass on an empty comparison.
reset
rm -f "$fixture/$b"
t fail "one judge file is absent"

# 9 — back to clean, proving no case leaked state into the fixture tree.
reset
t pass "the real pair again after every mutation"

# Computed, never typed — this repo has deleted five hand-maintained tallies for rotting.
[ $fail -eq 0 ] && echo "judge-twins: $cases cases passed"
exit $fail
