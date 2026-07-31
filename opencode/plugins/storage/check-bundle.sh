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

# A byte comparison only means anything under the bun that built the bundle: another
# version re-emits the same sources with cosmetic differences, and calling that
# "stale" sends people to commit churn. But skipping outright would trade a false
# failure for a false pass — the forgot-to-rebuild bug this exists to catch would go
# unreported on every machine whose bun drifted. So fall back to the input
# fingerprint, which is bundler-independent, and still fails on real staleness.
#
# This runs before the node_modules block on purpose: the fingerprint needs neither
# installed deps nor a bundler run, so a read-only copy with a mismatched bun still
# gets a real check instead of the skip below.
if [ "$BUN_VERSION" != "$BUN_BUNDLE_VERSION" ]; then
  if [ ! -f "$BUNDLE_INPUTS" ]; then
    echo "FAIL: no $BUNDLE_INPUTS to check against, and bun $BUN_VERSION cannot" >&2
    echo "      byte-compare a bundle built with $BUN_BUNDLE_VERSION — run build-bundle.sh" >&2
    exit 1
  fi
  live="$(bundle_inputs_hash)" || exit 1
  if [ "$live" = "$(cat "$BUNDLE_INPUTS")" ]; then
    echo "✓ bundle: inputs unchanged since build (bun $BUN_VERSION ≠ $BUN_BUNDLE_VERSION, bytes not compared)"
    exit 0
  fi
  echo "FAIL: mcp-server.js is stale — its sources changed since it was built." >&2
  echo "      Run build-bundle.sh and commit the result." >&2
  exit 1
fi

# Bundling needs the MCP SDK resolved from opencode/node_modules. Try to install
# it rather than skipping on sight: "no node_modules" is also what a fresh clone
# looks like, and silently passing there would skip the one check guarding the
# bundle. Only a copy that genuinely cannot install — the read-only nix store —
# is allowed to skip.
# --frozen-lockfile for two reasons: a verify step must never write to the tree
# (a plain install rewrites bun.lock), and resolving `^` ranges freely would
# bundle a different SDK build than the committed one and report that as source
# staleness — which is exactly the false failure this check must not produce.
if [ ! -d ../../node_modules ] && ! "$BUN" install --cwd ../.. --frozen-lockfile >/dev/null 2>&1; then
  echo "skip: bundle check (cannot install locked deps — read-only copy?)"
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
