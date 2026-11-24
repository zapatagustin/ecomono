#!/usr/bin/env bash
# PreToolUse gate on the Skill tool. Two jobs, one mechanism: deny, explain,
# let the model take the route the reason names.
#
# 1. Weight. A skill's body is injected into the thread that invokes it, and a
#    stateless API resends the whole prefix every turn — so the cost of loading
#    one is `size x turns_remaining`, not a one-time charge. Measured on
#    claude-api: 250,123 cache-write tokens for a two-number answer, and ~$7 of a
#    single session when it landed early and was re-read 61 times. Route these
#    through an Agent, whose context dies on return: the gate denies them in the
#    main thread only and stays silent when a subagent makes the call.
#
# 2. Ownership. Some harness-shipped skills cover a job an ecomono skill already
#    owns, and their trigger phrases collide outright — the shipped `review`
#    skill and `ecomono-review` both claim "review this PR" and `/review`, so
#    which one matches is arbitrary. Route these to the ecomono equivalent.
#
# Prompt rules do not hold for either job. The persona block calls invoking a
# matched skill through the Skill tool "a blocking requirement" and the shipped
# skills carry their own imperative triggers, so a competing bullet loses. A
# gate is mechanical; a bullet is a suggestion.
#
# ecomono: both lists are manual. Weight is not knowable before invoking a skill
# — there is no size field to gate on, so an entry belongs there only after being
# measured (see docs/DESIGN.md "Reproducing the measurement"). Ownership is a
# judgement call about scope overlap, which no field carries either. Upgrade path
# if either list grows past a handful: read them from a file the gate consults.

set -uo pipefail

# Fail open. A gate that errors must not block every skill in the session.
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat)
skill=$(printf '%s' "$payload" | jq -r '.tool_input.skill // empty' 2>/dev/null) || exit 0
[ -n "$skill" ] || exit 0

ours=""
case "$skill" in
  claude-api)
    # Weight only bites a thread that keeps the body. `agent_id` is present when the call comes
    # from a subagent, whose context dies on return: that is the route the deny reason names, so
    # denying there too leaves no way to load the skill at all. `agent_type` alone does not
    # qualify, because a `--agent` session carries it in its main thread.
    agent_id=$(printf '%s' "$payload" | jq -r '.agent_id // empty' 2>/dev/null) || exit 0
    [ -n "$agent_id" ] && exit 0
    ;;
  simplify) ours="ecomono-cut for a diff, ecomono-audit for the whole repo" ;;
  review) ours="ecomono-review for the comment format, or ecomono-judgment for dual adversarial review" ;;
  security-review) ours="the ecomono-r1-risk agent (R1), launched via Agent" ;;
  *) exit 0 ;;
esac

if [ -n "$ours" ]; then
  read -r -d '' reason <<EOF || true
'$skill' ships with the harness and covers a job an ecomono skill already owns here.
Use $ours instead.

Do not retry this call. The ecomono version carries this repo's output rules — one line
per finding, location first, no throat-clearing — which '$skill' would override with its
own format instructions.
EOF
else
  read -r -d '' reason <<EOF || true
'$skill' is a reference skill. Loading it here injects its entire body (~250k tokens for
claude-api) into this conversation, and you pay that on every later turn, not once.

Do not retry this call. Instead delegate in one step: call Agent with a prompt that names
the skill and states exactly what you need back, for example "Invoke the $skill skill and
return only <the specific facts>". The body then lives in the subagent's context and dies
when it returns.
EOF
fi

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  }
}'
