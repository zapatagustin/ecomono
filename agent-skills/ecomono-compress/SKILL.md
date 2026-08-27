---
name: ecomono-compress
description: >
  Compress natural language memory files (CLAUDE.md, todos, preferences) into ecomono format
  to save input tokens. Preserves all technical substance, code, URLs, and structure.
  Compressed version overwrites the original file. Human-readable backup saved as FILE.original.md.
  Trigger: /ecomono-compress FILEPATH or "compress memory file"
---

# Ecomono Compress

## Purpose

Compress natural language files (CLAUDE.md, todos, preferences) into ecomono-speak to reduce input tokens. All compression runs via local Python — zero session tokens consumed. Optional semantic pass uses cheap Groq API (llama-4-scout, ~2s, cents).

## Trigger

`/ecomono-compress <filepath>` or "compress memory file".

## Skill layout

```
this SKILL.md
scripts/compress.py    — rule-based compressor (+ optional Groq API)
scripts/validate.py    — deterministic validator (pure stdlib)
scripts/__main__.py    — CLI: compress → validate → retry
```

Resolve `<skill_dir>` as the directory containing this SKILL.md. All script paths derive from it.

## Process

Run the CLI orchestrator. No AI inline compression — saves session tokens.

### Step 1: Validate path

Check file exists, is readable, under 500KB. Resolve absolute path.

### Step 2: Quick check

- Extension-based type detection (see Boundaries below)
- Refuse sensitive filenames (`.env*`, `credentials*`, `secrets*`, `*.pem`, `*.key`, etc.)
- Refuse *.original.md files (backups)
- Alert if backup `<filename>.original.md` already exists

### Step 3: Run CLI

```bash
python3 <skill_dir>/scripts/__main__.py --api <resolved_filepath>
```

If Groq API key is not available, omit `--api` for rule-based only:
```bash
python3 <skill_dir>/scripts/__main__.py <resolved_filepath>
```

### Step 4: Handle result

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Compressed + validated | Show summary to user |
| 0 with "skip" | Already compressed or backup | Inform user |
| 1 | Error | Show error, leave file untouched |
| 1 after retries | Validation failed | Original restored from backup |

### Output JSON (exit 0)

```json
{
  "status": "ok",
  "path": "...",
  "backup": "...",
  "original_tokens": 1000,
  "compressed_tokens": 500,
  "tokens_saved": 500,
  "percent": 50.0,
  "used_api": true
}
```

## Compression — what the script does

### Phase 1: Rule-based (always, 0 tokens)

Mechanical transformations applied in order:

1. **Remove filler**: just, really, basically, actually, simply, essentially, generally, literally, honestly, definitely, obviously, etc.
2. **Remove hedging**: "it's worth noting", "you might consider", "it would be good to"
3. **Remove pleasantries**: "sure", "of course", "happy to", "my pleasure", "feel free"
4. **Remove permissive openers**: "you should", "make sure to", "remember to", "please ensure"
5. **Remove connectives**: however, furthermore, moreover, additionally, therefore, thus
6. **Phrase replacements**: "in order to" → "to", "due to the fact that" → "because", "prior to" → "before"
7. **Remove "I prefer/like/want"** → keep just the verb
8. **Word replacements**: "utilize" → "use", "implement" → "build", "facilitate" → "help", "configuration" → "config"
9. **Article removal**: remove "the" where context-safe (sentence-initial + middle)
10. **Cleanup**: collapse multiple spaces, trim

Does NOT modify:
- Code blocks (fenced ``` and ~~~)
- Inline code (`backtick content`)
- URLs, file paths, commands
- Technical terms, proper nouns, version numbers

### Phase 2: Semantic pass (optional, `--api` flag)

Sends rule-compressed text to Groq API (`meta-llama/llama-4-scout-17b-16e-instruct`) for semantic compression. Cheap model, ~2s, cents per run. Preserves the same protected elements.

API key read from: `GROQ_API_KEY` env var → `/run/secrets/opencode/groq-api-key`.

### Validation

After each compression, `scripts/validate.py` checks deterministically:

| Check | Pass condition |
|-------|---------------|
| **Headings** | Count mismatch: warning. Same count but text/order changed: error |
| **Code blocks** | Exact match — content, fence chars, line order |
| **URLs** | Set equality — none lost, none added |
| **Paths** | Lost path-like match: error. Lost idiom/date/numeric match (e.g. "and/or", "2024/01/15", "3/15"): warning. Added path: warning |
| **Inline codes** | No backtick content lost |
| **Bullets** | Count within 15% of original |

Validation failure → re-run compression → max 3 attempts total. Still fails → restore original from backup.

## Boundaries

- ONLY compress: `.md`, `.txt`, `.markdown`, `.rst`, `.typ`, `.typst`, `.tex`, extensionless natural language
- NEVER modify: `.py`, `.js`, `.ts`, `.json`, `.yaml`, `.yml`, `.toml`, `.env`, `.lock`, `.css`, `.html`, `.xml`, `.sql`, `.sh`
- Original backed up as `FILE.original.md` before writing compressed version
- Never compress `*.original.md` files
- Max file size: 500KB
- With `--api`: sensitive filenames (credentials, keys, secrets) are refused before any API send
