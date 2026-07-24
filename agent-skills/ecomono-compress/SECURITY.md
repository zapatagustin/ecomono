# Security

## Architecture

`ecomono-compress` uses a hybrid architecture:

1. **AI compresses inline** — the LLM already in your session compresses prose using tool calls (Read, Write). No separate API calls.
2. **Python validates deterministically** — `scripts/validate.py` (pure stdlib) diffs original vs compressed for code block integrity, URLs, and headings.

No credentials, no external API keys, no separate API calls. The compression happens within the existing session context.

## What the skill does

- Reads the file path the user explicitly provides
- Reads the file content
- Writes a compressed version and `.original.md` backup

## What the skill does NOT do

- Does not execute user file content as code
- Does not make network requests to any external API
- Does not use shell=True or string interpolation
- Does not access files outside the path the user provides
- Does not collect or transmit any data

## File size limit

Files larger than 500KB are rejected before any tool calls.
