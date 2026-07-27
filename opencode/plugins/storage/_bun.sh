# Resolve bun into $BUN. Sourced by the scripts in this dir; not executable.
# bun is often installed outside PATH (~/.bun/bin), the same fallback install.sh
# uses, so a plain `bun` would fail on exactly the machines that have it.
BUN="$(command -v bun 2>/dev/null || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; })"
[ -n "$BUN" ] || { echo "error: bun not found (curl -fsSL https://bun.sh/install | bash)" >&2; exit 1; }
