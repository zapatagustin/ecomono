#!/usr/bin/env bash
# PreToolUse gate on the Workflow tool: a script whose agent() calls never name
# a model runs every one of them at the main loop's tier. Same leak
# agent-model-gate.sh closes for the Agent tool, multiplied by the fan-out —
# a 15-agent sweep inheriting the top tier costs more than the whole session
# around it. The PreToolUse "Agent" matcher never sees these spawns: they are
# internal to the Workflow run, so this gate reads the script instead.
#
# ecomono: the check is the presence of the token `model` anywhere in the
# script, not per-call matching — parsing JS argument objects with grep lies.
# A script that sets model on one agent() call and omits it on another passes;
# ceiling accepted. A `// model: inherit` comment is the explicit opt-in for
# main-loop tier and passes the same token check. Upgrade path: per-call scan
# of agent( option objects, or a linter run on the persisted script file.

set -uo pipefail

# Fail open. A gate that errors must not block every workflow in the session.
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0

script=$(printf '%s' "$payload" | jq -r '.tool_input.script // empty' 2>/dev/null) || exit 0
if [ -z "$script" ]; then
  path=$(printf '%s' "$payload" | jq -r '.tool_input.scriptPath // empty' 2>/dev/null) || exit 0
  [ -n "$path" ] && [ -f "$path" ] && script=$(cat "$path" 2>/dev/null)
fi

# Named workflows resolve outside the payload; nothing to scan. Fail open.
[ -z "$script" ] && exit 0

printf '%s' "$script" | grep -q 'agent(' || exit 0
printf '%s' "$script" | grep -q 'model' && exit 0

read -r -d '' reason <<'EOF' || true
This workflow script spawns agents with agent() and never mentions `model`, so every
spawn inherits the main loop's tier — running the whole fan-out at the most expensive
model available.

Retry with `model` set in the agent() options, per call, picked by what that stage has
to do: 'haiku' for mechanical lookups and extraction, 'sonnet' for scouting and
summarising (the usual default), 'opus' only for the hardest verify/judge stages.

If the whole workflow genuinely needs the main loop's tier, say so in the script with a
`// model: inherit` comment and it will pass.
EOF

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  }
}'
