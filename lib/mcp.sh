# shellcheck shell=bash
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
# ecomono: `claude mcp add` REFUSES an existing name in the same scope — measured, exit
# 1, entry unchanged — so reconciling genuinely requires remove-then-add. What this
# helper cannot rebuild is not `mcp add`'s fault, and an earlier version of this comment
# said it was: `mcp add` does have `-e/--env` and `-H/--header`, and `mcp get` prints
# their values back in plaintext, so those two ARE recoverable in principle. What cannot
# carry them is this function's own signature, `ensure_mcp <name> <command> [args...]`,
# which never parses or reconstructs a flag. OAuth secrets and a per-entry `Timeout:`
# are genuinely out of reach either way. So it refuses to touch anything that is not a
# plain stdio entry and prints what to run instead. Reporting drift by deleting an
# operator's API key would be a worse bug than the drift, which is what the first
# version did.
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

    # ALLOWLIST, not denylist. Reconcile only an entry whose shape is recognisably one
    # `mcp add --scope user -- <cmd> <args>` produced: stdio transport, a command, and
    # nothing indented under `Environment:`. Anything else is left alone.
    #
    # The first version listed what to refuse — an `Environment:` block, a non-stdio
    # `Type:` — and a judge found the shape it forgot: a claude.ai-scope connector
    # prints only `Scope:` and `Status:`, no Command, Args, Type or Environment at all.
    # Empty command, empty args, no refusal trigger, straight to remove-then-add. That
    # is the same mistake as every other one this repo has paid for: a list of what to
    # reject makes forgetting a false PASS, and forgetting is the thing that keeps
    # happening. Listing what to accept makes forgetting a needless refusal instead.
    reconcilable="$(printf '%s\n' "$got" | awk '
      /^[[:space:]]*Type:[[:space:]]*stdio[[:space:]]*$/ { stdio = 1 }
      /^[[:space:]]*Command:[[:space:]]*[^[:space:]]/    { cmd = 1 }
      /^[[:space:]]*Environment:/ { inenv = 1; next }
      inenv && /^[[:space:]]+[^[:space:]]/ { extra = 1; inenv = 0; next }
      inenv { inenv = 0 }
      /^[[:space:]]*Timeout:[[:space:]]*[^[:space:]]/    { extra = 1 }
      END { if (stdio && cmd && !extra) print "yes" }
    ')"

    if [ -z "$reconcilable" ]; then
      _mcp_warn "mcp $name differs from this repo's spec, and is not a plain stdio entry this installer can rebuild."
      _mcp_warn "  leaving it alone. To take the new spec and re-apply your own settings:"
      _mcp_warn "    claude mcp remove -s user $name && claude mcp add --scope user $name -- $want_cmd $want_args"
      return 0
    fi

    _mcp_warn "mcp $name is registered as '$got_cmd $got_args' — re-registering"
    # `-s user`, never bare. `mcp get` and `mcp remove` resolve a name across USER,
    # LOCAL and PROJECT scope, so without this the reconciler is scope-blind and the
    # invoking shell's cwd decides what it touches. Two things measured, both bad:
    # inside a repo whose committed `.mcp.json` happens to name one of these servers,
    # an unscoped remove DELETES that team's tracked entry ("File modified:
    # .../.mcp.json"); and when the name exists in user AND project scope it refuses
    # with "exists in multiple scopes", which `|| true` swallows, so the following
    # `add` fails as "already exists" and the entry stays exactly as stale as before —
    # the feature silently doing nothing, which is the bug it was built to close.
    # Scoped, a name that only exists elsewhere is simply not ours to touch.
    "$CLAUDE_BIN" mcp remove -s user "$name" >/dev/null 2>&1 || true
  fi

  "$CLAUDE_BIN" mcp add --scope user "$name" -- "$want_cmd" "$@" \
    || _mcp_warn "could not register the $name mcp (retry: claude mcp add --scope user $name -- $want_cmd $want_args)"
}

# common.sh defines info/warn as FUNCTIONS with colours; the flake's activation script
# sources only this file and has neither.
#
# ecomono: `declare -F`, never `command -v`. The first version probed with `command -v
# info`, which finds a function when one is loaded — and finds GNU Texinfo's `info`
# BINARY when one is not. That is the flake's situation exactly: on NixOS
# `documentation.info.enable` defaults on, so `info` is at /run/current-system/sw/bin/info,
# and `info "mcp context7 ✓"` exits 1. home-manager concatenates every module's
# activation into one script under a single `set -eu`, so that nonzero exit aborts the
# whole `home-manager switch` — on the steady-state path, every run after the first.
# Reproduced end to end by a judge and again by hand. `declare -F` only ever finds a
# function, so a binary of the same name cannot be mistaken for one.
_mcp_info() { if declare -F info >/dev/null 2>&1; then info "$@"; else printf '  %s\n' "$*"; fi; }
_mcp_warn() { if declare -F warn >/dev/null 2>&1; then warn "$@"; else printf 'warn: %s\n' "$*" >&2; fi; }

# The servers this repo registers, spelled once. install.sh and flake.nix both call
# this rather than each carrying the pin: deduplicating the reconcile LOGIC while
# leaving the version string in two files would have left exactly the drift the logic
# exists to catch — bump one, forget the other, and the forgotten side keeps comparing
# against its own stale value and matching. A judge counted the copies.
#
# ecomono-memory is not here: its command is two paths that differ per platform (a bun
# on PATH and a repo checkout, versus two nix store paths), so there is nothing shared
# to hoist. Its caller passes them.
ensure_context7_mcp() {
  ensure_mcp context7 npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp
}
