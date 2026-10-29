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
# common.sh sets `set -euo pipefail` at its own top, and sourcing leaks that errexit
# into this file — which is built to tally every failure and keep going. Measured:
# `$-` reads `ehuBc` after the source, and one failing check aborted the run with no
# FAIL line for anything after it. Reset it, or this harness reports less than it saw.
set +e

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
# The real binary, resolved BEFORE the stub goes on PATH. The scope test below needs
# the actual CLI; without this it silently drove the stub, which has no notion of scope
# and made the case pass for nothing.
REAL_CLAUDE="$(command -v claude || true)"

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

# A per-server Timeout: only reachable by `mcp add-json` or a hand edit, and the one
# thing standing between it and remove-then-add. Deleting its clause used to fail
# nothing at all.
timedout='context7:
  Scope: User config (available in all your projects)
  Type: stdio
  Command: npx
  Args: -y --package=@upstash/context7-mcp@2.1.0 -- context7-mcp
  Timeout: 5000ms'

mcp_case "a per-server Timeout is never clobbered"           "$timedout"    no  no
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

# ---- scope, against the REAL claude ---------------------------------------
# Every case above stubs `claude`, and a stub has no notion of scope — which is
# precisely how three rounds of review missed the worst defect this file ever had:
# `mcp get` and `mcp remove` resolve a name across user, local AND project scope, so
# an unscoped remove run from inside a repo whose committed .mcp.json names one of
# these servers deleted that team's tracked entry. A stub cannot model that. This one
# drives the real binary inside an isolated HOME and a throwaway project.
if [ -n "$REAL_CLAUDE" ]; then
  # `mcp get` and `mcp remove` resolve a name across USER, LOCAL and PROJECT scope, so
  # an unscoped remove is decided by the invoking shell's cwd. With the same name in a
  # project's .mcp.json and in user scope, a bare `mcp remove` refuses ("exists in
  # multiple scopes"), `|| true` swallows it, the following `add` fails as "already
  # exists", and the stale entry survives — the feature silently doing nothing, which
  # is precisely the bug it was built to close. Measured both ways: scoped, the pin
  # moves to the current one; unscoped, it stays behind.
  repo_root="$PWD"
  scope_home="$tmp/scope-home"; scope_proj="$tmp/scope-proj"
  mkdir -p "$scope_home" "$scope_proj"
  printf '{"mcpServers":{"context7":{"command":"someone-elses","args":["--x"]}}}' \
    > "$scope_proj/.mcp.json"
  # CLAUDE_CONFIG_DIR overrides HOME COMPLETELY for where claude stores state, so
  # isolating by HOME alone is not isolating. Measured: with it set in the ambient
  # shell, running this suite wrote a real context7 entry into the operator's own
  # config — zero before, one after. The header two hundred lines up promises `$HOME`
  # is never touched; that promise was only true for operators who do not use this
  # variable. Both are pinned to the throwaway dir now.
  export CLAUDE_CONFIG_DIR="$scope_home"
  HOME="$scope_home" "$REAL_CLAUDE" mcp add --scope user context7 \
    -- npx -y --package=@upstash/context7-mcp@2.1.0 -- context7-mcp >/dev/null 2>&1
  # `bash -c`, not a plain `( ... )`. A subshell inherits every function the parent
  # already sourced — lib/common.sh pulls in lib/mcp.sh at line 24 — so re-sourcing
  # inside one proves nothing and a broken path passes for free. A judge showed the
  # previous "vacuity guard" was exactly that: dead. A fresh process makes the source
  # load-bearing.
  ( cd "$scope_proj" && HOME="$scope_home" CLAUDE_CONFIG_DIR="$scope_home" \
      CLAUDE_BIN="$REAL_CLAUDE" bash -c ". '$repo_root/lib/mcp.sh'; ensure_context7_mcp"
  ) >/dev/null 2>&1
  got_pin="$(HOME="$scope_home" CLAUDE_CONFIG_DIR="$scope_home" "$REAL_CLAUDE" mcp get context7 2>/dev/null \
             | sed -n 's/^[[:space:]]*Args:[[:space:]]*//p')"
  check "a colliding project entry does not stall the reconcile" \
    "$got_pin" "-y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp"
  check "and the project's own .mcp.json is left alone" \
    "$(cat "$scope_proj/.mcp.json")" \
    '{"mcpServers":{"context7":{"command":"someone-elses","args":["--x"]}}}'
else
  ok "skip: claude not on PATH, cannot exercise real scope behaviour"
fi

# ---- install_omp_config ----------------------------------------------------
# Fixture sources under the temp $REPO, so nothing here reads or writes the real tree
# or $HOME. The five targets are the whole contract: a link each for the extension dir,
# RULES.md and PERSONALITY.md, and one link per agent and command inside real dirs.
echo "--- install_omp_config"
mkdir -p "$REPO/omp/extensions/ecomono" "$REPO/opencode" "$REPO/claude/output-styles" \
         "$REPO/claude/agents" "$REPO/claude/commands"
echo ext      > "$REPO/omp/extensions/ecomono/index.ts"
echo persona  > "$REPO/opencode/AGENTS.md"
echo style    > "$REPO/claude/output-styles/ecomono.md"
echo agent    > "$REPO/claude/agents/a.md"
echo command  > "$REPO/claude/commands/c.md"

omp="$tmp/omp-home/.omp/agent"
install_omp_config "$omp" 2>"$tmp/err"
check "the extension dir is linked"   "$(readlink "$omp/extensions/ecomono")" "$REPO/omp/extensions/ecomono"
check "RULES.md is the persona"       "$(readlink "$omp/RULES.md")"           "$REPO/opencode/AGENTS.md"
check "PERSONALITY.md is the style"   "$(readlink "$omp/PERSONALITY.md")"     "$REPO/claude/output-styles/ecomono.md"
check "each agent is linked"          "$(readlink "$omp/agents/a.md")"        "$REPO/claude/agents/a.md"
check "each command is linked"        "$(readlink "$omp/commands/c.md")"      "$REPO/claude/commands/c.md"
check "agents/ stays a real directory"   "$([ -d "$omp/agents" ] && [ ! -L "$omp/agents" ] && echo real)"     "real"
check "commands/ stays a real directory" "$([ -d "$omp/commands" ] && [ ! -L "$omp/commands" ] && echo real)" "real"
check "a clean install is silent" "$(cat "$tmp/err")" ""

# A real RULES.md of the operator's: backed up once, then replaced by the link.
omp_bak="$tmp/omp-bak/agent"
mkdir -p "$omp_bak" && echo mine > "$omp_bak/RULES.md"
install_omp_config "$omp_bak" 2>/dev/null
check "a real RULES.md is backed up"      "$(cat "$omp_bak/RULES.md.pre-ecomono.bak")" "mine"
check "and replaced by the link"          "$(readlink "$omp_bak/RULES.md")"           "$REPO/opencode/AGENTS.md"

# A second run changes nothing: same paths, same targets, no second backup, no output.
snap() { find "$1" -printf '%p -> %l\n' | sort; }
before="$(snap "$omp_bak")"
install_omp_config "$omp_bak" 2>"$tmp/err"
check "a second run changes nothing" "$(snap "$omp_bak")" "$before"
check "and says nothing"             "$(cat "$tmp/err")" ""

# ---- ensure_omp_mcp --------------------------------------------------------
# A jq upsert into a JSON file omp owns too, so the cases that matter are the ones that
# could damage what is already there. All files live in $tmp.
echo "--- ensure_omp_mcp"
if have jq; then
  m="$tmp/omp-mcp"; mkdir -p "$m"
  inode() { stat -c '%i %y' "$1"; }

  # From nothing: the file and its directory are created.
  f="$m/fresh/agent/mcp.json"
  ensure_omp_mcp "$f" n cmd a1 a2 >/dev/null 2>&1
  check "creates the file from nothing" "$(jq -c '.mcpServers.n' "$f")" '{"command":"cmd","args":["a1","a2"]}'
  ensure_omp_mcp "$m/fresh/noargs.json" n cmd >/dev/null 2>&1
  check "no arguments encode as an empty array" "$(jq -c '.mcpServers.n.args' "$m/fresh/noargs.json")" '[]'
  # The shared context7 array starts with `-y`; jq must take it as a value, not an option.
  ensure_omp_mcp "$m/fresh/c7.json" context7 "${CONTEXT7_MCP[@]}" >/dev/null 2>&1
  check "context7's leading -y is data, not a jq option" \
    "$(jq -c '.mcpServers.context7.args' "$m/fresh/c7.json")" \
    "$(jq -cn '$ARGS.positional' --args -- "${CONTEXT7_MCP[@]:1}")"
  check "and its command is the array head" "$(jq -r '.mcpServers.context7.command' "$m/fresh/c7.json")" "${CONTEXT7_MCP[0]}"

  # Operator data survives: $schema, disabledServers, a foreign server, and the
  # operator's own `enabled` and environment block on the managed entry, while command
  # and args repair.
  f="$m/keep.json"
  cat > "$f" <<'JSON'
{
  "$schema": "https://example.invalid/mcp.schema.json",
  "disabledServers": ["other"],
  "mcpServers": {
    "foreign": {"command": "theirs", "args": ["--x"]},
    "n": {"command": "old", "args": ["stale"], "enabled": false, "env": {"K": "v"}}
  }
}
JSON
  ensure_omp_mcp "$f" n cmd a1 a2 >/dev/null 2>&1
  check "keeps \$schema"             "$(jq -r '."$schema"' "$f")"               "https://example.invalid/mcp.schema.json"
  check "keeps disabledServers"      "$(jq -c '.disabledServers' "$f")"         '["other"]'
  check "keeps a foreign server"     "$(jq -c '.mcpServers.foreign' "$f")"      '{"command":"theirs","args":["--x"]}'
  check "keeps enabled: false"       "$(jq -c '.mcpServers.n.enabled' "$f")"    'false'
  check "keeps the env block"        "$(jq -c '.mcpServers.n["env"]' "$f")"     '{"K":"v"}'
  check "repairs the changed command" "$(jq -r '.mcpServers.n.command' "$f")"   "cmd"
  check "repairs the changed args"   "$(jq -c '.mcpServers.n.args' "$f")"       '["a1","a2"]'

  # An identical second call is a no-op: no rewrite, so no inode or mtime change.
  i1="$(inode "$f")"
  ensure_omp_mcp "$f" n cmd a1 a2 >"$tmp/out" 2>&1
  check "a second identical call does not rewrite" "$(inode "$f")" "$i1"
  if grep -q 'omp mcp n ✓' "$tmp/out"; then ok "and reports it as up to date"; else bad "and reports it as up to date"; fi

  # Never clobber: each of these is left byte-identical, and the call still returns 0.
  untouched() { # untouched <label> <content>
    local label="$1" file="$m/untouched.json" rc
    printf '%s' "$2" > "$file"; cp "$file" "$file.orig"
    ensure_omp_mcp "$file" n cmd a1 >/dev/null 2>&1; rc=$?
    if cmp -s "$file" "$file.orig" && [ "$rc" = 0 ]; then ok "$label"; else bad "$label (rc=$rc)"; fi
  }
  untouched "invalid JSON is left untouched"                '{"mcpServers": {oops'
  untouched "a top-level array is left untouched"           '[{"mcpServers":{}}]'
  untouched "a top-level null is left untouched"            'null'
  untouched "a top-level number is left untouched"          '5'
  untouched "a top-level string is left untouched"          '"x"'
  untouched "an empty file is left untouched"               ''
  untouched "two documents are left untouched"              '{} {}'
  untouched "an mcpServers that is not an object is kept"   '{"mcpServers":["x"]}'
  untouched "a managed entry that is not an object is kept" '{"mcpServers":{"n":"a string"}}'
  # An http/sse entry would end up with both command and url, which omp rejects, so the
  # operator's remote endpoint is never reconciled (same rule as the Claude side).
  untouched "an http entry is never touched"                '{"mcpServers":{"n":{"type":"http","url":"https://x","headers":{"K":"v"}}}}'
  untouched "an sse entry is never touched"                 '{"mcpServers":{"n":{"type":"sse","url":"https://x"}}}'
  untouched "a url entry without a type is never touched"   '{"mcpServers":{"n":{"url":"https://x"}}}'
  rm -f "$m/untouched.json.orig"

  # A symlinked mcp.json becomes a real file, and what it pointed at is not modified.
  target="$m/link-target.json"; printf '%s\n' '{"mcpServers":{"foreign":{"command":"f"}}}' > "$target"
  cp "$target" "$target.orig"
  ln -s "$target" "$m/linked.json"
  ensure_omp_mcp "$m/linked.json" n cmd a1 >/dev/null 2>&1
  check "a symlinked mcp.json becomes a real file" "$([ -f "$m/linked.json" ] && [ ! -L "$m/linked.json" ] && echo real)" "real"
  if cmp -s "$target" "$target.orig"; then ok "and the link target is unchanged"; else bad "and the link target is unchanged"; fi
  check "and the real file holds the entry and the old servers" \
    "$(jq -c '[.mcpServers.foreign.command, .mcpServers.n.command]' "$m/linked.json")" '["f","cmd"]'

  # mktemp succeeds but the write fails: the original stays, the temp file is removed, rc 0.
  # The stub passes every jq call through except the pretty-printing `jq .` that fills it.
  mkdir -p "$m/jqfail"
  cat > "$m/jqfail/jq" <<STUB
#!/usr/bin/env bash
if [ "\$#" = 1 ] && [ "\$1" = . ]; then exit 1; fi
exec "$(command -v jq)" "\$@"
STUB
  chmod +x "$m/jqfail/jq"
  f="$m/writefail.json"; printf '%s\n' '{"mcpServers":{"foreign":{"command":"f"}}}' > "$f"; cp "$f" "$f.orig"
  ( PATH="$m/jqfail:$PATH"; ensure_omp_mcp "$f" n cmd a1 >/dev/null 2>"$tmp/err" ); rc=$?
  if [ "$rc" = 0 ] && cmp -s "$f" "$f.orig" && [ -s "$tmp/err" ]; then ok "a failed write warns, returns 0 and keeps the file"; else bad "a failed write warns, returns 0 and keeps the file (rc=$rc)"; fi
  check "and removes its temp file" "$(find "$m" -maxdepth 1 -name '.mcp.json.*' | wc -l | tr -d ' ')" "0"

  # No temp file is left behind by any of the above.
  check "no temp file is left behind" "$(find "$m" -name '.mcp.json.*' | wc -l | tr -d ' ')" "0"

  # An unwritable directory warns and returns 0 instead of aborting the caller.
  if [ "$(id -u)" != 0 ]; then
    mkdir -p "$m/ro" && chmod 555 "$m/ro"
    ensure_omp_mcp "$m/ro/mcp.json" n cmd >/dev/null 2>"$tmp/err"; rc=$?
    chmod 755 "$m/ro"
    if [ "$rc" = 0 ] && [ ! -e "$m/ro/mcp.json" ] && [ -s "$tmp/err" ]; then ok "an unwritable directory warns and returns 0"; else bad "an unwritable directory warns and returns 0 (rc=$rc)"; fi
  fi

  # Fresh shells under `set -eu`: the home-manager activation's situation, which sources
  # only mcp.sh and runs under one errexit for every module. A subshell of this file
  # inherits functions, so these must be separate bash processes (same reasoning as the
  # fresh-bash case for the log fallback above).
  f="$m/eu.json"
  bash -c 'set -eu; . lib/mcp.sh; ensure_omp_mcp "$1" n c a; ensure_omp_mcp "$1" n c a' _ "$f" >/dev/null 2>&1
  check "set -eu: the write path and the no-op path both exit 0" "$?" "0"
  check "and the file holds the entry" "$(jq -c '.mcpServers.n' "$f")" '{"command":"c","args":["a"]}'

  f="$m/eu-bad.json"; printf '%s' '{"mcpServers": {oops' > "$f"; cp "$f" "$f.orig"
  bash -c 'set -eu; . lib/mcp.sh; ensure_omp_mcp "$1" n c a' _ "$f" >/dev/null 2>&1
  check "set -eu: an invalid-JSON file exits 0" "$?" "0"
  if cmp -s "$f" "$f.orig"; then ok "and stays byte-identical"; else bad "and stays byte-identical"; fi

  # No jq on PATH: warns, returns 0, touches nothing. `command -v bash` is resolved first
  # so the empty PATH does not cost the interpreter.
  mkdir -p "$m/nojq"
  f="$m/nojq-absent/mcp.json"
  PATH="$m/nojq" "$(command -v bash)" -c 'set -eu; . lib/mcp.sh; ensure_omp_mcp "$1" n c' _ "$f" >/dev/null 2>"$tmp/err"
  check "set -eu, no jq: exits 0" "$?" "0"
  check "and creates nothing" "$([ -e "$m/nojq-absent" ] && echo created || echo none)" "none"
  if grep -q jq "$tmp/err"; then ok "and says why"; else bad "and says why"; fi
  f="$m/nojq-present.json"; echo '{"mcpServers":{}}' > "$f"; cp "$f" "$f.orig"
  PATH="$m/nojq" "$(command -v bash)" -c 'set -eu; . lib/mcp.sh; ensure_omp_mcp "$1" n c' _ "$f" >/dev/null 2>&1
  if cmp -s "$f" "$f.orig"; then ok "an existing file is untouched without jq"; else bad "an existing file is untouched without jq"; fi
else
  ok "skip: jq not on PATH, cannot exercise ensure_omp_mcp"
fi

# ---- install.sh end to end (temp HOME) -------------------------------------
# The helpers above are proven in isolation; this runs the real install.sh, so a wrong
# argument order, a step placed inside the claude block, or a variable used before it is
# set is caught here and nowhere else. HOME is a temp dir, `bun` is a stub (so `bun
# install` writes nothing into opencode/), and every variable omp or claude would use to
# relocate its config is unset, so nothing outside $h can be reached.
echo "--- install.sh end to end (temp HOME)"
if have jq; then
  real_repo="$PWD"
  h="$tmp/e2e-home"; mkdir -p "$h"
  stub="$tmp/e2e-stub"; mkdir -p "$stub"
  cat > "$stub/bun" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo 1.4.2; fi
exit 0
STUB
  chmod +x "$stub/bun"

  e2e_install() { # e2e_install <logfile> [VAR=value ...]   -> install.sh's exit status
    local out="$1"; shift
    env -u PI_CODING_AGENT_DIR -u PI_CONFIG_DIR -u CLAUDE_CONFIG_DIR \
      XDG_CACHE_HOME="$tmp/e2e-xdg-cache" XDG_STATE_HOME="$tmp/e2e-xdg-state" \
      ECOMONO_DATA_DIR="$tmp/e2e-data" ECOMONO_LEGACY_DB="$tmp/e2e-none/legacy.db" \
      HOME="$h" ECOMONO_TARGET=arch ECOMONO_SKIP_PLUGINS=1 PATH="$stub:$PATH" "$@" \
      bash "$real_repo/install.sh" >"$out" 2>&1
  }
  tree_state() { git --no-optional-locks status --porcelain 2>/dev/null | sort; }

  tree_before="$(tree_state)"
  e2e_install "$tmp/install.out"; rc=$?
  check "install.sh exits 0 in a temp HOME" "$rc" "0"
  [ "$rc" = 0 ] || tail -n 20 "$tmp/install.out" >&2

  o="$h/.omp/agent"
  check "the extension dir is linked into ~/.omp/agent" "$(readlink "$o/extensions/ecomono")" "$real_repo/omp/extensions/ecomono"
  check "RULES.md is the persona"     "$(readlink "$o/RULES.md")"       "$real_repo/opencode/AGENTS.md"
  check "PERSONALITY.md is the style" "$(readlink "$o/PERSONALITY.md")" "$real_repo/claude/output-styles/ecomono.md"

  for kind in agents commands; do
    missing=0; total=0
    for src in "$real_repo/claude/$kind"/*.md; do
      [ -e "$src" ] || continue
      total=$((total + 1))
      [ "$(readlink "$o/$kind/$(basename "$src")")" = "$src" ] || missing=$((missing + 1))
    done
    if [ "$total" -gt 0 ] && [ "$missing" = 0 ]; then ok "every claude/$kind/*.md is linked ($total)"; else bad "every claude/$kind/*.md is linked (missing $missing of $total)"; fi
  done

  mcp="$o/mcp.json"
  if jq -e --arg b "$stub/bun" --arg m "$real_repo/opencode/plugins/storage/mcp-server.js" \
       '.mcpServers["ecomono-memory"] == {command: $b, args: [$m]}' "$mcp" >/dev/null 2>&1; then
    ok "mcp.json registers ecomono-memory with the bun on PATH and the committed bundle"
  else
    bad "mcp.json registers ecomono-memory with the bun on PATH and the committed bundle"
  fi
  check "mcp.json registers context7 with the shared pin (command)" "$(jq -r '.mcpServers.context7.command' "$mcp" 2>/dev/null)" "${CONTEXT7_MCP[0]}"
  check "and its args" "$(jq -c '.mcpServers.context7.args' "$mcp" 2>/dev/null)" "$(jq -cn '$ARGS.positional' --args -- "${CONTEXT7_MCP[@]:1}")"

  # ECOMONO_SKIP_PLUGINS=1 skips Claude registration only: the omp MCP step still ran.
  # A second run is a no-op on the file: same inode and mtime, nothing re-registered.
  i1="$(stat -c '%i %y' "$mcp")"
  e2e_install "$tmp/install2.out"; rc=$?
  check "a second run exits 0" "$rc" "0"
  check "and leaves mcp.json untouched" "$(stat -c '%i %y' "$mcp")" "$i1"

  # omp's own overrides decide where it reads its config, so they decide where this
  # writes it: PI_CODING_AGENT_DIR is the agent dir itself, PI_CONFIG_DIR the name under HOME.
  e2e_install "$tmp/install3.out" PI_CODING_AGENT_DIR="$h/alt/agent"; rc=$?
  check "PI_CODING_AGENT_DIR: exits 0" "$rc" "0"
  check "PI_CODING_AGENT_DIR: the extension is linked there" "$(readlink "$h/alt/agent/extensions/ecomono")" "$real_repo/omp/extensions/ecomono"
  check "PI_CODING_AGENT_DIR: mcp.json is written there" "$(jq -r '.mcpServers.context7.command' "$h/alt/agent/mcp.json" 2>/dev/null)" "${CONTEXT7_MCP[0]}"

  e2e_install "$tmp/install4.out" PI_CONFIG_DIR=.pi-alt; rc=$?
  check "PI_CONFIG_DIR: exits 0" "$rc" "0"
  check "PI_CONFIG_DIR: the extension is linked under it" "$(readlink "$h/.pi-alt/agent/extensions/ecomono")" "$real_repo/omp/extensions/ecomono"
  check "PI_CONFIG_DIR: RULES.md is linked under it" "$(readlink "$h/.pi-alt/agent/RULES.md")" "$real_repo/opencode/AGENTS.md"

  # The stub replaced `bun install`, so none of the four runs may have touched the checkout.
  check "the repo working tree is unchanged by install.sh" "$(tree_state)" "$tree_before"
else
  ok "skip: jq not on PATH, cannot exercise install.sh end to end"
fi

exit "$fail"