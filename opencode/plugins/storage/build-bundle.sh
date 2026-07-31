#!/usr/bin/env bash
# Regenerate the self-contained MCP server bundle (mcp-server.js) from source.
# Run this after changing any storage/*.ts. The bundle is committed so NixOS can
# run it offline from the store with no node_modules — bun:sqlite stays external
# (it's a bun builtin, provided at runtime).
set -euo pipefail
cd "$(dirname "$0")"

. ./_bun.sh

"$BUN" install --cwd ../.. >/dev/null 2>&1 || (cd ../.. && "$BUN" install)
"$BUN" build mcp-server.ts --target bun --external bun:sqlite --outfile mcp-server.js
# Into a variable first: `> "$BUNDLE_INPUTS"` truncates before the function runs, so
# a failing hash would leave an empty fingerprint behind on its way out.
inputs="$(bundle_inputs_hash)" || exit 1
printf '%s\n' "$inputs" > "$BUNDLE_INPUTS"
echo "built mcp-server.js"

if [ "$BUN_VERSION" != "$BUN_BUNDLE_VERSION" ]; then
  echo "note: built with bun $BUN_VERSION, not the pinned $BUN_BUNDLE_VERSION." >&2
  echo "      Expect cosmetic diff noise. Update BUN_BUNDLE_VERSION in _bun.sh in" >&2
  echo "      this same commit, so check-bundle.sh compares bytes again instead of" >&2
  echo "      falling back to the input fingerprint." >&2
fi
