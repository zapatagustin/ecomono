#!/usr/bin/env bash
# `ecomono-judgment` means something only if its two judges are equivalent. Agreement between
# blind reviewers is the entire signal: two of them converging on a finding is evidence, one of
# them finding it is a hypothesis. That inference holds only while the two are interchangeable.
# An asymmetric tools list, or an instruction one holds and the other does not, breaks it in the
# quietest way available — both judges still return verdicts, the round still reads normal, and
# the disagreement it produces looks like a finding about the code instead of a finding about the
# harness.
#
# Measured before this check existed: claude/agents/ecomono-judge-a.md and ecomono-judge-b.md are
# byte-identical apart from the letter that names them. So the comparison is available and cheap,
# and nothing was making it. The round that motivated this added one reporting sentence to both
# judge files; adding it to one would have produced exactly the silent asymmetry above.
#
# This is a two-artifact byte comparison, not a claim about what either file means: normalise the
# identity letter, diff, fail on any remaining difference.
#
# Each file is normalised with ITS OWN letter, never with both. Collapsing `a` and `b` in both
# files would map a copy-paste error — judge-b's own text calling itself judge A — onto the same
# string on both sides and pass it. With per-file normalisation that error survives as a
# difference and fails. A fixture pins it.
#
# ecomono: there is no exception mechanism, deliberately. No legitimate asymmetry exists today, so
# an ignore list would be scaffolding for a case nobody has. If one ever appears the check fails
# loudly and whoever needs the exception adds it then, visibly — which is the direction this repo
# argues for: an omission that shouts beats a key that forgets. This also covers only the two
# judges. ecomono-judge-fix is not a twin of anything and is out of scope.

set -uo pipefail
cd "$(dirname "$0")"

a=claude/agents/ecomono-judge-a.md
b=claude/agents/ecomono-judge-b.md

for f in "$a" "$b"; do
  [ -r "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
done

# norm <file> <letter> — collapse only the tokens that name which judge this is.
norm() {
  local l=$2 u
  u=$(printf '%s' "$l" | tr '[:lower:]' '[:upper:]')
  sed -e "s/ecomono-judge-$l/ecomono-judge-X/g" \
      -e "s/judge-$l/judge-X/g" \
      -e "s/\bjudge $u\b/judge X/g" \
      -e "s/\bJudge $u\b/Judge X/g" "$1"
}

fail=0
if ! d=$(diff <(norm "$a" a) <(norm "$b" b)); then
  echo "DRIFT — the two blind judges are not interchangeable, so their agreement proves less than it looks like:"
  printf '%s\n' "$d" | sed 's/^/       /'
  fail=1
fi

[ $fail -eq 0 ] && echo "ok   judge-a and judge-b agree byte for byte, modulo the letter that names them"
exit $fail
