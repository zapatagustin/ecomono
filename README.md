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
default. `permissions.deny` in `claude/settings.template.json` is the only thing standing in
the way, and it is narrower than it looks. Read it as two separate lists:

- Two literal `Bash` strings, `rm -rf /` and `rm -rf ~` (plain and `sudo`). Nothing
  else typed at a shell is gated by the deny list.
- Credential paths — `.env` / `.env.*`, `.ssh/*`, `.credentials/*`,
  `Library/Keychains/*`, `.aws/credentials`, `.config/gh/hosts.yml`, `**/*.pem`,
  `**/*.key`, `**/secrets/*` — but these bind to the `Read` and `Edit` tools only.
  **They do not cover `Bash`.** The deny list never sees a path that only appears
  inside a shell command.

`claude/hooks/secret-access-gate.sh` covers the second gap, not the first. It is a
`PreToolUse` hook on `Bash` that matches the command string against the same credential
paths and returns `permissionDecision: "ask"`, so `cat ~/.ssh/id_ed25519` asks instead of
running silently. Two things to know about it:

- It matches **substrings of the command**, so `cat $HOME/.ss''h/id_rsa` walks straight
  through, as does any variable indirection. It catches the careless command and the
  wildcard that swept up a secret — not an adversary. It also cannot tell a path from a
  literal, so `echo id_rsa` prompts too.
- The `"ask"` is honored under `bypassPermissions` — verified with `claude -p --settings`,
  where the gated command never executed. But **in a non-interactive run there is nobody to
  answer it, so it lands as a hard block** and retrying is futile. That is the intended
  posture for a credential gate; if a headless job legitimately needs one of these paths,
  set `ECOMONO_ALLOW_SECRET_PATHS=1`.

`opencode.json` gets the same paths under `permission.bash`. That side is glob-only with no
way to express an exception, so `cat .env.example` prompts there while the Claude Code hook
stays quiet on it.

So treat this as "the agent can do anything a shell can do on this machine, minus two
`rm -rf` spellings and a prompt on obvious credential paths", not as credential protection.
It is a deliberate trade for a single-user machine. Since `settings.json` is seeded once and
never overwritten, if you want prompts back everywhere, change `defaultMode` in
`~/.claude/settings.json` (or in `claude/settings.template.json` before installing).

### Review mode

`claude/hooks/review-receipt-gate.sh` refuses `git push` and `gh pr create` unless the exact
bytes being delivered have a review receipt — written by `/ecomono-judgment` when it reaches
`APPROVED`, and named by the same subject hash the review froze. It is **off in every
repository** until you arm that repository:

```bash
d="$(git rev-parse --git-common-dir)/ecomono" && mkdir -p "$d" && touch "$d/review-mode"
```

`rm` that file to turn it off again; with the marker gone the hook exits before it computes a
hash or reads a receipt, so there is nothing to bypass. For a single delivery,
`ECOMONO_ALLOW_UNREVIEWED_PUSH=1` stands the gate down without disarming it — in the
environment, or as a **leading** prefix on the command. Only that position counts: as a
substring it would be disarmed by any branch name carrying the text. Past the leading
assignment it authorises **the whole line, every delivery chained into it included** —
confining it to one command needs a shell parser, and every attempt with string matching
refused ordinary quoted arguments while still missing shapes. The match is textual, so write it
exactly as shown: a quoted `='1'`, or another assignment ahead of it, is not recognised.

What the gate catches is a delivery written plainly. `git push`, `git -C path push`, an aliased
`git p` (chains included), `gh pr create` — those are refused without a receipt.
`$(echo git push)`, a backslash-escaped `gi\t push`, `git${IFS}push`, a `gh` alias, or any
wrapper script that shells out to git are not: the hook reads the command before the shell
expands it, so anything that only becomes a delivery during expansion is invisible to it. Treat
it as a gate against forgetting. Enforcement against intent belongs in CI or branch protection.

If the branch this change is measured against is not one of `@{upstream}`, `origin/HEAD`,
`origin/master`, `origin/main`, `master` or `main`, name it with
`git config ecomono.reviewBase <branch>`. Without it, a stale local `master` resolves ahead of
the real base and denies a push whose review already passed. Armed with no base resolvable at
all, the gate asks rather than allowing silently.

Being a client-side hook, it is bypassable by anyone who wants to — it is a gate against
forgetting, not against intent. Real enforcement belongs in CI or branch protection.

### Env overrides

| Var | Effect |
|-----|--------|
| `ECOMONO_SKIP_PLUGINS=1` | skip plugin/MCP registration |
| `ECOMONO_ALLOW_SECRET_PATHS=1` | stand down `secret-access-gate.sh`, for headless runs that must touch a credential path |
| `ECOMONO_ALLOW_UNREVIEWED_PUSH=1` | stand down `review-receipt-gate.sh` for one delivery, in a repo where review mode is armed |
| `ECOMONO_TARGET=<id>` | override detected `OS_ID` (e.g. `nixos`, `arch`, `debian`, `ubuntu`) for unrecognized distros |

### Prerequisites

- `node` — `sudo pacman -S nodejs` / `sudo apt install nodejs`
- `claude` — `npm i -g @anthropic-ai/claude-code`
- `opencode` — `curl -fsSL https://opencode.ai/install | bash`
- `bun` — `curl -fsSL https://bun.sh/install | bash` (runs ecomono-memory)
- `curl` + `tar` — to fetch the binaries

Make sure `~/.local/bin` is on your `PATH`.

### Checks

`bash check.sh` runs everything: the memory store and its committed MCP bundle, the
installer's linking primitives, the Claude Code hook gates, the persona-drift and
skill-registry selftests, the compress skill's secret guard, and shell syntax. Nothing runs it for
you — there is no CI and no git hook in this repo, so it is worth running before a
commit that touches `opencode/plugins/storage/`, `install.sh`, or `lib/common.sh`.

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
