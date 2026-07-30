---
name: ecomono-help
description: >
  Quick-reference card for all ecomono modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /ecomono-help,
  "ecomono help", "what ecomono commands", "how do I use ecomono".
---

# ecomono Help

Display this reference card when invoked. One-shot — do NOT change mode, write flag files, or persist anything. Output in ecomono style.

## Modes

| Mode | Trigger | What change |
|------|---------|-------------|
| **Lite** | `/ecomono lite` | Drop filler. Keep sentence structure. |
| **Full** | `/ecomono` | Drop articles, filler, pleasantries, hedging. Fragments OK. Default. |
| **Ultra** | `/ecomono ultra` | Extreme compression. Bare fragments. Tables over prose. |
| **Wenyan-Lite** | `/ecomono wenyan-lite` | Classical Chinese style, light compression. |
| **Wenyan-Full** | `/ecomono wenyan` | Full 文言文. Maximum classical terseness. |
| **Wenyan-Ultra** | `/ecomono wenyan-ultra` | Extreme. Ancient scholar on a budget. |

Mode stick until changed or session end.

## Skills

| Skill | Trigger | What it do |
|-------|---------|-----------|
| **ecomono-commit** | `/ecomono-commit` | Terse commit messages. Conventional Commits. ≤50 char subject. |
| **ecomono-review** | `/ecomono-review` | One-line PR comments: `L42: bug: user null. Add guard.` |
| **ecomono-compress** | `/ecomono-compress <file>` | Compress .md files to ecomono prose. Saves ~46% input tokens. |
| **ecomono-cut** | `/ecomono-cut` | Over-engineering review of a diff. What to delete, one line each. |
| **ecomono-audit** | `/ecomono-audit` | Over-engineering audit of the whole repo. Ranked list of what to cut. |
| **ecomono-help** | `/ecomono-help` | This card. |

## Deactivate

- **opencode**: say "stop ecomono" / "normal mode", or `/ecomono off`. Resume with `/ecomono`.
- **Claude Code**: `/output-style neutral` (ecomono is the `Ecomono` output-style). Resume: `/output-style Ecomono`.

## Configure Default Mode

**opencode** (plugin-driven). Default = `full`. Override:

Environment variable (highest priority):
```bash
export ECOMONO_DEFAULT_MODE=ultra
```

Config file (`~/.config/ecomono/config.json`):
```json
{ "defaultMode": "lite" }
```

`"off"` disables auto-activation on session start; still manual via `/ecomono`. Resolution: env var > config file > `full`.

**Claude Code**: mode is the `Ecomono` output-style, set in `~/.claude/settings.json` (`"outputStyle"`). No env/config-file switching and no session-start auto-activation beyond the active output-style.

## More

Full docs: https://github.com/JuliusBrussee/ecomono
