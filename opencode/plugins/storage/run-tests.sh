#!/usr/bin/env bash
# Run every storage test. Each test_*.ts is a plain assert script (no framework),
# so `bun test` does not discover them — it only matches *.test.ts.
set -euo pipefail
cd "$(dirname "$0")"

# Same resolution as install.sh: bun is often installed outside PATH.
BUN="$(command -v bun 2>/dev/null || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; })"
[ -n "$BUN" ] || { echo "error: bun not found (curl -fsSL https://bun.sh/install | bash)" >&2; exit 1; }

fail=0
for t in test_*.ts; do
  "$BUN" run "$t" || { echo "FAIL: $t" >&2; fail=1; }
done
exit "$fail"
