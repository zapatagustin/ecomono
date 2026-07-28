#!/usr/bin/env bash
# PreToolUse gate on the Agent tool: refuse a delegation to a built-in agent
# type that does not name a model.
#
# An Agent call without `model` inherits the parent's. Agents defined in
# claude/agents/ are fine — all 17 carry `model:` in frontmatter, which wins when
# the parameter is absent. The built-in types have no file to put the field in,
# so from an Opus main loop they run file search on Opus, and from a Haiku one
# they run design work on Haiku. Both directions were measured; see
# docs/DESIGN.md "Model tier is 5x, not 60x".
#
# Three things would have to hold for a prompt rule to cover this and none do:
# the delegation rule in CLAUDE.md names an agent but no model; the
# `default | sonnet` row lives in skills/_shared/sdd-orchestrator.md, which is
# loaded only when an SDD cycle starts, so it is unreachable for exactly the
# non-SDD delegations that need it; and a default in a lazily-loaded file is not
# a default.
#
# Payload verified at claude-code 2.1.220 by registering a capture hook through
# `claude -p --settings`: PreToolUse fires on tool_name "Agent" and tool_input
# carries `model` when passed and omits the key when not.
#
# ecomono: the gated list is manual and enumerates built-in types, because
# "has no frontmatter" is not a property the payload exposes. It excludes `fork`
# on purpose — forks always inherit the parent model and ignore the parameter, so
# demanding one there is unsatisfiable. Unknown types pass, which keeps a new
# plugin agent from being blocked by a list that has not heard of it. Upgrade
# path if this grows: resolve the type against ~/.claude/agents and gate on a
# missing `model:` line instead of on a name.

set -uo pipefail

# Fail open. A gate that errors must not block every delegation in the session.
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0

model=$(printf '%s' "$payload" | jq -r '.tool_input.model // empty' 2>/dev/null) || exit 0
[ -n "$model" ] && exit 0

# An absent subagent_type means general-purpose, which is itself a built-in.
agent=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type // "general-purpose"' 2>/dev/null) || exit 0

case "$agent" in
  Explore|Plan|general-purpose|claude|claude-code-guide|statusline-setup) ;;
  *) exit 0 ;;
esac

read -r -d '' reason <<EOF || true
This delegates to '$agent', a built-in agent type with no frontmatter, so omitting \`model\`
makes it inherit the main loop's — running search and file reading at the main loop's tier.

Retry the same call with \`model\` set. Pick by what the subagent has to do, not by what it
reads:

  haiku   exact target. "where is X defined", "list the env vars in this yaml", "does this
          file exist" — a lookup with one right answer.
  sonnet  scouting with judgement. Several files, has to decide what matters and summarise.
          The default for Explore.
  opus    only when the subagent must reason about architecture or trade-offs, not locate.

If this agent genuinely needs the main loop's tier, say so and pass it explicitly.
EOF

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  }
}'
