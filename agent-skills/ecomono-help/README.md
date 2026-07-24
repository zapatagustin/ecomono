# ecomono-help

Quick-reference card. One shot, no mode change.

## What it does

Prints a cheat sheet of all ecomono modes, sibling skills, deactivation triggers, and how to set the default mode via env var or config file. One-shot display — does not flip the active mode, write flag files, or persist anything. Use when you forget the slash commands.

## How to invoke

```
/ecomono-help
```

Also triggers on "ecomono help", "what ecomono commands", "how do I use ecomono".

## Example output

```
Modes:
  /ecomono              full (default)
  /ecomono lite         lighter
  /ecomono ultra        extreme
  /ecomono wenyan       classical Chinese

Skills:
  /ecomono-commit       terse Conventional Commits
  /ecomono-review       one-line PR comments

Deactivate:
  "stop ecomono" or "normal mode"
```

## See also

- [`SKILL.md`](./SKILL.md) — full reference card
- [ecomono README](../../README.md) — repo overview
