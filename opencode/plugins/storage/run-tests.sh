#!/usr/bin/env bash
# Run every storage test. Each test_*.ts is a plain assert script (no framework),
# so `bun test` does not discover them — it only matches *.test.ts.
set -euo pipefail
cd "$(dirname "$0")"

. ./_bun.sh

fail=0
for t in test_*.ts; do
  "$BUN" run "$t" || { echo "FAIL: $t" >&2; fail=1; }
done

# test_mcp.ts exercises the committed bundle, which only proves anything if the
# bundle still matches its sources.
./check-bundle.sh || fail=1
# ...and check-bundle.sh's other path is unreachable on the machine that built it.
./test-bundle-fallback.sh || fail=1

exit "$fail"
