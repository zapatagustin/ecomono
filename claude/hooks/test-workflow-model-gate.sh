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

# Isolated empty project dir: a named workflow with no matching file on disk
# must fail open regardless of ambient repo state.
isolated=$(mktemp -d)
export CLAUDE_PROJECT_DIR="$isolated"
check "named workflow with no script passes" \
  "$(p '{"name":"review-changes"}')" '^allow$'
unset CLAUDE_PROJECT_DIR
rm -rf "$isolated"

check "hatch phrase inside a string literal no longer counts" \
  "$(p "$(j 'const note = "see // model: inherit for details"; await agent("x")')")" '^deny:.*model'
check "real whole-line inherit comment passes" \
  "$(p "$(j '// model: inherit
await agent("x")')")" '^allow$'
check "newline before the paren with no model is denied" \
  "$(p "$(j 'await agent
("find bugs")')")" '^deny:.*model'
check "subagent( is not mistaken for agent(" \
  "$(p "$(j 'function subagent(x){return x} subagent(1)')")" '^allow$'
check "ES2015 shorthand model option passes" \
  "$(p "$(j 'const model = "haiku"; await agent("x", {model})')")" '^allow$'
check "prompt text mentioning 'model' with no model option is denied" \
  "$(p "$(j 'await agent("review the pricing model")')")" '^deny:.*model'
check "prose 'model:'-shaped text with no real option is denied" \
  "$(p "$(j 'await agent("review the business model: freemium tier")')")" '^deny:.*model'
check "multi-line option object passes" \
  "$(p "$(j 'await agent("x", {
  model: "haiku"
})')")" '^allow$'
check "prose 'model:' in a comment plus a model-less agent() is denied" \
  "$(p "$(j '// business model: freemium tier
await agent("find bugs")')")" '^deny:.*model'

# scriptPath variant: the gate reads the file from disk.
tmp=$(mktemp)
printf 'await agent("sweep")' > "$tmp"
check "scriptPath without model is denied" \
  "$(p "{\"scriptPath\":\"$tmp\"}")" '^deny:'
printf 'await agent("sweep", {model: "sonnet"})' > "$tmp"
check "scriptPath with model passes" \
  "$(p "{\"scriptPath\":\"$tmp\"}")" '^allow$'
rm -f "$tmp"

# name variant: the gate resolves .claude/workflows/<name>.js under CLAUDE_PROJECT_DIR.
fixtures=$(mktemp -d)
mkdir -p "$fixtures/.claude/workflows"
printf 'await agent("sweep")' > "$fixtures/.claude/workflows/review-changes.js"
export CLAUDE_PROJECT_DIR="$fixtures"
check "named workflow resolved on disk without model is denied" \
  "$(p '{"name":"review-changes"}')" '^deny:'
printf 'await agent("sweep", {model: "haiku"})' > "$fixtures/.claude/workflows/review-changes.js"
check "named workflow resolved on disk with model passes" \
  "$(p '{"name":"review-changes"}')" '^allow$'
check "unknown named workflow with no file on disk fails open" \
  "$(p '{"name":"some-built-in-workflow"}')" '^allow$'
unset CLAUDE_PROJECT_DIR
rm -rf "$fixtures"

# An inline script bigger than the read cap must not hang the gate — any
# decision is fine, the assertion is that it returns promptly. Built via a
# file + jq -Rs (not the j() helper) so the payload never hits argv/ARG_MAX.
bigfile=$(mktemp)
head -c 300000 /dev/zero | tr '\0' 'a' > "$bigfile"
jq -Rsc '{tool_name:"Workflow", tool_input:{script: .}}' "$bigfile" \
  | timeout 5 "$gate" >/dev/null 2>&1
rc=$?
rm -f "$bigfile"
[ "$rc" -ne 124 ] && echo "ok   oversized inline script does not hang" || { echo "FAIL oversized inline script timed out"; fail=1; }

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
