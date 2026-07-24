# Design

## Goal

Decouple the ecomono agent stack (Claude Code + opencode config) from NixOS so it installs
on any Linux, while keeping NixOS as a first-class consumer. **This repo is the single
source of truth**; the NixOS config imports it as a flake input rather than holding its own
copy.

## Decisions

- **Single source, NixOS consumes.** Content lives here only. `nixos-config` points at
  `inputs.ecomono` — no duplication between the two.
- **Symlink read-only trees, copy runtime-mutated files.** Config the agents only read
  (agents, skills, commands, hooks, plugins) is symlinked so editing the repo is live.
  `settings.json` is *copied* once and never overwritten — Claude Code rewrites it at
  runtime (theme/model/`/config`), which a read-only symlink would break.
- **`install.sh` targets Arch/Debian/generic Linux; NixOS uses the flake.** The installer
  detects NixOS and refuses, pointing at the flake. Non-destructive and idempotent:
  pre-existing real dirs are backed up to `*.pre-ecomono.bak`.
- **Binaries scope: fetch the hard ones, check the rest.** `engram` and `gentle-ai` are
  static Go binaries from GitHub releases — the *same tarball* runs on every distro, so the
  installer fetches them. `node`/`claude`/`opencode` come from the OS package manager or
  upstream installers; the script only checks and hints.

## Skill topology

Three skill sets, deduplicated from the old NixOS layout (which copied `claude/skills` and
`opencode/config/skills` separately):

- `skills/` — Claude-only skills.
- `agent-skills/` — the shared set (`ecomono*`, `find-skills`, `proxy-manager`), mounted at
  `~/.agents/skills` and referenced by both agents.
- `~/.claude/skills` = `skills/` ∪ `agent-skills/` (symlinked children on non-Nix; merged
  store dir on Nix).

## Portability notes

- Only `opencode/tui.json` needs install-time patching (`/home/agustin` → `$HOME`): it's
  JSON and can't expand env vars. `engram.ts`'s hardcoded fallback was fixed at source to
  `${process.env.HOME}`.
- `opencode/plugins/` stays a writable real dir — opencode installs `node_modules`
  alongside the plugin sources at runtime.
