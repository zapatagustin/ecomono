#!/usr/bin/env bash
#
# ecomono installer — lays down the Claude Code + opencode config on any Linux.
# Idempotent: re-running only refreshes symlinks and never clobbers a runtime
# settings.json. NixOS is handled by the flake, not this script.
#
#   ./install.sh
#
# Env overrides:
#   BIN_DIR=~/.local/bin            where engram/gentle-ai binaries go
#   ENGRAM_VERSION / GENTLE_AI_VERSION   pin a release tag (default: latest)
#   ECOMONO_SKIP_BINARIES=1         skip fetching engram/gentle-ai
#   ECOMONO_SKIP_PLUGINS=1          skip claude plugin/mcp registration

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$REPO/lib/common.sh"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CLAUDE="$HOME/.claude"
OC="$HOME/.config/opencode"
AGENTS="$HOME/.agents/skills"

detect_os
OS_ID="${ECOMONO_TARGET:-$OS_ID}"   # override detection (e.g. unrecognized distro)
log "ecomono installer — os=$OS_ID arch=$(uname -m)"

if [ "$OS_ID" = nixos ]; then
  cat <<'EOF'
NixOS detected. This installer writes into ~/.claude and ~/.config/opencode,
which home-manager owns — don't run it here. Instead consume the flake:

  inputs.ecomono.url = "github:zapataagustin/ecomono";
  # then import ecomono.homeModules.default in your home-manager config

See the README "NixOS" section.
EOF
  exit 0
fi

# ---- 1. config --------------------------------------------------------------
log "linking Claude Code config -> $CLAUDE"
link "$REPO/claude/CLAUDE.md" "$CLAUDE/CLAUDE.md"
for d in agents commands hooks output-styles themes; do
  link "$REPO/claude/$d" "$CLAUDE/$d"
done
# ~/.claude/skills = claude-only skills + the shared agent-skills, as children.
link_children "$REPO/skills"        "$CLAUDE/skills"
link_children "$REPO/agent-skills"  "$CLAUDE/skills"
# Shared agent-skills also live at ~/.agents/skills (opencode + CLAUDE.md refs).
link_children "$REPO/agent-skills"  "$AGENTS"
# settings.json is runtime-mutated by Claude Code — seed once, never overwrite.
if [ -e "$CLAUDE/settings.json" ]; then
  info "settings.json exists — left untouched (template: claude/settings.template.json)"
else
  cp "$REPO/claude/settings.template.json" "$CLAUDE/settings.json"
  info "wrote $CLAUDE/settings.json from template"
fi

log "linking opencode config -> $OC"
link "$REPO/opencode/AGENTS.md"    "$OC/AGENTS.md"
link "$REPO/opencode/opencode.json" "$OC/opencode.json"
link "$REPO/opencode/package.json" "$OC/package.json"
link "$REPO/opencode/commands"     "$OC/commands"
link "$REPO/opencode/tui-plugins"  "$OC/tui-plugins"
# tui.json embeds an absolute plugin path (JSON can't expand $HOME) -> patch it.
copy_patched "$REPO/opencode/tui.json" "$OC/tui.json"
# plugins/ must stay a writable real dir (opencode installs node_modules there);
# link each entry individually, mirroring the Nix layout.
link_children "$REPO/opencode/plugins" "$OC/plugins"

# ---- 2. binaries ------------------------------------------------------------
if [ "${ECOMONO_SKIP_BINARIES:-}" = 1 ]; then
  info "skipping engram/gentle-ai (ECOMONO_SKIP_BINARIES=1)"
elif have curl && have tar; then
  log "installing engram + gentle-ai -> $BIN_DIR"
  install_gh_binary Gentleman-Programming/engram    engram    ENGRAM_VERSION
  install_gh_binary Gentleman-Programming/gentle-ai gentle-ai GENTLE_AI_VERSION
else
  warn "curl and tar are required to fetch binaries — skipping (install them, re-run)"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH — add it to your shell rc (export PATH=\"$BIN_DIR:\$PATH\")" ;;
esac

# ---- 3. prerequisites (check only; distro package managers own these) -------
log "checking prerequisites"
pkg_hint() {
  case "$OS_ID $OS_LIKE" in
    *arch*)            echo "sudo pacman -S $1" ;;
    *debian*|*ubuntu*) echo "sudo apt install $1" ;;
    *)                 echo "install '$1' via your package manager" ;;
  esac
}
if have node;     then info "node ✓";     else warn "node missing — $(pkg_hint nodejs)"; fi
if have claude;   then info "claude ✓";   else warn "claude missing — npm i -g @anthropic-ai/claude-code"; fi
if have opencode; then info "opencode ✓"; else warn "opencode missing — curl -fsSL https://opencode.ai/install | bash"; fi

# ---- 4. Claude plugins + MCP servers (idempotent, non-fatal) ----------------
if [ "${ECOMONO_SKIP_PLUGINS:-}" = 1 ]; then
  info "skipping plugin/mcp registration (ECOMONO_SKIP_PLUGINS=1)"
elif have claude; then
  log "registering Claude plugins + MCP servers"
  ensure_plugin() { # repo name [marketplace]
    local repo="$1" name="$2" market="${3:-$2}"
    if claude plugin list 2>/dev/null | grep -q "$name"; then info "plugin $name ✓"; return; fi
    claude plugin marketplace add "https://github.com/$repo" >/dev/null 2>&1 || true
    claude plugin install "$name@$market" \
      || warn "could not install plugin $name (retry: claude plugin install $name@$market)"
  }
  ensure_plugin Gentleman-Programming/engram        engram
  ensure_plugin anthropics/claude-plugins-official  superpowers claude-plugins-official

  if claude mcp get context7 >/dev/null 2>&1; then
    info "mcp context7 ✓"
  else
    claude mcp add --scope user context7 -- npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp \
      || warn "could not add context7 mcp (retry: claude mcp add --scope user context7 -- npx -y --package=@upstash/context7-mcp -- context7-mcp)"
  fi
else
  info "claude not on PATH — skipping plugin/mcp registration"
fi

# ---- 5. engram <-> opencode -------------------------------------------------
engram_bin="$(command -v engram 2>/dev/null || true)"
[ -n "$engram_bin" ] || { [ -x "$BIN_DIR/engram" ] && engram_bin="$BIN_DIR/engram"; }
if [ -n "$engram_bin" ] && ! grep -rqs engram "$OC" 2>/dev/null; then
  "$engram_bin" setup opencode || warn "engram setup opencode failed (retry: engram setup opencode)"
fi

log "done. open a new shell (or source your rc) so PATH picks up $BIN_DIR"
