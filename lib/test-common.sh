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

# The guard that matters is the one against a SECOND real dir appearing where the link
# is. Calling link() again on the symlink it just made takes a different branch and
# proves nothing, so put a real directory back first — that is the shape that would
# overwrite the original backup.
rm "$dst/beta" && mkdir -p "$dst/beta" && echo newer > "$dst/beta/notes.md"
link "$REPO/agent-skills/beta" "$dst/beta" 2>/dev/null
check "a second real dir leaves the first backup's content alone" "$(cat "$dst/beta.pre-ecomono.bak/notes.md")" "mine"
# Content alone cannot prove this: `mv dir existing-dir` nests rather than overwrites,
# so a missing guard hides as beta.pre-ecomono.bak/beta/ while the original sits intact
# beside it. The shape is what gives it away.
check "and does not get buried inside it" "$(find "$dst/beta.pre-ecomono.bak" -mindepth 1 -maxdepth 1 | wc -l)" "1"
check "and the link is still made" "$(readlink "$dst/beta")" "$REPO/agent-skills/beta"

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

# A destination the install depends on must not be shrugged off as "managed by Nix".
needed="$tmp/needed"
mkdir -p "$needed" && chmod 555 "$needed"
if ( set -euo pipefail; link_children "$REPO/agent-skills" "$needed/plugins" required ) 2>"$tmp/err"; then
  bad "a required destination that is not writable stops the install"
else
  if grep -q "needs it to be" "$tmp/err"; then
    ok "a required destination that is not writable stops the install"
  else
    bad "a required destination stops the install (but blamed the wrong thing)"
  fi
fi
chmod 755 "$needed"

# ---- ensure_mcp ------------------------------------------------------------
# The bug this replaced was presence-only registration: `mcp get && skip`, which
# leaves a machine launching whatever it first registered, forever, through every
# later version bump. Every case below drives a fake `claude` on PATH and asserts on
# the subcommands it received — the real one is never invoked and no MCP entry on this
# machine is touched.
mcpbin="$tmp/bin"; mkdir -p "$mcpbin"
calls="$tmp/mcp-calls"
cat > "$mcpbin/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MCP_CALLS"
if [ "$1 $2" = "mcp get" ]; then
  [ -n "${MCP_REGISTERED:-}" ] || exit 1
  printf '%s\n' "$MCP_REGISTERED"
fi
exit 0
STUB
chmod +x "$mcpbin/claude"
export MCP_CALLS="$calls"
PATH="$mcpbin:$PATH"

mcp_case() { # mcp_case <label> <registered-output-or-empty> <expect-add: yes|no> <expect-remove: yes|no>
  : > "$calls"
  MCP_REGISTERED="$2" ensure_mcp context7 npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp >/dev/null 2>&1
  local added=no removed=no
  grep -q '^mcp add' "$calls" && added=yes
  grep -q '^mcp remove' "$calls" && removed=yes
  if [ "$added" = "$3" ] && [ "$removed" = "$4" ]; then
    ok "$1"
  else
    bad "$1 (added=$added wanted=$3, removed=$removed wanted=$4)"
  fi
}

# Faithful to real `claude mcp get` output — Scope/Status/Type/Command/Args/Environment.
# The first version of these stubs omitted `Type: stdio`, which nothing noticed until the
# check started requiring it. A stub easier to satisfy than reality proves nothing.
matching='context7:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: npx
  Args: -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp'
stale='context7:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: npx
  Args: -y --package=@upstash/context7-mcp@2.1.0 -- context7-mcp'

# Same args, different launcher. The flake's now-deleted inline copy compared only
# Args and would have called this up to date; nothing caught that until a judge
# mutated the helper. Both fields are part of the comparison, and this is what says so.
relaunched='context7:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: bunx
  Args: -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp
  Environment:'

# An operator-set env var. Reconciling means remove-then-add, because `claude mcp add`
# refuses an existing name — measured. Re-adding cannot carry an env var, a header or
# OAuth config, so an entry holding any of them is reported and left alone. Destroying
# an API key to report drift would be a worse bug than the drift.
customized='context7:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: npx
  Args: -y --package=@upstash/context7-mcp@2.1.0 -- context7-mcp
  Environment:
    CONTEXT7_API_KEY=secret'

# A claude.ai-scope connector: no Type, no Command, no Args, no Environment. The first
# version listed shapes to REFUSE, so this one — having none of them — fell straight
# through to remove-then-add. A judge found it. The check now lists what it accepts.
remote='context7:
  Scope: claude.ai config
  Status: ✔ Connected'

# A non-stdio transport. Its guard had no coverage at all until a judge deleted the
# clause and watched every case still pass.
httpish='context7:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: http
  URL: https://example.invalid/mcp'

mcp_case "an unregistered server is added"                   ""             yes no
mcp_case "a matching registration is left alone"             "$matching"    no  no
mcp_case "a stale version pin is removed and re-added"       "$stale"       yes yes
mcp_case "a changed launcher with identical args is caught"  "$relaunched"  yes yes
mcp_case "an entry with operator env vars is never clobbered" "$customized" no  no
mcp_case "a claude.ai-scope connector is never touched"      "$remote"      no  no
mcp_case "a non-stdio transport is never touched"            "$httpish"     no  no

# The two above fail BOTH allowlist conditions, so neither one alone is load-bearing for
# them — dropping either guard leaves them passing, which is how a mutation pass found
# nothing. These two isolate one condition each: same shape as a reconcilable entry
# except for the single field under test.
onlytype='context7:
  Scope: User config (available in all your projects)
  Type: stdio
  Args: -y --package=@upstash/context7-mcp@2.1.0 -- context7-mcp'
onlycmd='context7:
  Scope: User config (available in all your projects)
  Type: http
  Command: npx
  Args: -y --package=@upstash/context7-mcp@2.1.0 -- context7-mcp'

mcp_case "stdio but no Command is not reconcilable"          "$onlytype"    no  no
mcp_case "a command under a non-stdio Type is not either"    "$onlycmd"     no  no

# The logging fallback must never reach a PATH binary. `command -v info` found GNU
# Texinfo's `info` in the home-manager activation context, where common.sh is not
# sourced; it exits nonzero on an unknown topic, and home-manager runs every module's
# activation under one `set -eu`, so a routine no-op run aborted the whole switch.
: > "$calls"
cat > "$mcpbin/info" <<'FAKE'
#!/usr/bin/env bash
echo "PATH-INFO-RAN" >> "$MCP_CALLS"
exit 1
FAKE
chmod +x "$mcpbin/info"
# A FRESH bash sourcing only mcp.sh, which is the flake's situation exactly: no
# common.sh, so no `info` function, so a probe by bare name finds the PATH binary.
# Unsetting functions in a subshell of this file was tried first and did not reproduce
# it — the test has to be the context, not an imitation of it.
MCP_REGISTERED="$matching" PATH="$mcpbin:$PATH" \
  bash -c '. lib/mcp.sh; ensure_mcp context7 npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp' \
  >/dev/null 2>&1
if grep -q PATH-INFO-RAN "$calls"; then
  bad "the log fallback must not call a PATH binary named info"
else
  ok "the log fallback never reaches a PATH binary named info"
fi
rm -f "$mcpbin/info"

exit "$fail"
