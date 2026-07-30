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
check "a project agent carrying frontmatter is not gated" \
  "$(p '{"subagent_type":"ecomono-sdd-apply","prompt":"implement"}')" '^allow$'
check "fork is never gated — it cannot take a model" \
  "$(p '{"subagent_type":"fork","prompt":"continue"}')" '^allow$'
check "an unknown plugin agent passes" \
  "$(p '{"subagent_type":"some-plugin-agent","prompt":"x"}')" '^allow$'

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
