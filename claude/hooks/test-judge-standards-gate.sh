#!/usr/bin/env bash
# Runnable check for judge-standards-gate.sh. No framework: feeds PreToolUse payloads on stdin
# and asserts on the decision.
#
# The payload shape is the one the live harness sends on the `Agent` matcher, and it is not
# assumed here — `test-agent-model-gate.sh` captured it from a real `claude -p --settings` run,
# and this file reuses that shape rather than inventing a second one. `tool_input.prompt` being
# present in it is the whole premise of this gate.
#
# The gate asks ONE question: is the heading present. Most cases below therefore assert ALLOW,
# and each of those is a CEILING pinned on purpose, not a behaviour anyone is proud of — two
# parsers that reached further died of four bypasses in two review rounds, and every shape that
# broke them is kept here as an allow so the boundary is measured rather than remembered.

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

MISSING='## Target
the diff

## Criteria
find problems'

echo "-- the one question: the heading is present, or it is not"
for a in ecomono-judge-a ecomono-judge-b ecomono-judge-fix; do
  check "$a with the heading launches"      "$(p "$a" "$FILLED")"  '^allow$'
  check "$a without the heading is refused" "$(p "$a" "$MISSING")" '^deny:.*no .*heading'
done
check "the refusal says how to build the block" "$(p ecomono-judge-a "$MISSING")" 'Registry-resolved'
check "and says presence is all it checked"     "$(p ecomono-judge-a "$MISSING")" 'heading EXISTS and nothing more'

echo
echo "-- everything else launches untouched"
# The gate exists for three named sub-agents. Anything else is out of scope by construction, and
# a gate that reached wider would block ordinary delegation for a rule that does not apply to it.
check "another agent type with no block"   "$(p ecomono-explore "$MISSING")"     '^allow$'
check "a built-in agent with no block"     "$(p Explore "$MISSING")"             '^allow$'
check "the fix agent's own sibling name"   "$(p ecomono-judge-fixer "$MISSING")" '^allow$'

echo
echo "-- the ceiling, pinned: everything under the heading is out of reach, by decision"
# Every case below ALLOWS, and every one of them defeated a parser that tried to refuse it. They
# are asserted so the boundary flips loudly the day someone reaches past it again — and so the
# next reader inherits the measured graveyard instead of re-walking it. What covers these is the
# sub-agent's own `Skill Resolution` report: an empty or placeholder block under a real heading
# yields an honest `none`, which the skill's gates table treats as a setup defect.
check "an empty section under the heading" \
  "$(p ecomono-judge-a '## Skills to load before work

## Criteria
- x')" '^allow$'
check "the unfilled template under the heading" \
  "$(p ecomono-judge-a '## Skills to load before work
{exact file paths, never summaries}

## Criteria
- x')" '^allow$'
# Killed parser 1 (first-occurrence-wins): the decoy was judged and the real empty section never
# looked at. Under presence-only there is nothing to choose between.
check "a filled decoy above an empty real section" \
  "$(p ecomono-judge-a 'Prior round used:

## Skills to load before work
- /abs/path/CLAUDE.md

This round:

## Skills to load before work

## Criteria
- x')" '^allow$'
# Killed parser 2 (all-occurrences): a ### sub-heading is a non-blank line that reads as content,
# so a block holding zero paths passed as populated.
check "a ### sub-heading and no paths at all" \
  "$(p ecomono-judge-a '## Skills to load before work
### Registry-resolved

### Project standards

## Criteria
- x')" '^allow$'
# Killed parser 2 as well: the sole occurrence sits inside a fenced example, and no line-based
# scan sees fences.
check "the sole heading inside a fenced example" \
  "$(p ecomono-judge-a 'Example format:
```
## Skills to load before work
- /abs/path/CLAUDE.md
```
Proceed with the review.')" '^allow$'
# The inverse direction parser 1 also broke: a quoted placeholder above a real filled block was
# REFUSED — a false deny that blocks the review that would fix it. Presence-only launches it.
check "a quoted placeholder above a real filled block" \
  "$(p ecomono-judge-a 'For reference the template looks like:

## Skills to load before work
{exact file paths, never summaries}

Real block:

## Skills to load before work
- /abs/path/CLAUDE.md

## Criteria
- x')" '^allow$'

echo
echo "-- a large prompt must not change the answer"
# Both judges independently found the previous form — `printf "$prompt" | grep -q` under
# `pipefail` — denying a COMPLIANT prompt once the bytes after the match overflowed the pipe
# buffer (~128KB measured): grep -q exits at the match, printf takes SIGPIPE writing the rest,
# and pipefail surfaces the 141 over grep's success. A fix agent's prompt with a findings table
# plus context crosses that size routinely, so the gate refused exactly the rounds it matters
# most for. The here-string has no writer process to kill. Restore the pipeline form and the
# compliant case below is the one that flips.
#
# These payloads are built THROUGH FILES, never as arguments, and the first version of this block
# is why the rule is written down: Linux caps a single argv string at 128KB (MAX_ARG_STRLEN), so
# `jq --arg` with a 200KB prompt died with "argument list too long", the helper emitted nothing,
# the gate read an empty payload and failed open — and the compliant case printed `ok` with the
# gate never having seen a large prompt at all. A fixture that cannot fail, discovered because its
# sibling deny case failed. The length assertion below is the guard against that shape returning.
bigtmp=$(mktemp -d)
trap 'rm -rf "$bigtmp"' EXIT   # an interrupted run must not leak the 200KB fixtures
big_case() { # big_case <label> <prompt-file> <expected-regex>
  local payload="$bigtmp/payload.json" out got plen
  jq -nc --arg a ecomono-judge-a --rawfile t "$2" \
    '{tool_name:"Agent",tool_input:{subagent_type:$a,prompt:$t}}' > "$payload"
  plen=$(jq -r '.tool_input.prompt | length' "$payload" 2>/dev/null || echo 0)
  if [ "${plen:-0}" -lt 150000 ]; then
    echo "FAIL $1 — fixture broke: prompt reached the gate at ${plen:-0} bytes, not 200KB"
    fail=1; return
  fi
  out=$("$gate" < "$payload")
  [ -z "$out" ] && got=allow || got=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision')
  if printf '%s' "$got" | grep -Eq "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1 — got: $got"
    fail=1
  fi
}
head -c 200000 /dev/zero | tr '\0' 'x' > "$bigtmp/tail"
{ printf '## Skills to load before work\n- /abs/path/CLAUDE.md\n\n## Criteria\n'; cat "$bigtmp/tail"; } > "$bigtmp/with-heading"
{ printf '## Criteria\n'; cat "$bigtmp/tail"; } > "$bigtmp/without-heading"
big_case "the heading followed by 200KB still launches"  "$bigtmp/with-heading"    '^allow$'
big_case "no heading followed by 200KB is still refused" "$bigtmp/without-heading" '^deny$'
rm -rf "$bigtmp"

echo
echo "-- the heading match itself is exact"
# Presence of the HEADING LINE, not of the words. A heading at another level or with trailing
# text is not the templates' heading, and treating it as one would reopen the door to reading
# structure. These deny, which is the strict-but-consistent direction.
check "a ### version of the heading does not count" \
  "$(p ecomono-judge-a '### Skills to load before work
- /abs/path/CLAUDE.md')" '^deny:'
check "trailing text on the heading line does not count" \
  "$(p ecomono-judge-a '## Skills to load before work (SDD)
- /abs/path/CLAUDE.md')" '^deny:'
check "trailing whitespace on the heading line is fine" \
  "$(p ecomono-judge-a '## Skills to load before work
- /abs/path/CLAUDE.md')" '^allow$'

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
