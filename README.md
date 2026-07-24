# ecomono

Portable Claude Code + opencode configuration — the ecomono agent stack, decoupled
from any NixOS/home-manager setup. One repo, installable on **Arch**, **Debian**, and
**NixOS**.

It ships the output style, agents, skills, commands, hooks, MCP wiring, and opencode
plugins as plain files (markdown / JS / JSON), plus a POSIX installer that symlinks them
into place and fetches the two custom binaries (`engram`, `gentle-ai`).

## Layout

```
skills/          Claude-only skills (branch-pr, sdd-*, judgment-day, …)
agent-skills/    Shared skills (ecomono*, find-skills, proxy-manager) → ~/.agents/skills
claude/          CLAUDE.md, agents/, commands/, hooks/, output-styles/, themes/,
                 settings.template.json
opencode/        AGENTS.md, opencode.json, tui.json, commands/, plugins/, tui-plugins/
nix/             engram / gentle-ai package definitions (GitHub-release binaries)
lib/common.sh    installer helpers
install.sh       Arch/Debian/generic-Linux installer
flake.nix        NixOS / home-manager module
```

## Install — Arch / Debian / generic Linux

```sh
git clone https://github.com/zapataagustin/ecomono ~/.config/ecomono
~/.config/ecomono/install.sh
```

The installer is **idempotent** and **non-destructive**: it symlinks config into
`~/.claude`, `~/.config/opencode`, and `~/.agents/skills`; seeds `~/.claude/settings.json`
from the template **only if absent** (never clobbers the runtime file); backs up any
pre-existing real dir to `*.pre-ecomono.bak` before linking.

It **fetches** `engram` + `gentle-ai` (GitHub-release binaries) into `~/.local/bin`, and
**registers** the `engram` + `superpowers` Claude plugins and the `context7` MCP server.

It **checks** — but does not install — `node`, `claude`, and `opencode`, printing a
distro-specific hint if any is missing (those belong to your package manager).

### Env overrides

| Var | Effect |
|-----|--------|
| `BIN_DIR` | binary install dir (default `~/.local/bin`) |
| `ENGRAM_VERSION` / `GENTLE_AI_VERSION` | pin a release tag (default: latest) |
| `ECOMONO_SKIP_BINARIES=1` | skip fetching engram/gentle-ai |
| `ECOMONO_SKIP_PLUGINS=1` | skip plugin/MCP registration |

### Prerequisites

- `node` — `sudo pacman -S nodejs` / `sudo apt install nodejs`
- `claude` — `npm i -g @anthropic-ai/claude-code`
- `opencode` — `curl -fsSL https://opencode.ai/install | bash`
- `curl` + `tar` — to fetch the binaries

Make sure `~/.local/bin` is on your `PATH`.

## Install — NixOS

Don't run `install.sh` on NixOS (home-manager owns those paths). Consume the flake:

```nix
# flake.nix
inputs.ecomono.url = "github:zapataagustin/ecomono";

# home-manager config
imports = [ inputs.ecomono.homeModules.default ];
```

The module manages the config declaratively, adds `nodejs` + `engram` + `gentle-ai`, and
registers plugins/MCP on activation. `settings.json` is left unmanaged (Claude Code
rewrites it at runtime) — seed it once:

```sh
cp "$(nix eval --raw github:zapataagustin/ecomono#... 2>/dev/null || echo ~/.config/ecomono)/claude/settings.template.json" ~/.claude/settings.json
```

or just copy `claude/settings.template.json` from a checkout.

## Uninstall

Remove the symlinks the installer created:

```sh
rm -rf ~/.agents/skills
# in ~/.claude and ~/.config/opencode, delete the ecomono-owned symlinks
# (restore any *.pre-ecomono.bak backups you want back)
```
