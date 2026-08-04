#!/usr/bin/env bash
# Runnable check for review-receipt-gate.sh. No framework: builds a real git repo in a
# temp dir, writes real receipts, feeds real PreToolUse payloads on stdin.
#
# A git repo rather than a stub because every branch in the gate depends on git's own
# answers — merge-base resolution, the diff bytes, the common directory. A mocked `git`
# would test the mock.
#
# The negatives carry the weight here. A gate that blocks a push it should not blocks the
# fix for itself, so "off by default", "not a push", and the release valve are the cases
# most worth failing on.

set -uo pipefail
gate="$(cd "$(dirname "$0")" && pwd)/review-receipt-gate.sh"
fail=0

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT

# A feature branch off master, which is the shape the gate is written for: on master
# itself `git merge-base HEAD master` is HEAD, the diff is empty, and there is nothing to
# review. That case is covered explicitly further down.
git -C "$repo" init -q -b master .
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git -C "$repo" checkout -q -b work
printf 'one\n' > "$repo/file.txt"
git -C "$repo" add file.txt
git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m change

gitdir="$repo/.git"
receipts="$gitdir/ecomono/receipts"
marker="$gitdir/ecomono/review-mode"
mkdir -p "$receipts"

# The gate's formula, recomputed here independently so a change to either side shows up
# as a failing test rather than as a gate nobody can satisfy.
subject_hash() {
  git -C "$repo" diff "$(git -C "$repo" merge-base HEAD master)" | sha256sum | cut -c1-12
}

arm()    { : > "$marker"; }
disarm() { rm -f "$marker"; }
receipt() { printf '%s\n' "$1" "hash: $2" > "$receipts/$2"; }   # receipt <verdict> <hash>

# decision <command> -> "allow" when the gate stays silent, else "<decision>:<reason>"
decision() {
  local out
  out=$(cd "$repo" && jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' | "$gate")
  [ -z "$out" ] && { echo allow; return; }
  printf '%s' "$out" \
    | jq -r '.hookSpecificOutput.permissionDecision + ":" + .hookSpecificOutput.permissionDecisionReason' \
    | tr '\n' ' '
}

check() { # check <label> <command> <extended-regex the decision must match>
  local got; got=$(decision "$2")
  if printf '%s' "$got" | grep -Eq "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1 — got: ${got:0:160}"
    fail=1
  fi
}

echo "-- off by default: no marker, no gate"
disarm
rm -f "$receipts"/*
check "push with no marker"        'git push'                    '^allow$'
check "gh pr create with no marker" 'gh pr create --fill'        '^allow$'

echo
echo "-- armed, and the receipt decides"
arm
h=$(subject_hash)
check "armed, no receipt at all"   'git push'                    '^deny:.*no review receipt'
check "refusal names the review"   'git push'                    '/ecomono-judgment'
check "refusal names the hash"     'git push'                    "$h"
check "refusal reserves the valve" 'git push'                    'do not set ECOMONO_ALLOW_UNREVIEWED_PUSH yourself'

receipt APPROVED "$h"
check "APPROVED receipt lets it through" 'git push'              '^allow$'
check "same for gh pr create"      'gh pr create --fill'         '^allow$'

receipt ESCALATED "$h"
check "ESCALATED is not approval"  'git push'                    '^deny:.*ESCALATED'

echo
echo "-- a receipt is bound to bytes, not to a branch"
receipt APPROVED "$h"
printf 'two\n' >> "$repo/file.txt"
check "bytes moved after the receipt" 'git push'                 '^deny:.*no review receipt'
h2=$(subject_hash)
[ "$h" != "$h2" ] && echo "ok   the hash actually moved" \
  || { echo "FAIL fixture did not change the subject hash"; fail=1; }
# Committing the same bytes must NOT invalidate the receipt: the formula diffs the
# merge-base against the working tree, so staged and committed work land on one hash.
receipt APPROVED "$h2"
git -C "$repo" add file.txt
git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m more
check "committing the reviewed bytes keeps the receipt valid" 'git push' '^allow$'

echo
echo "-- the empty-diff hash is not a skeleton key"
# sha256 of the empty string is a public constant, so a receipt under it would pass in
# any repo on any tree. The gate skips that hash instead of matching it.
rm -f "$receipts"/*
receipt APPROVED e3b0c44298fc
check "empty-diff receipt unlocks nothing" 'git push'            '^deny:.*no review receipt'

echo
echo "-- commands that are not a delivery"
rm -f "$receipts"/*
check "git status"                 'git status --short'          '^allow$'
check "git commit"                 'git commit -m x'             '^allow$'
check "a push in a commit message" 'git commit -m "note about git pushing"' '^deny:'

echo
echo "-- nothing to review"
# On the base branch itself the diff against the merge-base is empty. There are no bytes
# under review, so the gate must not demand a receipt for them.
git -C "$repo" checkout -q master
check "on the base branch, armed, no receipt" 'git push'         '^allow$'
git -C "$repo" checkout -q work

echo
echo "-- release valve, both shapes"
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | ECOMONO_ALLOW_UNREVIEWED_PUSH=1 "$gate") || true
[ -z "$out" ] && echo "ok   env valve stands down" || { echo "FAIL env valve ignored"; fail=1; }
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | ECOMONO_ALLOW_UNREVIEWED_PUSH=0 "$gate") || true
[ -n "$out" ] && echo "ok   any value but 1 keeps the gate armed" \
  || { echo "FAIL gate disarmed by a non-1 value"; fail=1; }
# The refusal tells the user to re-run with the prefix, so the prefix must actually work.
check "inline prefix valve"        'ECOMONO_ALLOW_UNREVIEWED_PUSH=1 git push' '^allow$'

echo
echo "-- fails open"
out=$(cd "$repo" && printf 'not json' | "$gate") || true
[ -z "$out" ] && echo "ok   malformed payload fails open" || { echo "FAIL malformed payload blocked"; fail=1; }

out=$(cd "$repo" && jq -nc '{tool_name:"Bash",tool_input:{}}' | "$gate") || true
[ -z "$out" ] && echo "ok   missing command fails open" || { echo "FAIL empty command blocked"; fail=1; }

sh_bin=$(command -v bash)
empty=$(mktemp -d)
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | PATH="$empty" "$sh_bin" "$gate") || true
rmdir "$empty"
[ -z "$out" ] && echo "ok   missing jq fails open" || { echo "FAIL missing jq blocked"; fail=1; }

outside=$(mktemp -d)
out=$(cd "$outside" && jq -nc '{tool_input:{command:"git push"}}' | "$gate") || true
rm -rf "$outside"
[ -z "$out" ] && echo "ok   outside a git repo fails open" || { echo "FAIL non-repo blocked"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then echo "review-receipt-gate: all cases passed"; fi
exit $fail
