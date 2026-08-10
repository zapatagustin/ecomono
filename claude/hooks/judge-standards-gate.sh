#!/usr/bin/env bash
# PreToolUse gate on the Agent tool: refuse to launch an `ecomono-judgment` sub-agent whose
# prompt carries no populated standards block.
#
# `ecomono-judgment`'s hard rule is that judges and the fix agent review against the SAME
# standards, named as exact file paths. Over two judgments in one session — eight judge runs and
# two fix runs — every sub-agent reported `Skill Resolution: none`, because the delegator never
# built the block. Every artifact was correct: the registry existed, the resolver gave four
# followable steps, both prompt templates carried the placeholder, and the sub-agents reported
# the omission accurately. Only the action was missing, and nothing observed its absence — the
# report is a trailing field, and a delegator reading its own omission can keep going.
#
# THE DESIGN RECORD CLAIMED THIS COULD NOT BE CHECKED, and that claim was wrong. A judge went
# looking and found the precedent already shipped: `agent-model-gate.sh` is a PreToolUse hook on
# this same `Agent` matcher that reads `.tool_input.model` and denies. Its own test passes
# `"prompt":"find X"` inside `tool_input`, which is the proof that the prompt is in the payload and
# inspectable BEFORE the sub-agent runs. Asserting a boundary without checking whether the repo
# already had the mechanism is the same defect as any other prose that outruns its code, and it
# had been sitting one section above a hook that disproved it.
#
# Denying beats self-reporting for one reason: a report arrives after the work is paid for, and it
# can be read past. A denial cannot be forgotten.
#
# WHAT IT CHECKS is three byte-level questions, deliberately, never a judgment about content:
#   1. Is there a `## Skills to load before work` heading in the prompt?
#   2. Does the section under it hold a non-blank line before the next `## ` heading?
#   3. Is that line still the unfilled template — a line whose first character is `{`?
# Any of those failing is a refusal. The third exists because the template's placeholder text
# NAMES REAL REPOSITORY PATHS as examples, so an unfilled block reaching a sub-agent does not read
# as empty: it reads as content, and a sub-agent could report `paths-injected` for having received
# a placeholder. That would turn a correct `none` into a false confirmation — worse than the bug
# this gate exists for. A judge caught the shape before it shipped.
#
# ecomono: THREE THINGS THIS CANNOT SEE, and they are boundaries rather than a backlog.
#   - Whether the paths are real, or say anything about the code. That is a claim about content.
#   - Whether the judges and the fix agent received the SAME block. The hook sees one `Agent` call
#     at a time and holds no state across them, so symmetry is out of reach here. What covers the
#     static half of symmetry is `check-judge-twins.sh`; the per-round half remains the
#     coordinator's job, reported rather than enforced.
#   - Any launch that is not one of the three named sub-agents. A judgment run through some other
#     agent type is ungated, by construction.
# Upgrade path for the second one, and the only one that changes it: a PostToolUse audit that
# records each launch's block and compares them within a round.
#
# ecomono: fails OPEN on a missing `jq`, an unparseable payload, or a payload with no
# `subagent_type` — same convention as its sibling gates and for the same reason. A gate that
# fails closed on a malformed hook payload stops the operator from launching the review that would
# fix the hook. It costs nothing real: anything that can empty PATH can also edit the prompt.

set -uo pipefail

# Mutation-measured redundant: every `jq` call below is `$(... | jq ...) || exit 0`, so a missing
# `jq` already fails open and deleting this line flips no fixture. Kept anyway, because the four
# sibling gates all open with it and one that does not reads as an oversight rather than as a
# measurement. Stated so the next reader does not have to re-derive it.
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0
[ -n "$payload" ] || exit 0

agent=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || exit 0
case "$agent" in
  ecomono-judge-a|ecomono-judge-b|ecomono-judge-fix) ;;
  *) exit 0 ;;
esac

prompt=$(printf '%s' "$payload" | jq -r '.tool_input.prompt // empty' 2>/dev/null) || exit 0
[ -n "$prompt" ] || exit 0

# The section under the heading, up to the next `## ` heading. Line-based on purpose: awk sees
# the same bytes the sub-agent will read, and no rule here depends on what any line means.
block=$(printf '%s\n' "$prompt" | awk '
  /^## Skills to load before work[[:space:]]*$/ { f=1; next }
  f && /^## / { exit }
  f
')

why=""
if ! printf '%s\n' "$prompt" | grep -qE '^## Skills to load before work[[:space:]]*$'; then
  why="the prompt has no \`## Skills to load before work\` heading at all"
elif [ -z "$(printf '%s' "$block" | tr -d '[:space:]')" ]; then
  why="the \`## Skills to load before work\` section is empty"
elif printf '%s\n' "$block" | grep -qE '^[[:space:]]*\{'; then
  why="the \`## Skills to load before work\` section still holds the unfilled template — a line beginning with \`{\`"
fi

[ -n "$why" ] || exit 0

read -r -d '' reason <<EOF || true
Refusing to launch \`$agent\`: $why.

\`ecomono-judgment\`'s rule is that the judges and the fix agent review against the SAME
standards, named as exact file paths and never as summaries — a judge applying a different bar
than the fixer produces churn. A sub-agent launched without that block invents its own bar, and
reports \`Skill Resolution: none\` after the round has already been paid for.

Build the block before relaunching. Exact paths, one block reused for every sub-agent in the
round:

  ## Skills to load before work
  - /abs/path/to/the/standards/this/diff/is/measured/against
  - ...

Registry-resolved \`SKILL.md\` paths when the target is SDD-shaped work — a phase's own skill is
the contract being reviewed there. Otherwise the project's own rules, plus whichever design-record
sections bear on this diff. See agent-skills/ecomono-sdd-shared/skill-resolver.md.

This gate reads bytes, not meaning: it cannot tell whether the paths you name are the right ones,
and it cannot tell whether two sub-agents in the same round received the same block. Those stay
yours.
EOF

jq -nc --arg r "$reason" --arg m "⛔ Judge launch blocked — no standards block in the prompt for $agent." '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  },
  systemMessage: $m
}'
