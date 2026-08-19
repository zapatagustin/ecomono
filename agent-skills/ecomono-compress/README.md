<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/rock_1faa8.png" width="80" />
</p>

<h1 align="center">ecomono-compress</h1>

<p align="center">
  <strong>shrink memory file. save token every session.</strong>
</p>

---

An AI agent skill that compresses your project memory files (`CLAUDE.md`, todos, preferences) into ecomono format — so every session loads fewer tokens automatically.

LLM reads `CLAUDE.md` on every session start. If file big, cost big. Ecomono make file small. Cost go down forever.

## What It Do

```
/ecomono-compress CLAUDE.md
```

```
CLAUDE.md          ← compressed (Claude reads this — fewer tokens every session)
CLAUDE.original.md ← human-readable backup (you edit this)
```

Original never lost. You can read and edit `.original.md`. Run skill again to re-compress after edits.

## Benchmarks

Real results on real project files:

| File | Original | Compressed | Saved |
|------|----------:|----------:|------:|
| `claude-md-preferences.md` | 706 | 285 | **59.6%** |
| `project-notes.md` | 1145 | 535 | **53.3%** |
| `claude-md-project.md` | 1122 | 636 | **43.3%** |
| `todo-list.md` | 627 | 388 | **38.1%** |
| `mixed-with-code.md` | 888 | 560 | **36.9%** |
| **Average** | **898** | **481** | **46%** |

All validations passed ✅ — headings, code blocks, URLs, file paths preserved exactly.

## Before / After

<table>
<tr>
<td width="50%">

### 📄 Original (706 tokens)

> "I strongly prefer TypeScript with strict mode enabled for all new code. Please don't use `any` type unless there's genuinely no way around it, and if you do, leave a comment explaining the reasoning. I find that taking the time to properly type things catches a lot of bugs before they ever make it to runtime."

</td>
<td width="50%">

### <img src="../../docs/assets/dancing-rock.svg" width="20" height="20" alt="rock"/> ecomono (285 tokens)

> "Prefer TypeScript strict mode always. No `any` unless unavoidable — comment why if used. Proper types catch bugs early."

</td>
</tr>
</table>

**Same instructions. 60% fewer tokens. Every. Single. Session.**

## Security

`ecomono-compress` is flagged as Snyk High Risk due to subprocess and file I/O patterns detected by static analysis. This is a false positive — see [SECURITY.md](./SECURITY.md) for a full explanation of what the skill does and does not do.

## Install

Compress is built in with the `ecomono` plugin. Install `ecomono` once, then use `/ecomono-compress`.

If you need local files, the compress skill lives at:

```bash
ecomono-compress/
```

**Requires:** Python 3.10+ (for deterministic validator only)

## Usage

```
/ecomono-compress <filepath>
```

Examples:
```
/ecomono-compress CLAUDE.md
/ecomono-compress docs/preferences.md
/ecomono-compress todos.md
```

### What files work

| Type | Compress? |
|------|-----------|
| `.md`, `.txt`, `.rst`, `.typ`, `.typst`, `.tex` | ✅ Yes |
| Extensionless natural language | ✅ Yes |
| `.py`, `.js`, `.ts`, `.json`, `.yaml` | ❌ Skip (code/config) |
| `*.original.md` | ❌ Skip (backup files) |

## How It Work

```
/ecomono-compress CLAUDE.md
        ↓
detect file type                (AI inline — rules in SKILL.md)
        ↓
AI compresses inline            (tokens — one compression pass)
        ↓
write backup → CLAUDE.original.md
        ↓
write compressed → CLAUDE.md
        ↓
validate deterministically      (zero tokens — scripts/validate.py)
  checks: headings, code blocks, URLs, file paths, bullets
        ↓
if errors: AI targeted fix      (tokens — patch only broken parts)
        ↓
retry up to 2 times
```

AI compresses. Python validates. Best of both: LLM handles prose, deterministic diff catches mistakes.

## What Is Preserved

ecomono compress natural language. It never touch:

- Code blocks (` ``` ` fenced or indented)
- Inline code (`` `backtick content` ``)
- URLs and links
- File paths (`/src/components/...`)
- Commands (`npm install`, `git commit`)
- Technical terms, library names, API names
- Headings (exact text preserved)
- Tables (structure preserved, cell text compressed)
- Dates, version numbers, numeric values

## Why This Matter

`CLAUDE.md` loads on **every session start**. A 1000-token project memory file costs tokens every single time you open a project. Over 100 sessions that's 100,000 tokens of overhead — just for context you already wrote.

ecomono cut that by ~46% on average. Same instructions. Same accuracy. Less waste.

```
┌────────────────────────────────────────────┐
│  TOKEN SAVINGS PER FILE    █████       46% │
│  SESSIONS THAT BENEFIT     ██████████ 100% │
│  INFORMATION PRESERVED     ██████████ 100% │
│  SETUP TIME                █            1x │
└────────────────────────────────────────────┘
```

## Part of Ecomono

This skill is part of the [ecomono](https://github.com/zapatagustin/ecomono) toolkit — making AI use fewer tokens without losing accuracy.

The compression functions it wraps were ported from `@juliusbrussee/caveman-code`, MIT licensed; the terms of that attribution are in [NOTICE.md](../../NOTICE.md). The `caveman-code` repository was frozen 2026-08-14, with development moved to `JuliusBrussee/caveman` — the npm package name stands regardless. The attribution stands either way — it is an obligation, not a courtesy, and it does not lapse when a source goes offline.

- **ecomono** — make AI *speak* like ecomono (cuts response tokens ~65%)
- **ecomono-compress** — make AI *read* less (cuts context tokens ~46%)
