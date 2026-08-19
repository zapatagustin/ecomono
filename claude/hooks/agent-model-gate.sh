#!/usr/bin/env bash
# PreToolUse gate on the Agent tool: refuse a delegation to a built-in agent
# type that does not name a model.
#
# An Agent call without `model` inherits the parent's. Agents defined in
# claude/agents/ are fine — all of them carry `model:` in frontmatter, which wins when
# the parameter is absent. The built-in types have no file to put the field in,
# so from an Opus main loop they run file search on Opus, and from a Haiku one
# they run design work on Haiku. Both directions were measured; see
# docs/DESIGN.md "Model tier is 5x, not 60x".
#
# Three things would have to hold for a prompt rule to cover this and none do:
# the delegation rule in CLAUDE.md names an agent but no model; the
# `default | sonnet` row lives in agent-skills/ecomono-sdd-shared/sdd-orchestrator.md, which is
# loaded only when an SDD cycle starts, so it is unreachable for exactly the
# non-SDD delegations that need it; and a default in a lazily-loaded file is not
# a default.
#
# Payload verified at claude-code 2.1.220 by registering a capture hook through
# `claude -p --settings`: PreToolUse fires on tool_name "Agent" and tool_input
# carries `model` when passed and omits the key when not.
#
# The type is resolved against the project and user agents directories first:
# a definition carrying `model:` passes, a definition missing it is gated the
# same as a built-in. The manual list below only decides types with no file.
#
# ecomono: `fork` is excluded on purpose — forks always inherit the parent model
# and ignore the parameter, so demanding one there is unsatisfiable. A type with
# no definition on disk and not in the list passes, which keeps a plugin agent
# (whose file lives inside its plugin, unresolvable from here) from being
# blocked. Upgrade path: also resolve installed plugin agent directories.

set -uo pipefail

# Fail open. A gate that errors must not block every delegation in the session.
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0

model=$(printf '%s' "$payload" | jq -r '.tool_input.model // empty' 2>/dev/null) || exit 0
[ -n "$model" ] && exit 0

# An absent subagent_type means general-purpose, which is itself a built-in.
agent=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type // "general-purpose"' 2>/dev/null) || exit 0
# jq's `//` only fires on null/absent, not on an empty string — an explicit
# subagent_type:"" must default the same way an absent one does.
[ -z "$agent" ] && agent=general-purpose

# fork always inherits the parent model and ignores the parameter, so it is
# excluded before on-disk resolution — a model-less fork.md must not deny it.
[ "$agent" = fork ] && exit 0

# A definition on disk is authoritative: its frontmatter model wins when present,
# and a definition without one inherits exactly like a built-in does.
# ecomono: subagent_type is untrusted input interpolated into a path below; skip
# disk resolution for anything shaped like a path (contains / or starts with .)
# so it cannot traverse out of the agents directory. It falls through to the
# manual list, which won't recognize it either, so it passes like any unknown type.
defined=""
case "$agent" in
  */*|.*) ;;
  *)
    for dir in "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/agents" "$HOME/.claude/agents"; do
      f="$dir/$agent.md"
      [ -f "$f" ] || continue
      # Frontmatter only — the region between the first two `---` lines — so a
      # body example line starting "model:" can't false-pass the check. A file
      # with only an opening `---` (e.g. a truncated write) has no closing
      # delimiter, so n never reaches 2 and END withholds buf — no frontmatter
      # is extracted, and a body "model:" line can't false-pass either.
      # Strip CR first — a CRLF file has "---\r" lines that never match
      # /^---$/, which would false-deny every CRLF frontmatter.
      if tr -d '\r' < "$f" | awk '/^---$/{n++; next} n==1{buf=buf $0 "\n"} END{if(n>=2) printf "%s", buf}' | grep -q '^model:'; then
        exit 0
      fi
      defined=$f
      break
    done
    ;;
esac

if [ -z "$defined" ]; then
  case "$agent" in
    Explore|Plan|general-purpose|claude|claude-code-guide|statusline-setup) ;;
    *) exit 0 ;;
  esac
  origin="a built-in agent type with no frontmatter"
else
  origin="defined at $defined without a \`model:\` line"
fi

read -r -d '' reason <<EOF || true
This delegates to '$agent', $origin, so omitting \`model\`
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
