#!/usr/bin/env bash
# Fixtures for check-routing-drift.sh — bash test-routing-drift.sh
#
# Every case copies the real inputs into a throwaway tree with the same relative layout and
# mutates the copy; the real repo is never touched. A case passes only if the check fails AND
# prints a DRIFT: line naming the mismatch.

set -uo pipefail
cd "$(dirname "$0")"
repo=$PWD

fixture=$(mktemp -d) || exit 1
trap 'rm -rf "$fixture"' EXIT

orch=agent-skills/ecomono-sdd-shared/sdd-orchestrator.md
rt=claude/hooks/routing.json

reset() {
  rm -rf "$fixture"/*
  mkdir -p "$fixture/claude/hooks" "$fixture/claude/agents" "$fixture/$(dirname "$orch")"
  cp "$repo/$rt" "$fixture/$rt"
  cp "$repo"/claude/agents/*.md "$fixture/claude/agents/"
  cp "$repo/$orch" "$fixture/$orch"
  cp "$repo/check-routing-drift.sh" "$fixture/"
}

fail=0
t() { # t <expected pass|fail> <description> [DRIFT substring]
  local out rc got
  out=$(bash "$fixture/check-routing-drift.sh" 2>&1); rc=$?
  got=$([ $rc -eq 0 ] && echo pass || echo fail)
  if [ "$got" = "$1" ] && { [ -z "${3:-}" ] || grep -q "^DRIFT:.*$3" <<<"$out"; }; then
    echo "ok   $2"
  else
    echo "FAIL $2 — got $got, wanted $1 ${3:+with DRIFT: $3}"
    printf '     %s\n' "$out"
    fail=1
  fi
}

a=$fixture/claude/agents

reset;                                                                  t pass "baseline: the real tree agrees"
reset; sed -i 's/^model: sonnet/model: opus/' "$a/ecomono-sdd-apply.md"; t fail "wrong model" "ecomono-sdd-apply: frontmatter model is 'opus'"
reset; sed -i '/^effort:/d' "$a/ecomono-r1-risk.md";                    t fail "missing effort" "ecomono-r1-risk: frontmatter effort is 'absent'"
reset; sed -i 's/^effort: medium/&\nmaxTurns: 9/' "$a/ecomono-sdd-spec.md"; t fail "extra maxTurns" "ecomono-sdd-spec: frontmatter maxTurns is '9'"
reset; sed -i '/^omitClaudeMd:/d' "$a/ecomono-explore.md";              t fail "missing omitClaudeMd" "ecomono-explore: frontmatter omitClaudeMd is 'absent'"
reset; sed -i '/^effort:/d' "$a/ecomono-sdd-spec.md"; echo 'effort: medium' >> "$a/ecomono-sdd-spec.md"; t fail "key only in the body" "ecomono-sdd-spec: frontmatter effort is 'absent'"
reset; cp "$a/ecomono-sdd-spec.md" "$a/ecomono-sdd-new.md";             t fail "unknown agent" "ecomono-sdd-new is an agent file but not in"
reset; rm "$a/ecomono-r1-risk.md";                                      t fail "agent listed without a file" "ecomono-r1-risk is in .* agents but has no"
reset; sed -i 's/→ opus → fable/→ opus/' "$fixture/$orch";             t fail "ladder text changed" "ladder: .*does not contain"
reset; sed -i 's/^| `ecomono-judge-a` | sonnet | high/| `ecomono-judge-a` | sonnet | low/' "$fixture/$orch"; t fail "orchestrator row differs" "ecomono-judge-a: orchestrator table has 'sonnet low'"
reset; sed -i 's/^| `default` | sonnet | medium/| `default` | sonnet | low/' "$fixture/$orch"; t fail "default row differs" "default: orchestrator table has 'sonnet low'"
reset; sed -i '/^| `ecomono-r2-readability`/d' "$fixture/$orch";         t fail "orchestrator row missing" "ecomono-r2-readability: orchestrator table has 'rows=0'"
reset; sed -i '/^| `ecomono-judge-b`/p' "$fixture/$orch";               t fail "orchestrator row duplicated" "ecomono-judge-b: orchestrator table has .*rows=2"
reset; sed -i 's#^<!-- /ecomono:sdd-model-assignments -->#| `ecomono-ghost` | sonnet | low | x |\n&#' "$fixture/$orch"; t fail "orchestrator row for unknown agent" "ecomono-ghost: orchestrator table row for an agent not in"
reset; sed -i '/VERDICT: /d' "$a/ecomono-r3-reliability.md";           t fail "review agent without verdict line" "ecomono-r3-reliability: review agent lacks the VERDICT"
reset; sed -i '/VERDICT: /d' "$a/ecomono-sdd-verify.md";               t fail "verify without verdict line" "ecomono-sdd-verify: lacks the VERDICT"

[ $fail -eq 0 ] && echo "all routing-drift fixtures pass"
exit $fail
