# ecomono

Portable Claude Code + opencode configuration — the ecomono agent stack, decoupled
from any NixOS/home-manager setup. One repo, installable on **Arch**, **Debian**, and
**NixOS**.

It ships the output style, agents, skills, commands, hooks, MCP wiring, and opencode
plugins as plain files (markdown / JS / JSON), plus a POSIX installer that symlinks them
into place. No external binary: everything it needs is in this repo.

## Layout

```
agent-skills/    Every skill (ecomono*, find-skills, proxy-manager) → ~/.claude/skills,
                 ~/.agents/skills, and ~/.config/opencode/skills. One tree; see
                 NOTICE.md for forked work.
claude/          CLAUDE.md, agents/, commands/, hooks/, output-styles/, themes/,
                 settings.template.json
opencode/        AGENTS.md, opencode.json, tui.json, commands/, plugins/, tui-plugins/
lib/common.sh    installer helpers
install.sh       Arch/Debian/generic-Linux installer
flake.nix        NixOS / home-manager module
```

## Install — Arch / Debian / generic Linux

```sh
git clone https://github.com/zapatagustin/ecomono ~/.config/ecomono
~/.config/ecomono/install.sh
```

The installer is **idempotent** and **non-destructive**: it symlinks config into
`~/.claude`, `~/.config/opencode`, and `~/.agents/skills`; seeds `~/.claude/settings.json`
from the template **only if absent** (never clobbers the runtime file); backs up any
pre-existing real dir to `*.pre-ecomono.bak` before linking.

It **registers** the `context7` MCP server and the native **ecomono-memory** MCP
server (a self-contained bun bundle, replacing the old `engram@engram` plugin,
which it uninstalls). It also uninstalls the `superpowers` plugin, whose process
skills now ship from `agent-skills/`.

It fetches **no binaries**. The `gentle-ai` dependency is gone: its skill-registry
generator was reimplemented as `claude/hooks/ecomono-skill-registry.js`, and its
SDD dispatchers only ever read an `openspec/` layout this setup does not use.

It **checks** — but does not install — `node`, `claude`, `opencode`, and `bun`,
printing a distro-specific hint if any is missing (those belong to your package
manager).

### Permission posture

The seeded `settings.json` sets `defaultMode: "bypassPermissions"` (plus
`skipDangerousModePermissionPrompt: true`), so once installed Claude Code runs every
tool call without asking first — more permissive than Claude Code's own interactive
default. The only guardrail is `permissions.deny` in `claude/settings.template.json`,
which blocks `rm -rf /` and `rm -rf ~` (plain and `sudo`), plus read/edit access to
common credential paths: `.env` / `.env.*`, `.ssh/*`, `.credentials/*`,
`Library/Keychains/*`, `.aws/credentials`, `.config/gh/hosts.yml`, `**/*.pem`,
`**/*.key`, and `**/secrets/*`. Everything else — arbitrary writes, network calls,
destructive commands outside those two roots — is not gated. Since `settings.json` is
seeded once and never overwritten, if you want prompts back, change `defaultMode` in
`~/.claude/settings.json` (or in `claude/settings.template.json` before installing).

### Env overrides

| Var | Effect |
|-----|--------|
| `ECOMONO_SKIP_PLUGINS=1` | skip plugin/MCP registration |
| `ECOMONO_TARGET=<id>` | override detected `OS_ID` (e.g. `nixos`, `arch`, `debian`, `ubuntu`) for unrecognized distros |

### Prerequisites

- `node` — `sudo pacman -S nodejs` / `sudo apt install nodejs`
- `claude` — `npm i -g @anthropic-ai/claude-code`
- `opencode` — `curl -fsSL https://opencode.ai/install | bash`
- `bun` — `curl -fsSL https://bun.sh/install | bash` (runs ecomono-memory)
- `curl` + `tar` — to fetch the binaries

Make sure `~/.local/bin` is on your `PATH`.

## Install — NixOS

Don't run `install.sh` on NixOS (home-manager owns those paths). Consume the flake:

```nix
# flake.nix
inputs.ecomono.url = "github:zapatagustin/ecomono";

# home-manager config
imports = [ inputs.ecomono.homeModules.default ];
```

The module manages the config declaratively, adds `nodejs` + `bun`, and
registers plugins/MCP on activation. `settings.json` is left unmanaged (Claude Code
rewrites it at runtime) — seed it once:

```sh
cp "$(nix eval --raw github:zapatagustin/ecomono#... 2>/dev/null || echo ~/.config/ecomono)/claude/settings.template.json" ~/.claude/settings.json
```

or just copy `claude/settings.template.json` from a checkout.

## Uninstall

Almost every top-level entry the installer lays down is a symlink. The two exceptions
are real files, not symlinks, so the removals below don't touch them:
`~/.claude/settings.json` (seeded once, left alone on later runs) and
`~/.config/opencode/tui.json` (a patched copy the installer rewrites every run). Delete
either yourself if you want it gone too. `~/.claude/skills`, `~/.agents/skills`,
`~/.config/opencode/skills`, and `~/.config/opencode/plugins` are also real dirs (created
by `mkdir -p` for `link_children`) and are left behind after uninstall — only their
symlinked children are removed below.

Remove the top-level symlinks:

```sh
rm ~/.claude/CLAUDE.md ~/.claude/agents ~/.claude/commands ~/.claude/hooks \
   ~/.claude/output-styles ~/.claude/themes
rm ~/.config/opencode/AGENTS.md ~/.config/opencode/opencode.json \
   ~/.config/opencode/package.json ~/.config/opencode/commands ~/.config/opencode/tui-plugins
```

Those four dirs' *children* are symlinked one at a time (`link_children`), and that
function is additive — a symlink you added yourself is left untouched. Remove only the
symlinks pointing into this repo, not the dirs and not unrelated symlinks, so any
`*.pre-ecomono.bak` sibling the installer wrote when backing up a pre-existing real file
or dir survives, and so does anything you symlinked in yourself.

**Set `REPO` to the path you actually cloned into before running this** — an empty or
wrong `REPO` turns the `-lname "$REPO/*"` pattern into `-lname "/*"`, which matches (and
deletes) every absolute-path symlink in these dirs, not just the ones this repo put
there. The snippet below checks for that and refuses to run instead:

```sh
REPO=~/.config/ecomono  # path you cloned it into
REPO="${REPO%/}"        # strip a trailing slash, or -lname below matches nothing
if [ -n "$REPO" ] && [ -d "$REPO" ]; then
  for d in ~/.claude/skills ~/.agents/skills ~/.config/opencode/skills ~/.config/opencode/plugins; do
    find "$d" -mindepth 1 -maxdepth 1 -type l -lname "$REPO/*" -delete
  done
else
  echo "REPO not set or not a directory — aborting, nothing deleted" >&2
fi
```

`-lname` is a GNU findutils extension, not POSIX — this snippet assumes GNU find (Arch,
Debian; check first on other generic-Linux distros).

Restore any `*.pre-ecomono.bak` backups you want back (in the dirs above, and next
to the top-level symlinks removed first, e.g. `~/.claude/CLAUDE.md.pre-ecomono.bak`).

Undo the MCP registrations:

```sh
claude mcp remove context7
claude mcp remove ecomono-memory
```

(the installer also retires the old `superpowers` and `engram` plugins/MCP entries —
nothing left to undo there.)
