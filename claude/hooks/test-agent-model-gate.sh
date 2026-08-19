#!/usr/bin/env bash
# Runnable check for agent-model-gate.sh. No framework: feeds PreToolUse payloads
# on stdin and asserts on the decision.
#
# The payloads below are the shape a live harness sends (claude-code 2.1.220),
# captured by registering a dump hook via `claude -p --settings`.

set -uo pipefail
gate="$(dirname "$0")/agent-model-gate.sh"
fail=0

# decision <json> -> "allow" when the gate stays silent, else "deny:<reason>"
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

p() { printf '{"tool_name":"Agent","tool_input":%s}' "$1"; }

check "built-in without model is denied" \
  "$(p '{"subagent_type":"Explore","prompt":"find X"}')" '^deny:.*model'
check "the deny names the tier mapping" \
  "$(p '{"subagent_type":"Explore","prompt":"find X"}')" 'haiku.*sonnet.*opus'
check "built-in with model passes" \
  "$(p '{"subagent_type":"Explore","model":"sonnet","prompt":"find X"}')" '^allow$'
check "absent subagent_type defaults to general-purpose and is gated" \
  "$(p '{"prompt":"find X"}')" '^deny:'
check "empty subagent_type defaults to general-purpose and is gated" \
  "$(p '{"subagent_type":"","prompt":"find X"}')" '^deny:'
check "a project agent carrying frontmatter is not gated" \
  "$(p '{"subagent_type":"ecomono-sdd-apply","prompt":"implement"}')" '^allow$'
check "fork is never gated — it cannot take a model" \
  "$(p '{"subagent_type":"fork","prompt":"continue"}')" '^allow$'
check "an unknown plugin agent passes" \
  "$(p '{"subagent_type":"some-plugin-agent","prompt":"x"}')" '^allow$'

# A definition on disk without `model:` is gated like a built-in; with it, passes.
# CLAUDE_PROJECT_DIR points the gate's project lookup at a fixture tree.
fixtures=$(mktemp -d)
mkdir -p "$fixtures/.claude/agents"
printf -- '---\ndescription: no model here\n---\n' > "$fixtures/.claude/agents/bare-agent.md"
printf -- '---\ndescription: has one\nmodel: haiku\n---\n' > "$fixtures/.claude/agents/tiered-agent.md"
export CLAUDE_PROJECT_DIR="$fixtures"
check "an on-disk definition missing model: is denied" \
  "$(p '{"subagent_type":"bare-agent","prompt":"x"}')" '^deny:.*model'
check "an on-disk definition with model: passes" \
  "$(p '{"subagent_type":"tiered-agent","prompt":"x"}')" '^allow$'

printf -- '---\r\ndescription: crlf frontmatter\r\nmodel: haiku\r\n---\r\n' \
  > "$fixtures/.claude/agents/crlf-agent.md"
check "a CRLF frontmatter with model: passes" \
  "$(p '{"subagent_type":"crlf-agent","prompt":"x"}')" '^allow$'

# A model: line inside the body (past the closing ---) must not count.
printf -- '---\ndescription: no model in frontmatter\n---\nExample: set model: haiku in your call.\n' \
  > "$fixtures/.claude/agents/body-only-model.md"
check "a body-only model: line does not count as frontmatter" \
  "$(p '{"subagent_type":"body-only-model","prompt":"x"}')" '^deny:.*model'

# A file with only an opening `---` (truncated write) has no frontmatter at
# all — a body-ish `model:` line after it must not false-pass.
printf -- '---\ndescription: truncated, no closing delimiter\nmodel: haiku\n' \
  > "$fixtures/.claude/agents/truncated-frontmatter.md"
check "a file with only an opening --- and a body-ish model: line is denied" \
  "$(p '{"subagent_type":"truncated-frontmatter","prompt":"x"}')" '^deny:.*model'

# fork.md on disk with no model: must still pass — the exclusion is unconditional.
printf -- '---\ndescription: fork, no model\n---\n' > "$fixtures/.claude/agents/fork.md"
check "fork passes even with a model-less fork.md fixture on disk" \
  "$(p '{"subagent_type":"fork","prompt":"continue"}')" '^allow$'
unset CLAUDE_PROJECT_DIR
rm -rf "$fixtures"

# A path-shaped subagent_type must not traverse out of the agents directory —
# it falls through to the manual list and passes like any unknown type.
check "a path-traversal subagent_type falls through to allow" \
  "$(p '{"subagent_type":"../../../etc/passwd","prompt":"x"}')" '^allow$'

# Fail open: an unparseable payload must not block the session.
out=$(printf 'not json' | "$gate") || true
[ -z "$out" ] && echo "ok   malformed payload fails open" || { echo "FAIL malformed payload blocked"; fail=1; }

# Missing jq must not block either. Resolve the shell before emptying PATH, or
# the shebang lookup fails and the gate passes for the wrong reason.
sh_bin=$(command -v bash)
empty=$(mktemp -d)
out=$(p '{"subagent_type":"Explore"}' | PATH="$empty" "$sh_bin" "$gate") || true
rmdir "$empty"
[ -z "$out" ] && echo "ok   missing jq fails open" || { echo "FAIL missing jq blocked"; fail=1; }

exit $fail
