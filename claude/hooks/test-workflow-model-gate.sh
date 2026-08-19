#!/usr/bin/env bash
# Runnable check for workflow-model-gate.sh. No framework: feeds PreToolUse
# payloads on stdin and asserts on the decision. Same harness shape as
# test-agent-model-gate.sh.

set -uo pipefail
gate="$(dirname "$0")/workflow-model-gate.sh"
fail=0

decision() {
  local out
  out=$(printf '%s' "$1" | "$gate")
  [ -z "$out" ] && { echo allow; return; }
  printf '%s' "$out" \
    | jq -r '.hookSpecificOutput.permissionDecision + ":" + .hookSpecificOutput.permissionDecisionReason' \
    | tr '\n' ' '
}

check() { # check <label> <json> <extended-regex the decision must match>
  local got; got=$(decision "$2")
  if printf '%s' "$got" | grep -Eq "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1 — got: ${got:0:120}"
    fail=1
  fi
}

p() { printf '{"tool_name":"Workflow","tool_input":%s}' "$1"; }
j() { jq -nc --arg s "$1" '{script: $s}'; } # script payload, safely quoted

check "agent() with no model anywhere is denied" \
  "$(p "$(j 'export const meta = {}; await agent("find bugs")')")" '^deny:.*model'
check "agent() with per-call model passes" \
  "$(p "$(j 'await agent("find bugs", {model: "haiku"})')")" '^allow$'
check "explicit inherit comment passes" \
  "$(p "$(j '// model: inherit
await agent("needs full context")')")" '^allow$'
check "script with no agent() calls passes" \
  "$(p "$(j 'export const meta = {}; return 42')")" '^allow$'
check "named workflow with no script passes" \
  "$(p '{"name":"review-changes"}')" '^allow$'

# scriptPath variant: the gate reads the file from disk.
tmp=$(mktemp)
printf 'await agent("sweep")' > "$tmp"
check "scriptPath without model is denied" \
  "$(p "{\"scriptPath\":\"$tmp\"}")" '^deny:'
printf 'await agent("sweep", {model: "sonnet"})' > "$tmp"
check "scriptPath with model passes" \
  "$(p "{\"scriptPath\":\"$tmp\"}")" '^allow$'
rm -f "$tmp"

# Fail open: an unparseable payload must not block the session.
out=$(printf 'not json' | "$gate") || true
[ -z "$out" ] && echo "ok   malformed payload fails open" || { echo "FAIL malformed payload blocked"; fail=1; }

# Missing jq must not block either. Resolve the shell before emptying PATH, or
# the shebang lookup fails and the gate passes for the wrong reason.
sh_bin=$(command -v bash)
empty=$(mktemp -d)
out=$(p '{"script":"await agent(\"x\")"}' | PATH="$empty" "$sh_bin" "$gate") || true
rmdir "$empty"
[ -z "$out" ] && echo "ok   missing jq fails open" || { echo "FAIL missing jq blocked"; fail=1; }

exit $fail
