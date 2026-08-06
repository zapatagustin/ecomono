# MCP registration that reconciles, and refuses to clobber.  Sourced, not run.
#
# Sourced by lib/common.sh (so install.sh gets it) and by flake.nix's activation
# script via `. ${./lib/mcp.sh}`. It lives in its own file for that second caller:
# common.sh sets `set -euo pipefail` at the top, which a home-manager activation
# script must not inherit. Nothing here defines options or runs anything at source
# time.
#
# ONE implementation on purpose. Both install paths used to register on absence alone
# — `mcp get >/dev/null && skip` — so a bumped version pin or a moved bundle path never
# reached a machine that had registered once. flake.nix had reasoned that out for
# ecomono-memory and implemented a check a few lines above context7, which still
# skipped. The first fix for that added a THIRD implementation: a helper here plus a
# separate inline copy in the flake. Two judges pointed out the obvious — a repo with
# four drift-checkers had just answered a duplication bug with more duplication, and
# the copies had already diverged in the same commit (this one compares Command and
# Args, the flake's compared only Args, so a launcher swapped from npx to bunx was
# invisible there). Now the flake sources this file.
#
# ecomono: `claude mcp add` REFUSES an existing name — measured, exit 1, entry
# unchanged — so reconciling genuinely requires remove-then-add. That is not an
# in-place update, and `claude mcp add` cannot express everything an entry can carry:
# `-e/--env`, `-H/--header`, OAuth client id/secret, a non-stdio transport. So this
# refuses to touch an entry that holds anything of the kind and prints what to run
# instead. Reporting the drift was the whole point; destroying an operator's API key
# to report it would be a worse bug than the one this closes, which is exactly what
# the first version did.
#
# ecomono: it compares only what `claude mcp get` prints as `Command:` and `Args:`.
# A registration differing in some field that command does not print reads as
# up to date. Upgrade path if that ever matters: read ~/.claude.json directly instead
# of parsing CLI output.

# The `claude` binary. install.sh has it on PATH; the home-manager activation script
# does not reliably, and resolves it to an absolute path first — so it is a variable
# rather than a bare command name, set by that caller before sourcing.
: "${CLAUDE_BIN:=claude}"

# ensure_mcp <name> <command> [args...]
ensure_mcp() {
  local name="$1"; shift
  local want_cmd="$1"; shift
  local want_args="$*"
  local got got_cmd got_args extras

  got="$("$CLAUDE_BIN" mcp get "$name" 2>/dev/null || true)"

  if [ -n "$got" ]; then
    got_cmd="$(printf '%s\n' "$got" | sed -n 's/^[[:space:]]*Command:[[:space:]]*//p')"
    got_args="$(printf '%s\n' "$got" | sed -n 's/^[[:space:]]*Args:[[:space:]]*//p')"

    if [ "$got_cmd" = "$want_cmd" ] && [ "$got_args" = "$want_args" ]; then
      _mcp_info "mcp $name ✓"
      return 0
    fi

    # Anything indented under `Environment:` is an env var the operator set, and a
    # `Type:` that is not stdio means a transport this cannot rebuild. Either way the
    # entry carries more than `mcp add` is being given here.
    extras="$(printf '%s\n' "$got" | awk '
      /^[[:space:]]*Environment:/ { inenv = 1; next }
      inenv && /^[[:space:]]+[^[:space:]]/ { print "env"; exit }
      inenv { inenv = 0 }
      /^[[:space:]]*Type:[[:space:]]*/ && $0 !~ /stdio/ { print "transport"; exit }
    ')"

    if [ -n "$extras" ]; then
      _mcp_warn "mcp $name differs from this repo's spec, and carries $extras this installer cannot reproduce."
      _mcp_warn "  leaving it alone. To take the new spec and re-apply your own settings:"
      _mcp_warn "    claude mcp remove $name && claude mcp add --scope user $name -- $want_cmd $want_args"
      return 0
    fi

    _mcp_warn "mcp $name is registered as '$got_cmd $got_args' — re-registering"
    "$CLAUDE_BIN" mcp remove "$name" >/dev/null 2>&1 || true
  fi

  "$CLAUDE_BIN" mcp add --scope user "$name" -- "$want_cmd" "$@" \
    || _mcp_warn "could not register the $name mcp (retry: claude mcp add --scope user $name -- $want_cmd $want_args)"
}

# common.sh defines info/warn with colours; the flake's activation script does not.
# Defined only when absent so the installer's output stays consistent.
_mcp_info() { if command -v info >/dev/null 2>&1; then info "$@"; else printf '  %s\n' "$*"; fi; }
_mcp_warn() { if command -v warn >/dev/null 2>&1; then warn "$@"; else printf 'warn: %s\n' "$*" >&2; fi; }
