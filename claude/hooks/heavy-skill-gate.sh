#!/usr/bin/env bash
# PreToolUse gate on the Skill tool.
#
# A skill's body is injected into the thread that invokes it, and a stateless API
# resends the whole prefix every turn — so the cost of loading one is
# `size x turns_remaining`, not a one-time charge. Measured on claude-api:
# 250,123 cache-write tokens for a two-number answer, and ~$7 of a single
# session when it landed early and was re-read 61 times.
#
# Prompt rules do not hold here. The persona block calls invoking a matched
# skill through the Skill tool "a blocking requirement" and the heavy skills
# carry their own imperative triggers, so a competing instruction loses. This
# gate makes it mechanical instead: deny, explain, let the model delegate.
#
# ecomono: the denylist is manual because a skill's size is not knowable before
# invoking it — there is no size field to gate on. Add an entry only after
# measuring one (see docs/DESIGN.md "Reproducing the measurement"). Upgrade path
# if this list grows past a handful: read it from a file the gate consults.

set -uo pipefail

# Fail open. A gate that errors must not block every skill in the session.
command -v jq >/dev/null 2>&1 || exit 0

skill=$(cat | jq -r '.tool_input.skill // empty' 2>/dev/null) || exit 0
[ -n "$skill" ] || exit 0

case "$skill" in
  claude-api) ;;
  *) exit 0 ;;
esac

read -r -d '' reason <<EOF || true
'$skill' is a reference skill. Loading it here injects its entire body (~250k tokens for
claude-api) into this conversation, and you pay that on every later turn, not once.

Do not retry this call. Instead delegate in one step: call Agent with a prompt that names
the skill and states exactly what you need back, for example "Invoke the $skill skill and
return only <the specific facts>". The body then lives in the subagent's context and dies
when it returns.
EOF

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  }
}'
