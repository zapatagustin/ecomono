#!/usr/bin/env bash
# Run every omp extension test. Each test_*.ts is a plain assert script (no framework), the same shape as
# opencode/plugins/tests. fake-pi.ts, which every test file imports first, points XDG_CACHE_HOME, XDG_STATE_HOME,
# ECOMONO_DATA_DIR and ECOMONO_LEGACY_DB at a temp dir, so a run never touches the real home.
set -euo pipefail
cd "$(dirname "$0")"

# Sourced across directories on purpose: bun is often installed outside PATH and
# duplicating that fallback is how the two copies drift.
. ../../opencode/plugins/storage/_bun.sh

fail=0
for t in test_*.ts; do
  "$BUN" run "$t" || { echo "FAIL: $t" >&2; fail=1; }
done

exit "$fail"
