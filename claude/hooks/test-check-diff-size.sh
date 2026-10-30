#!/usr/bin/env bash
# Runnable check for check-diff-size.sh. No framework: a throwaway repo with a 401-line
# branch diff, real PreToolUse payloads on stdin, assertions on the decision. Silent off a
# delivery and below the threshold; "ask" above it; advisory (no permissionDecision) under
# bypassPermissions, where the reason has to say the command ran.
set -uo pipefail
gate="$(cd "$(dirname "$0")" && pwd)/check-diff-size.sh"
fail=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
git init -q -b master "$repo"
g() { git -C "$repo" -c user.email=t@t -c user.name=t "$@"; }
: > "$repo/f.txt"; g add f.txt; g commit -q -m base
g checkout -q -b feat
seq 1 401 > "$repo/f.txt"; g commit -q -am big

# decision <command> -> "allow" when the gate stays silent, else "<decision>:<reason>".
# MODE=<permission_mode> adds that field to the payload; no decision reads "advisory:<context>".
decision() {
  local out
  out=$(cd "$repo" && jq -nc --arg c "$1" --arg pm "${MODE:-}" \
    '{tool_name:"Bash",tool_input:{command:$c}} + (if $pm == "" then {} else {permission_mode:$pm} end)' | "$gate")
  [ -z "$out" ] && { echo allow; return; }
  printf '%s' "$out" \
    | jq -r '(.hookSpecificOutput.permissionDecision // "advisory") + ":" + (.hookSpecificOutput.permissionDecisionReason // .hookSpecificOutput.additionalContext)'
}
check() { # check <label> <command> <extended-regex the decision must match>
  local got; got=$(decision "$2")
  if printf '%s' "$got" | grep -Eq "$3"; then echo "ok   $1"; else echo "FAIL $1 — got: ${got:0:120}"; fail=1; fi
}

check "not a delivery: silent"             'git status'    '^allow$'
check "large diff asks on git push"        'git push'      '^ask:.*401 changed lines'
check "large diff asks on gh pr create"    'gh pr create'  '^ask:'
MODE=default           check "default mode still asks"            'git push' '^ask:'
MODE=bypassPermissions check "advisory under bypassPermissions"   'git push' '^advisory:'
MODE=bypassPermissions check "advisory reason says the command ran" 'git push' 'ran without a prompt'
seq 1 10 > "$repo/f.txt"; g commit -q -am small
check "small diff: silent"                 'git push'      '^allow$'

exit $fail
