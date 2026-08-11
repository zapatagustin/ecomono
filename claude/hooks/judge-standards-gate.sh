#!/usr/bin/env bash
# PreToolUse gate on the Agent tool: refuse to launch an `ecomono-judgment` sub-agent whose
# prompt carries no `## Skills to load before work` heading.
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
# WHAT IT CHECKS is one byte-level question, deliberately, and it is the survivor of three
# designs: is the line `## Skills to load before work` present in the prompt? Absent → deny.
# Present → allow, whatever sits under it.
#
# ecomono: WHAT THIS CANNOT SEE is everything except that heading, and the list is a boundary
# rather than a backlog — two parsers that reached further died here in two review rounds:
#   - Whether the section under the heading is FILLED. A first-occurrence parser allowed a decoy
#     above an empty real section; an all-occurrences parser allowed a `###` sub-heading with no
#     paths and a sole occurrence inside a fenced code block. Four escapes, each found in the fix
#     for the previous one — the curve this repo buried two other checks on. "Does this prompt
#     carry real standards" is a question about meaning. What covers content is the sub-agent's
#     own `Skill Resolution` report, which works precisely because the templates no longer put
#     real-looking paths in the unfilled placeholder: an empty or placeholder block under a real
#     heading yields an honest `none`, named beside the verdict per the skill's gates table.
#   - Whether the paths are real, or say anything about the code. Content again.
#   - Whether the judges and the fix agent received the SAME block. The hook sees one `Agent`
#     call at a time and holds no state; the static half of symmetry is `check-judge-twins.sh`,
#     the per-round half stays the coordinator's job. Upgrade path, and the only one that changes
#     it: a PostToolUse audit that records each launch's block and compares within a round.
#   - Any launch that is not one of the three named sub-agents, on any harness but Claude Code.
#     opencode launches the same agents through `task` with no ported gate.
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
# Mutation-measured redundant, same as the `jq` guard above: an empty payload makes the first `jq`
# call fail and `|| exit 0` already opens the gate. Kept for the same reason, and labelled because
# a judge pointed out that one redundant guard carried its note and the other did not.
[ -n "$payload" ] || exit 0

agent=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || exit 0
case "$agent" in
  ecomono-judge-a|ecomono-judge-b|ecomono-judge-fix) ;;
  *) exit 0 ;;
esac

prompt=$(printf '%s' "$payload" | jq -r '.tool_input.prompt // empty' 2>/dev/null) || exit 0
[ -n "$prompt" ] || exit 0

# ONE question, and it is the only one these bytes can answer: does the prompt contain the
# heading line. Nothing about what sits under it.
#
# This is the third shape of this check in three review rounds, and the arc is the argument.
# The first version took the FIRST occurrence of the heading and judged the section under it;
# two judges broke it from opposite directions in one round (a filled decoy above a real empty
# section was ALLOWED; a quoted example above a real filled block was REFUSED). The second
# version judged EVERY occurrence and required all of them populated; the next round produced
# two more false allows without contrivance — a `###` sub-heading with no paths under it reads
# as content, and the sole occurrence sitting inside a fenced code block reads as a real block.
# Four escapes in two rounds, each found in the fix for the previous one, is the exact curve on
# which this repo buried its key-learnings check and the judgment skill's unrelated-work guard —
# both died in working trees under review and never reached git history, so the post-mortems in
# docs/DESIGN.md are where to verify them, not `git log`. The root is that
# "does this prompt carry real standards" is a question about MEANING, and every parser here was
# an answer to it wearing syntactic clothes.
#
# So the parser is deleted, not fixed a third time. What remains is the one check that cannot be
# wrong about structure because it reads none: the heading is present, or it is not. That catches
# exactly the failure that happened ten times — a delegator who never built a block at all — and
# claims nothing else.
#
# A here-string, NOT a pipe, and the difference is a confirmed false deny. Under `pipefail`,
# `printf "$prompt" | grep -q` fails on any compliant prompt whose bytes after the match overflow
# the pipe buffer: grep -q exits at the match, printf takes SIGPIPE writing the rest, and pipefail
# reports the pipeline as 141 even though grep succeeded. Both judges reproduced it independently
# at ~128KB — and a fix agent's prompt carrying a findings table plus context crosses that
# routinely, so the gate was refusing exactly the large rounds it matters most for. A here-string
# has no writer process to kill. The large-prompt fixture pins it.
grep -qE '^## Skills to load before work[[:space:]]*$' <<<"$prompt" && exit 0

read -r -d '' reason <<EOF || true
Refusing to launch \`$agent\`: the prompt has no \`## Skills to load before work\` heading.

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

This gate checks that the heading EXISTS and nothing more. It does not read what sits under it —
whether the section is filled, whether the paths are real, whether two sub-agents got the same
block. Two parsers that tried died of four bypasses in two review rounds; the sub-agent's own
\`Skill Resolution\` report is what covers the content, and it can, because the templates no
longer put real-looking paths in an unfilled placeholder.
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
