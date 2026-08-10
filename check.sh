#!/usr/bin/env bash
# Run every check in the repo — bash check.sh
#
# The suites were reachable but scattered: four entry points in three languages, and
# knowing all four was the only thing standing between a green tree and a broken one.
# Nothing here blocks a commit; wire this into CI or a pre-push hook if you want that.
set -uo pipefail
cd "$(dirname "$0")"

fail=0
run() { # run <label> <command...>
  echo "── $1"
  if "${@:2}"; then :; else echo "FAIL: $1" >&2; fail=1; fi
  echo
}

run "storage, memory and bundle"   bash opencode/plugins/storage/run-tests.sh
run "opencode plugins"             bash opencode/plugins/tests/run-tests.sh
run "installer linking primitives" bash lib/test-common.sh
run "agent model gate"             bash claude/hooks/test-agent-model-gate.sh
run "heavy skill gate"             bash claude/hooks/test-heavy-skill-gate.sh
run "secret access gate"           bash claude/hooks/test-secret-access-gate.sh
run "judge standards gate"         bash claude/hooks/test-judge-standards-gate.sh
run "review receipt gate"          bash claude/hooks/test-review-receipt-gate.sh
run "persona drift"                bash check-persona-drift.sh
run "archive gate drift"           bash check-gate-drift.sh
run "gate-drift fixtures"          bash test-gate-drift.sh
run "judge twins"                  bash check-judge-twins.sh
run "judge-twins fixtures"         bash test-judge-twins.sh
run "inline skill drift"           bash check-inline-skill-drift.sh
run "hook install drift"           bash check-hook-install-drift.sh
run "hook-install-drift fixtures"  bash test-hook-install-drift.sh
run "skill registry"               node claude/hooks/ecomono-skill-registry.js --selftest
run "compress secret guard"        python3 agent-skills/ecomono-compress/scripts/test_secrets.py
run "compress pipeline"            python3 agent-skills/ecomono-compress/scripts/test_compress.py
run "shell syntax"                 bash -n install.sh lib/common.sh lib/mcp.sh lib/test-common.sh check-persona-drift.sh check-gate-drift.sh test-gate-drift.sh check-judge-twins.sh test-judge-twins.sh check-inline-skill-drift.sh check-hook-install-drift.sh test-hook-install-drift.sh

if [ "$fail" -eq 0 ]; then echo "all checks pass"; else echo "some checks failed" >&2; fi
exit "$fail"
