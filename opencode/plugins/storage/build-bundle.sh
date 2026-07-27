#!/usr/bin/env bash
# Regenerate the self-contained MCP server bundle (mcp-server.js) from source.
# Run this after changing any storage/*.ts. The bundle is committed so NixOS can
# run it offline from the store with no node_modules — bun:sqlite stays external
# (it's a bun builtin, provided at runtime).
set -euo pipefail
cd "$(dirname "$0")"
bun install --cwd ../.. >/dev/null 2>&1 || (cd ../.. && bun install)
bun build mcp-server.ts --target bun --external bun:sqlite --outfile mcp-server.js
echo "built mcp-server.js"
