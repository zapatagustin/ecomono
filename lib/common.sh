# shellcheck shell=bash
# Shared helpers for the ecomono installer. Sourced by install.sh.

set -euo pipefail

# ---- logging ----------------------------------------------------------------
if [ -t 1 ]; then
  _C_RST=$'\033[0m'; _C_DIM=$'\033[2m'; _C_GRN=$'\033[32m'; _C_YEL=$'\033[33m'; _C_RED=$'\033[31m'
else
  _C_RST=; _C_DIM=; _C_GRN=; _C_YEL=; _C_RED=
fi
log()  { printf '%s==>%s %s\n' "$_C_GRN" "$_C_RST" "$*"; }
info() { printf '  %s%s%s\n' "$_C_DIM" "$*" "$_C_RST"; }
warn() { printf '%swarn:%s %s\n' "$_C_YEL" "$_C_RST" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$_C_RED" "$_C_RST" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---- platform detection -----------------------------------------------------
# Sets OS_ID (nixos|arch|debian|ubuntu|...) and OS_LIKE (space-separated ID_LIKE).
detect_os() {
  OS_ID=unknown; OS_LIKE=
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
  fi
  [ -e /etc/NIXOS ] && OS_ID=nixos
}

# ---- filesystem linking (idempotent, non-destructive) -----------------------
# Symlink SRC -> DST. If DST is a pre-existing real file/dir (not our symlink),
# it's moved aside once to DST.pre-ecomono.bak before linking.
link() {
  local src="$1" dst="$2" cur
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    cur="$(readlink "$dst")"
    # Warn only if the existing link points somewhere outside this repo and
    # isn't already what we're about to set (a real foreign repoint, not just
    # a stale path into our own tree from an older layout).
    if [ "$cur" != "$src" ] && { [ -z "${REPO:-}" ] || [ "${cur#"${REPO}"/}" = "$cur" ]; }; then
      warn "$dst was linked to $cur, repointing to $src"
    fi
    ln -sfn "$src" "$dst"
  elif [ -e "$dst" ]; then
    [ -e "$dst.pre-ecomono.bak" ] || { mv "$dst" "$dst.pre-ecomono.bak"; warn "backed up existing $dst -> $dst.pre-ecomono.bak"; }
    rm -rf "$dst"
    ln -sfn "$src" "$dst"
  else
    ln -sfn "$src" "$dst"
  fi
}

# Ensure DSTDIR exists as a real dir, then symlink every child of SRCDIR into it.
# Siblings already in DSTDIR are left untouched (additive).
link_children() {
  local srcdir="$1" dstdir="$2" child
  # A home-manager setup on a non-NixOS host points some of these at the read-only
  # store, and the NixOS guard at the top of install.sh does not fire there. Without
  # this check the first `mv` inside link() fails, `set -e` kills the installer
  # mid-run, and the user gets a bare "Read-only file system" after two other trees
  # already linked.
  #
  # Whether that is fine depends on the destination, which only the caller knows. A
  # skills tree already mounted elsewhere is redundant, so skipping costs nothing. A
  # destination something else depends on being populated is a different story, and
  # "managed by Nix?" is the wrong guess to hand someone whose install is broken —
  # pass `required` and it dies instead.
  if ! mkdir -p "$dstdir" 2>/dev/null || [ ! -w "$dstdir" ]; then
    if [ "${3:-}" = required ]; then
      die "$dstdir is not writable, and this install needs it to be. Nothing else will work until it is."
    fi
    warn "skipping $dstdir (not writable — managed by Nix?)"
    return 0
  fi
  for child in "$srcdir"/*; do
    [ -e "$child" ] || continue
    link "$child" "$dstdir/$(basename "$child")"
  done
}

# Copy SRC to DST, replacing occurrences of /home/agustin with $HOME.
# Used for config files that embed an absolute path and can't expand env vars.
copy_patched() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  sed "s|/home/agustin|$HOME|g" "$src" > "$dst"
}

# ---- MCP registration (reconciling, not presence-only) ----------------------
# Register an MCP server, and RE-register it when what is already registered is
# not what this repo now specifies.
#
#   ensure_mcp <name> <command> [args...]
#
# The presence-only form this replaces — `mcp get >/dev/null && skip` — is the same
# seed-once-never-reconciled bug that let a hook sit in the template for days without
# ever reaching a live machine. Here it bites through the version pin: bump
# `@upstash/context7-mcp@2.2.5` in this repo and every machine that already registered
# context7 keeps launching 2.2.5 forever, with no error and nothing to notice. The
# ecomono-memory entry has the same shape and worse consequences, since its command is
# an absolute path to a bundle that moves whenever the bundle is rebuilt.
#
# `flake.nix` already reasoned its way to this for ecomono-memory and not for context7,
# which is how the gap was found — the fix existed, a few lines from the bug.
#
# ecomono: comparison is against `claude mcp get`'s printed `Command:` and `Args:`
# lines, so it is exact rather than a substring grep for a distinctive path. That means
# it re-registers on a purely cosmetic difference in how the args are spelled, which is
# the safe direction: a needless re-add costs one command, and a missed one is the
# stale-forever bug this exists to close.
ensure_mcp() {
  local name="$1"; shift
  local want_cmd="$1"; shift
  local want_args="$*"
  local got got_cmd got_args

  got="$(claude mcp get "$name" 2>/dev/null || true)"
  if [ -n "$got" ]; then
    got_cmd="$(printf '%s\n' "$got" | sed -n 's/^[[:space:]]*Command:[[:space:]]*//p')"
    got_args="$(printf '%s\n' "$got" | sed -n 's/^[[:space:]]*Args:[[:space:]]*//p')"
    if [ "$got_cmd" = "$want_cmd" ] && [ "$got_args" = "$want_args" ]; then
      info "mcp $name ✓"
      return 0
    fi
    warn "mcp $name is registered as '$got_cmd $got_args' — re-registering"
    claude mcp remove "$name" >/dev/null 2>&1 || true
  fi

  claude mcp add --scope user "$name" -- "$want_cmd" "$@" \
    || warn "could not register the $name mcp (retry: claude mcp add --scope user $name -- $want_cmd $want_args)"
}

