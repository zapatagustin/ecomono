#!/usr/bin/env bash
# Fixtures for check-panel-drift.sh — bash test-panel-drift.sh
#
# The check is what catches the Claude pane's copied git parsers drifting from omp's, so a regression in it is
# silent by construction: it keeps printing `ok` while the drift walks past. Each case below is a drift it must
# catch, on a throwaway copy of the files it reads, with the same relative layout; the real repo is never touched.

set -uo pipefail
cd "$(dirname "$0")"
repo=$PWD

fixture=$(mktemp -d) || exit 1
trap 'rm -rf "$fixture"' EXIT

copy=claude/plugins/org-todo/hooks/git.ts
git_src=omp/extensions/ecomono/panel/git.ts
text_src=omp/extensions/ecomono/panel/text.ts

reset() {
  rm -rf "${fixture:?}"/*
  for f in "$copy" "$git_src" "$text_src"; do
    mkdir -p "$fixture/$(dirname "$f")"
    cp "$repo/$f" "$fixture/$f"
  done
  cp "$repo/check-panel-drift.sh" "$fixture/"
}

fail=0
cases=0
t() { # t <expected pass|fail> <description>
  local out rc got
  cases=$((cases + 1))
  out=$(bash "$fixture/check-panel-drift.sh" 2>&1); rc=$?
  got=$([ $rc -eq 0 ] && echo pass || echo fail)
  if [ "$got" = "$1" ]; then
    echo "ok   $2"
  else
    echo "FAIL $2 — got $got, wanted $1"
    printf '     %s\n' "$out"
    fail=1
  fi
}

# The first line inside a copied region, by its opening marker.
first_in() { grep -n -F -x "// <<< copied: $1" "$fixture/$copy" | cut -d: -f1 | awk '{ print $1 + 1 }'; }
# The closing marker's line.
end_of() { grep -n -F -x "// >>> copied: $1" "$fixture/$copy" | cut -d: -f1; }

# 1 — the unmutated tree has to pass, or every case below proves nothing.
reset
t pass "baseline: the real copy matches omp"

# 2 — one byte changed inside each copied region.
reset
sed -i "$(first_in "$git_src")s/./#/" "$fixture/$copy"
t fail "one byte changed in the git.ts region"
reset
sed -i "$(first_in "$text_src")s/./#/" "$fixture/$copy"
t fail "one byte changed in the text.ts region"

# 3 — a trailing blank line, which command substitution would have dropped: in the copy before its closing
# marker, and at the end of the source whose region runs to the end of the file.
reset
sed -i "$(end_of "$git_src")i\\\\" "$fixture/$copy"
t fail "a blank line added at the end of the copied git.ts region"
reset
echo >> "$fixture/$git_src"
t fail "a blank line added at the end of omp's git.ts"

# 4 — markers missing: the opening one leaves an empty region, the closing one a region that runs on.
reset
sed -i "\\|^// <<< copied: $git_src\$|d" "$fixture/$copy"
t fail "the opening marker of the git.ts region removed"
reset
sed -i "\\|^// >>> copied: $text_src\$|d" "$fixture/$copy"
t fail "the closing marker of the text.ts region removed"

# 5 — back to clean, proving no case leaked state into the fixture tree.
reset
t pass "baseline again after every mutation"

[ $fail -eq 0 ] && echo "panel-drift: $cases cases passed"
exit $fail
