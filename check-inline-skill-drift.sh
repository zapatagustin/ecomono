#!/usr/bin/env bash
# A skill marked `delegate_only: false` claims to run inline. Nothing enforced that
# claim against the agent registrations, and this repo already shipped the
# contradiction once: agent-skills/ecomono-sdd-onboard/SKILL.md said inline while
# claude/agents/ecomono-sdd-onboard.md and opencode/opencode.json both registered it
# as a delegated sub-agent — and no sub-agent in either harness holds an ask
# capability, so the delegated copy could never run the skill's own procedure.
#
# This is a two-artifact comparison, not a claim about what a sentence means: the
# set of skills declaring `delegate_only: false` against the set of agent names
# registered in claude/agents/*.md and opencode/opencode.json's `agent` block. Same
# shape as check-gate-drift.sh's title-presence checks — no reasoning about intent,
# just "does a same-named registration exist".
#
# ecomono: presence-only, like check-gate-drift.sh's SUBJECT HASH check — it does not
# read what either registration says, only that the name is absent. A skill could
# still declare delegate_only: false while some other file quotes its name in prose;
# that would pass here and would need a different check.
set -uo pipefail
cd "$(dirname "$0")"

fail=0

for skill in agent-skills/*/SKILL.md; do
  grep -qE '^\s*delegate_only:\s*false\s*$' "$skill" || continue
  name=$(basename "$(dirname "$skill")")

  agent="claude/agents/${name}.md"
  if [ -e "$agent" ]; then
    echo "DRIFT — $skill declares delegate_only: false, but $agent registers it as a delegated sub-agent" >&2
    fail=1
  fi

  if grep -qE "\"${name}\"[[:space:]]*:[[:space:]]*\{" opencode/opencode.json; then
    echo "DRIFT — $skill declares delegate_only: false, but opencode/opencode.json registers an agent entry named '$name'" >&2
    fail=1
  fi
done

[ $fail -eq 0 ] && echo "ok   no inline skill is registered as a delegated agent"
exit $fail
