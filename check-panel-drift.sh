#!/usr/bin/env bash
# The Claude Code pane (claude/plugins/org-todo) draws the same git panel as the omp extension, with the same
# parsers. The plugin loader refuses imports from outside the plugin folder, so the parsers and the text
# sanitiser are copied into claude/plugins/org-todo/hooks/git.ts, between `// <<< copied: <file>` and
# `// >>> copied: <file>` lines. A fix to the omp original that never reaches the copy is a parser that reads
# git one way in one host and another way in the other, and nothing would say so.
#
# This compares each copied region with its source, byte for byte, and fails on any difference. The source
# side of each pair is cut by the anchors below: the line the region starts at, and the line it ends at
# (empty: the end of the file).
#
# ecomono: a copy kept honest by a diff, not a shared module. Upgrade path: once the plugin loader can import
# a package outside the plugin folder (or the panel's parsers move into a package both hosts install), import
# them in both places and delete this script and the copy.

set -uo pipefail
cd "$(dirname "$0")"

COPY=claude/plugins/org-todo/hooks/git.ts

# region <source file> -- the lines of $COPY between its markers for that file.
region() { awk -v f="$1" '$0 == "// >>> copied: " f { on = 0 } on { print } $0 == "// <<< copied: " f { on = 1 }' "$COPY"; }
# source <file> <first line prefix> [last line prefix] -- the source's lines from the first anchor to the
# last one (inclusive), or to the end of the file.
source_part() {
  awk -v a="$2" -v b="${3:-}" 'index($0, a) == 1 { on = 1 } on { print } on && b != "" && index($0, b) == 1 { exit }' "$1"
}

fail=0
# Compared through files, not `$(...)`: command substitution drops trailing newlines, and a change there is drift.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
check() { # check <source file> <first line prefix> [last line prefix]
  source_part "$@" > "$tmp/want"
  region "$1" > "$tmp/got"
  if [ ! -s "$tmp/want" ] || [ ! -s "$tmp/got" ]; then
    echo "DRIFT — $1: the copied region or its source anchor is missing (markers or anchors renamed?)"
    fail=1
  elif ! cmp -s "$tmp/want" "$tmp/got"; then
    echo "DRIFT — $COPY differs from $1:"
    diff "$tmp/want" "$tmp/got" | sed 's/^/  /'
    fail=1
  fi
}

check omp/extensions/ecomono/panel/git.ts '/** One working-tree entry'
check omp/extensions/ecomono/panel/text.ts '/** Control characters and escape sequences' 'export const plain'

[ $fail -eq 0 ] && echo "ok   panel parsers in the Claude pane match omp (2 regions)"
exit $fail
