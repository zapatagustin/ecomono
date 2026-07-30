#!/usr/bin/env bash
# Runnable check for heavy-skill-gate.sh. No framework: feeds real PreToolUse
# payloads on stdin and asserts on the decision.
#
# Payload shape verified against a live harness (claude-code 2.1.220) by
# registering a capture hook via `claude -p --settings`: PreToolUse fires for the
# Skill tool and carries `.tool_input.skill`.

set -uo pipefail
gate="$(dirname "$0")/heavy-skill-gate.sh"
fail=0

# decision <skill> -> "allow" when the gate stays silent, else the deny reason
decision() {
  local out
  out=$(printf '{"tool_name":"Skill","tool_input":{"skill":"%s"}}' "$1" | "$gate")
  [ -z "$out" ] && { echo allow; return; }
  # Reasons are multi-line; flatten so a single regex can span the whole text.
  printf '%s' "$out" \
    | jq -r '.hookSpecificOutput.permissionDecision + ":" + .hookSpecificOutput.permissionDecisionReason' \
    | tr '\n' ' '
}

check() { # check <label> <skill> <extended-regex the decision must match>
  local got; got=$(decision "$2")
  if printf '%s' "$got" | grep -Eq "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1 — got: ${got:0:120}"
    fail=1
  fi
}

check "heavy skill is denied and routed to an Agent" claude-api '^deny:.*call Agent'
check "overlap routes to the ecomono equivalent"     simplify   '^deny:.*ecomono-cut'
check "review routes to ecomono-review"              review     '^deny:.*ecomono-review'
check "security-review routes to the risk agent"     security-review '^deny:.*review-risk'
check "an ungated skill passes"                      ecomono-docs '^allow$'
check "an ecomono skill never gates itself"          ecomono-cut     '^allow$'

# Fail open: an unparseable payload must not block the session.
out=$(printf 'not json' | "$gate") || true
[ -z "$out" ] && echo "ok   malformed payload fails open" || { echo "FAIL malformed payload blocked"; fail=1; }

# Missing jq must not block either. Resolve the shell before emptying PATH, or
# the shebang lookup fails and the gate passes for the wrong reason.
sh_bin=$(command -v bash)
empty=$(mktemp -d)
out=$(printf '{"tool_input":{"skill":"claude-api"}}' | PATH="$empty" "$sh_bin" "$gate") || true
rmdir "$empty"
[ -z "$out" ] && echo "ok   missing jq fails open" || { echo "FAIL missing jq blocked"; fail=1; }

exit $fail
