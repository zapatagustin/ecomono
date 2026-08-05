#!/usr/bin/env bash
# Run every opencode plugin test. Each test_*.ts is a plain assert script (no
# framework), the same shape as the storage suite next door.
#
# They live in this subdirectory rather than beside the plugins because opencode
# auto-loads every .ts directly under `plugins/` — verified against `opencode debug
# info`, which lists cave-compress.ts and skill-registry.ts as loaded even though
# `opencode.json` names only memory.ts. A test file at that level would be loaded as
# a plugin on every session start. Subdirectories are not scanned (storage/ holds
# nine .ts files and none of them load), so this is the safe place for them.
set -euo pipefail
cd "$(dirname "$0")"

# Sourced across directories on purpose: bun is often installed outside PATH and
# duplicating that fallback is how the two copies drift.
. ../storage/_bun.sh

fail=0
for t in test_*.ts; do
  "$BUN" run "$t" || { echo "FAIL: $t" >&2; fail=1; }
done

exit "$fail"
