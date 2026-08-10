#!/usr/bin/env bash
# Runnable check for judge-standards-gate.sh. No framework: feeds PreToolUse payloads on stdin
# and asserts on the decision.
#
# The payload shape is the one the live harness sends on the `Agent` matcher, and it is not
# assumed here — `test-agent-model-gate.sh` captured it from a real `claude -p --settings` run,
# and this file reuses that shape rather than inventing a second one. `tool_input.prompt` being
# present in it is the whole premise of this gate.
#
# The allows carry as much weight as the denies. A gate that blocks a correctly-built launch stops
# the review that would fix the gate, so every shape of a legitimate block below is a case.

set -uo pipefail
gate="$(dirname "$0")/judge-standards-gate.sh"
fail=0

decision() { # decision <json> -> "allow" when the gate stays silent, else "deny:<reason>"
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
    echo "FAIL $1 — got: ${got:0:140}"
    fail=1
  fi
}

# p <subagent_type> <prompt> — the live payload shape, built with jq so no quoting in a prompt
# body can break the JSON. An earlier version used printf and a prompt containing a quote
# produced an unparseable payload, which the gate correctly failed open on: a green case proving
# nothing.
p() { jq -nc --arg a "$1" --arg t "$2" '{tool_name:"Agent",tool_input:{subagent_type:$a,prompt:$t}}'; }

FILLED='## Target
the diff

## Skills to load before work
- /home/surface/personal/ecomono/claude/CLAUDE.md
- /home/surface/personal/ecomono/docs/DESIGN.md

## Criteria
find problems'

UNFILLED='## Target
the diff

## Skills to load before work
{exact file paths, never summaries. Registry-resolved SKILL.md paths when the target is
SDD-shaped work; otherwise the project standards}

## Criteria
find problems'

MISSING='## Target
the diff

## Criteria
find problems'

EMPTY='## Target
the diff

## Skills to load before work

## Criteria
find problems'

echo "-- the three judgment sub-agents are gated"
for a in ecomono-judge-a ecomono-judge-b ecomono-judge-fix; do
  check "$a with a filled block launches"   "$(p "$a" "$FILLED")"   '^allow$'
  check "$a with no block is refused"       "$(p "$a" "$MISSING")"  '^deny:.*no .*heading'
  check "$a with an empty section refused"  "$(p "$a" "$EMPTY")"    '^deny:.*empty'
done

echo
echo "-- the unfilled template is the case that matters most"
# The placeholder NAMES REAL PATHS, so an unfilled block does not read as empty to a sub-agent —
# it reads as content, and the sub-agent would report `paths-injected` for having received a
# template. Delete the `^[[:space:]]*\{` branch in the gate and this is the case that flips, while
# the empty-section case above keeps passing and hides it.
check "an unfilled placeholder is refused" "$(p ecomono-judge-a "$UNFILLED")" '^deny:.*unfilled'
check "and the refusal says how to build it" "$(p ecomono-judge-a "$UNFILLED")" 'Registry-resolved'

echo
echo "-- everything else launches untouched"
# The gate exists for three named sub-agents. Anything else is out of scope by construction, and
# a gate that reached wider would block ordinary delegation for a rule that does not apply to it.
check "another agent type with no block"   "$(p ecomono-explore "$MISSING")"   '^allow$'
check "a built-in agent with no block"     "$(p Explore "$MISSING")"           '^allow$'
check "the fix agent's own sibling name"   "$(p ecomono-judge-fixer "$MISSING")" '^allow$'

echo
echo "-- a block that is populated in a shape nobody predicted still launches"
# The gate asks whether the section holds a non-blank line that is not the template, and nothing
# more. Prose instead of a bullet list, one path, a trailing comment: all legitimate.
check "a single path, no list marker" \
  "$(p ecomono-judge-b '## Skills to load before work
/abs/path/CLAUDE.md')" '^allow$'
check "prose naming the files" \
  "$(p ecomono-judge-b '## Skills to load before work
Read CLAUDE.md and DESIGN.md before starting.')" '^allow$'
# A brace that is not at the START of the line is not the template.
check "a path containing a brace" \
  "$(p ecomono-judge-b '## Skills to load before work
- /abs/path/{a,b}/CLAUDE.md')" '^allow$'

echo
echo "-- the section ends at the next heading, not at EOF"
# Without the `f && /^## / { exit }` bound the section would swallow the rest of the prompt, and a
# prompt whose LATER sections are non-blank would pass with its own block empty. Delete that bound
# and this case flips.
check "an empty block followed by prose is still empty" \
  "$(p ecomono-judge-a '## Skills to load before work

## Criteria
- correctness
- edge cases')" '^deny:.*empty'

echo
echo "-- fails open"
out=$(printf 'not json' | "$gate") || true
[ -z "$out" ] && echo "ok   malformed payload fails open" || { echo "FAIL malformed payload blocked"; fail=1; }

out=$(jq -nc '{tool_name:"Agent",tool_input:{}}' | "$gate") || true
[ -z "$out" ] && echo "ok   no subagent_type fails open" || { echo "FAIL missing subagent_type blocked"; fail=1; }

out=$(jq -nc '{tool_name:"Agent",tool_input:{subagent_type:"ecomono-judge-a"}}' | "$gate") || true
[ -z "$out" ] && echo "ok   no prompt fails open" || { echo "FAIL missing prompt blocked"; fail=1; }

# jq absent. Emptying PATH would short-circuit on the jq check itself, which is the point here:
# that IS the guard under test, so the fixture must reach it with nothing else missing first.
sh_bin=$(command -v bash)
nojq=$(mktemp -d)
for b in cat tr grep awk printf head; do ln -s "$(command -v "$b")" "$nojq/$b" 2>/dev/null; done
out=$(printf '%s' "$(p ecomono-judge-a "$MISSING")" | PATH="$nojq" "$sh_bin" "$gate") || true
[ -z "$(PATH="$nojq" command -v jq)" ] && echo "ok   the no-jq fixture is the state it claims" \
  || { echo "FAIL fixture PATH still has jq"; fail=1; }
rm -rf "$nojq"
[ -z "$out" ] && echo "ok   missing jq fails open" || { echo "FAIL missing jq blocked"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then echo "judge-standards-gate: all cases passed"; fi
exit $fail
