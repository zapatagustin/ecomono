#!/usr/bin/env bash
# Fail if mcp-server.js is out of date with the sources it was built from.
#
# The bundle is committed, and vendored into nixos-config on top of that, so a
# forgotten build-bundle.sh ships stale code to Claude Code in two places while
# every test still passes against the .ts sources. Rebuilds to a temp file and
# compares bytes; nothing in the repo is written.
set -euo pipefail
cd "$(dirname "$0")"
. ./_bun.sh

# Bundling needs the MCP SDK resolved from opencode/node_modules. The nix-store
# copy is read-only and has none, so there it is a skip, not a failure.
if [ ! -d ../../node_modules ]; then
  echo "skip: bundle check (no node_modules — read-only copy?)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$BUN" build mcp-server.ts --target bun --external bun:sqlite --outfile "$tmp/mcp-server.js" >/dev/null

if cmp -s "$tmp/mcp-server.js" mcp-server.js; then
  echo "✓ bundle: mcp-server.js matches its sources"
else
  echo "FAIL: mcp-server.js is stale — run build-bundle.sh and commit the result" >&2
  exit 1
fi
