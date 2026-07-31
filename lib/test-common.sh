#!/usr/bin/env bash
# Tests for lib/common.sh's linking primitives — run: bash lib/test-common.sh
#
# install.sh is the one thing here that writes outside the repo, into directories a
# user already keeps their own files in. Its two primitives decide what gets backed
# up, what gets overwritten, and what gets left alone, and until now nothing checked
# any of it. Everything below runs in a temp tree; $HOME is never touched.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok()   { echo "ok   $1"; }
bad()  { echo "FAIL $1" >&2; fail=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', wanted '$3')"; fi; }

tmp="$(mktemp -d)"
trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT

REPO="$tmp/repo"
mkdir -p "$REPO/agent-skills/alpha" "$REPO/agent-skills/beta"
echo real > "$REPO/agent-skills/alpha/SKILL.md"

# shellcheck source=/dev/null
. lib/common.sh

# --- link ------------------------------------------------------------------
dst="$tmp/dest"
mkdir -p "$dst"

link "$REPO/agent-skills/alpha" "$dst/alpha"
check "link creates the symlink" "$(readlink "$dst/alpha")" "$REPO/agent-skills/alpha"

link "$REPO/agent-skills/alpha" "$dst/alpha" 2>"$tmp/err"
check "re-running is idempotent" "$(readlink "$dst/alpha")" "$REPO/agent-skills/alpha"
check "and silent" "$(cat "$tmp/err")" ""

# A real file in the way is preserved, once, under .bak.
mkdir -p "$dst/beta" && echo mine > "$dst/beta/notes.md"
link "$REPO/agent-skills/beta" "$dst/beta" 2>/dev/null
check "a real dir in the way is backed up" "$(cat "$dst/beta.pre-ecomono.bak/notes.md")" "mine"
check "and replaced by the link" "$(readlink "$dst/beta")" "$REPO/agent-skills/beta"

# A second run must not clobber the backup with the symlink it just made.
link "$REPO/agent-skills/beta" "$dst/beta" 2>/dev/null
check "the backup survives a second run" "$(cat "$dst/beta.pre-ecomono.bak/notes.md")" "mine"

# A foreign symlink is repointed, but says so.
ln -sfn "$tmp/somewhere-else" "$dst/gamma"
link "$REPO/agent-skills/alpha" "$dst/gamma" 2>"$tmp/err"
if grep -q "was linked to" "$tmp/err"; then ok "repointing a foreign symlink warns"; else bad "repointing a foreign symlink warns"; fi

# --- link_children ---------------------------------------------------------
kids="$tmp/kids"
link_children "$REPO/agent-skills" "$kids"
check "every child is linked" "$(find "$kids" -maxdepth 1 -type l | wc -l)" "2"

# Additive: a sibling the user put there is left alone.
echo mine > "$kids/user-owned.md"
link_children "$REPO/agent-skills" "$kids"
check "a user's own sibling is untouched" "$(cat "$kids/user-owned.md")" "mine"

# The case that killed the installer: a destination Nix owns. Two shapes — the parent
# is read-only so the directory cannot be created, and the directory exists but its
# contents cannot be written. Both must warn and return, not abort the caller.
skip_case() { # skip_case <label> <dstdir>
  local label="$1" dstdir="$2"
  if ( set -euo pipefail; link_children "$REPO/agent-skills" "$dstdir" ) 2>"$tmp/err"; then
    if grep -q "not writable" "$tmp/err"; then ok "$label"; else bad "$label (no explanation given)"; fi
  else
    bad "$label (aborted the caller under set -e)"
  fi
}

ro="$tmp/readonly"
mkdir -p "$ro" && chmod 555 "$ro"
skip_case "an uncreatable destination is skipped, not fatal" "$ro/skills"
chmod 755 "$ro"

frozen="$tmp/frozen/skills"
mkdir -p "$frozen" && chmod 555 "$frozen"
skip_case "an existing read-only destination is skipped, not fatal" "$frozen"
chmod 755 "$frozen"

exit "$fail"
