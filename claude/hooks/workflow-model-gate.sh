#!/usr/bin/env bash
# PreToolUse gate on the Workflow tool: a script whose agent() calls never name
# a model runs every one of them at the main loop's tier. Same leak
# agent-model-gate.sh closes for the Agent tool, multiplied by the fan-out —
# a 15-agent sweep inheriting the top tier costs more than the whole session
# around it. The PreToolUse "Agent" matcher never sees these spawns: they are
# internal to the Workflow run, so this gate reads the script instead.
#
# Payload evidence is two-tier. Live-verified at claude-code 2.1.234, via a dump
# hook on a real `claude -p` run: PreToolUse fires with tool_name "Workflow" and
# tool_input carrying `script` for an inline invocation (tool_input had exactly
# one key: "script"). The scriptPath and name field shapes were NOT captured live
# — for those the evidence remains strings in the installed claude-code binary
# ("Must provide script, name, or scriptPath") plus the harness's tool schema.
# See docs/DESIGN.md for detail and the upgrade path.
#
# ecomono: the check requires `model` in OPTION-KEY POSITION — preceded by `{`
# or `,` (matches `{model: 'haiku'}`, multi-line option objects,
# `phases: [{title: 'X', model: 'opus'}]`, and the ES2015 shorthand `{model}`),
# not a bare substring or bare model-shape match — either of those
# false-passed on prose like "the pricing model:" or "business model:
# freemium tier" with zero actual model options. The `agent(` trigger and the
# `// model: inherit` escape hatch are both anchored (non-identifier boundary
# before `agent`; hatch must be a whole-line comment) so neither can be smuggled
# inside a string literal or prose. Ceilings, none closed by this gate:
# (1) a `{`/`,`-preceded `model:` INSIDE A STRING LITERAL (e.g. an embedded
# JSON example `{"model": ...}` in a prompt) still false-passes — this is a
# text scan, not a parser; the shorthand match widens this slightly (a string
# containing "…, model, …" can also false-pass); (2) prose like "notify the
# agent(s)" still false-denies — safe direction, a deny is recoverable by
# retrying with model; (3) still per-script, not per-call: parsing JS argument
# objects with grep lies, so a script that sets model on one agent() call and
# omits it on another passes. Upgrade path for all three: per-call scan of
# agent( option objects, or a linter run on the persisted script file.

set -uo pipefail

# Fail open. A gate that errors must not block every workflow in the session.
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0

# Cap the inline script too — same hang rationale as the scriptPath/name reads
# below: an unbounded read on a huge inline payload would hang the hook.
script=$(printf '%s' "$payload" | jq -r '.tool_input.script // empty' 2>/dev/null | head -c 262144) || exit 0
if [ -z "$script" ]; then
  path=$(printf '%s' "$payload" | jq -r '.tool_input.scriptPath // empty' 2>/dev/null) || exit 0
  # Cap the read — an unbounded cat on a huge or non-regular file would hang
  # the hook, and a hung PreToolUse gate blocks the whole session.
  [ -n "$path" ] && [ -f "$path" ] && script=$(head -c 262144 "$path" 2>/dev/null)
fi

if [ -z "$script" ]; then
  name=$(printf '%s' "$payload" | jq -r '.tool_input.name // empty' 2>/dev/null) || exit 0
  # ecomono: a project-defined named workflow resolves to
  # .claude/workflows/<name>.js (per claude-code's own binary strings and its
  # resolution against CLAUDE_PROJECT_DIR/$PWD). name is untrusted; skip
  # resolution for anything shaped like a path (contains / or starts with .)
  # so it cannot traverse out of the workflows directory.
  case "$name" in
    */*|.*) ;;
    *)
      if [ -n "$name" ]; then
        wf="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/workflows/$name.js"
        # Cap the read — same hang risk as the scriptPath read above.
        [ -f "$wf" ] && script=$(head -c 262144 "$wf" 2>/dev/null)
      fi
      ;;
  esac
fi

# A built-in named workflow has no file on disk to read — nothing to scan.
# Ceiling: those stay unscanned; upgrade path is a manifest of built-ins to
# tell "no file" apart from "not found", but the gate can't reach it from here.
[ -z "$script" ] && exit 0

# The escape hatch must be a whole-line comment — anchored so it can't ride
# along as a substring inside a string literal or prose (e.g. a log message
# that happens to contain the phrase). Checked on the raw script, before any
# structural normalization.
printf '%s' "$script" | grep -Eq '^[[:space:]]*//[[:space:]]*model:[[:space:]]*inherit[[:space:]]*$' && exit 0

# Flatten newlines/tabs to spaces so a multi-line option object (`{\n  model:
# 'haiku'\n}`) reads as one line for grep — this also covers an `agent\n(`
# split across lines.
flat=$(printf '%s' "$script" | tr '\n\r\t' '   ')

# Boundary before `agent` (start of string or a non-identifier char) so
# `subagent(`/`delegateAgent(` don't false-trigger; optional whitespace before
# `(` catches `agent (` and the `agent\n(` case the flatten turns into a space.
# Ceiling: prose like "notify the agent(s)" in a comment or string still
# false-denies — safe direction, a deny is recoverable by retrying with model.
printf '%s' "$flat" | grep -Eq '(^|[^A-Za-z0-9_$])agent[[:space:]]*\(' || exit 0
# Also accepts ES2015 shorthand (`{model}`, `{model, other}`) — `model` in key
# position followed by `:`, `,`, or `}`. Ceiling: slightly widens the
# string-literal false-pass surface, e.g. a list "…, model, …" inside a string.
printf '%s' "$flat" | grep -Eq "[{,][[:space:]]*['\"]?model['\"]?[[:space:]]*(:|,|})" && exit 0

read -r -d '' reason <<'EOF' || true
This workflow script spawns agents with agent() and never mentions `model`, so every
spawn inherits the main loop's tier — running the whole fan-out at the most expensive
model available.

Retry with `model` set in the agent() options, per call, picked by what that stage has
to do: 'haiku' for mechanical lookups and extraction, 'sonnet' for scouting and
summarising (the usual default), 'opus' only for the hardest verify/judge stages.

If the whole workflow genuinely needs the main loop's tier, say so in the script with a
`// model: inherit` comment on its own line and it will pass.
EOF

jq -nc --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  }
}'
