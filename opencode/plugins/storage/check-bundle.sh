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

# Two different conditions rule out the byte comparison — a bun whose bundler emits
# different bytes for the same sources, and a copy that cannot resolve deps to rebuild
# with. Neither is a reason to check nothing: the fingerprint is bundler-independent and
# needs no deps, so it still answers the question this script exists to ask. One
# implementation, so the branch that is easy to exercise and the branch that is not
# cannot drift apart.
fingerprint_verdict() { # fingerprint_verdict <why bytes are not being compared>
  local why="$1" live
  if [ ! -f "$BUNDLE_INPUTS" ]; then
    echo "FAIL: no $BUNDLE_INPUTS to check against, and bytes cannot be compared ($why)" >&2
    echo "      — run build-bundle.sh" >&2
    return 1
  fi
  live="$(bundle_inputs_hash)" || return 1
  if [ "$live" = "$(cat "$BUNDLE_INPUTS")" ]; then
    echo "✓ bundle: inputs unchanged since build ($why, bytes not compared)"
    return 0
  fi
  echo "FAIL: mcp-server.js is stale — its sources changed since it was built." >&2
  echo "      Run build-bundle.sh and commit the result." >&2
  return 1
}

# A byte comparison only means anything under the bun that built the bundle: another
# version re-emits the same sources with cosmetic differences, and calling that "stale"
# sends people to commit churn.
#
# This runs before the node_modules block on purpose: the fingerprint needs neither
# installed deps nor a bundler run, so a read-only copy with a mismatched bun still gets
# a real check rather than paying for an install it cannot use.
if [ "$BUN_VERSION" != "$BUN_BUNDLE_VERSION" ]; then
  fingerprint_verdict "bun $BUN_VERSION ≠ $BUN_BUNDLE_VERSION"
  exit
fi

# Bundling needs the MCP SDK resolved from opencode/node_modules. Try to install
# it rather than skipping on sight: "no node_modules" is also what a fresh clone
# looks like, and silently passing there would skip the one check guarding the
# bundle.
# --frozen-lockfile for two reasons: a verify step must never write to the tree
# (a plain install rewrites bun.lock), and resolving `^` ranges freely would
# bundle a different SDK build than the committed one and report that as source
# staleness — which is exactly the false failure this check must not produce.
if [ ! -d ../../node_modules ] && ! "$BUN" install --cwd ../.. --frozen-lockfile >/dev/null 2>&1; then
  if [ -f "$BUNDLE_INPUTS" ]; then
    fingerprint_verdict "deps unavailable"
    exit
  fi
  echo "skip: bundle check (cannot install locked deps, and no $BUNDLE_INPUTS to fall back on)"
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
