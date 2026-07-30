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
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
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
  mkdir -p "$dstdir"
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

