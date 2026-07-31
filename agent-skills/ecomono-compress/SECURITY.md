# Security

## Architecture

`ecomono-compress` runs two phases invoked via `scripts/__main__.py`: Phase 1 is a local,
no-network process; Phase 2, opt-in only, makes a real external HTTP call.

1. **Phase 1 — rule-based (default, always runs)** — `scripts/compress.py` applies mechanical
   regex transformations (filler removal, phrase replacement, article removal, etc.) entirely
   in-process. No network access, no credentials, no session tokens consumed.
2. **Phase 2 — semantic pass (optional, `--api` flag only)** — `compress.py`'s
   `call_semantic_api()` sends the Phase-1-compressed text as a prompt to the Groq API
   (`https://api.groq.com/openai/v1/chat/completions`, model
   `meta-llama/llama-4-scout-17b-16e-instruct`) and uses the returned completion as the final
   compressed output. This is a real external API call and does transmit file content off the
   machine.
3. **Python validates deterministically** — `scripts/validate.py` (pure stdlib) diffs original
   vs compressed for code block integrity, URLs, headings, file paths, bullet-count drift, and
   inline code spans, regardless of which phase(s) ran.

The no-network guarantee is code-enforced, not a convention: `call_semantic_api()` calls
`_read_api_key()` first and raises before constructing any request if no key is found — no
`urlopen` happens either way. SKILL.md's Step 3 first command passes `--api` unconditionally,
so the flag alone does not gate the network call; the absent key does.

## Credentials (Phase 2 only)

When `--api` is passed, `_read_api_key()` reads a Groq API key from, in order:

1. `GROQ_API_KEY` environment variable
2. `/run/secrets/opencode/groq-api-key` file

If neither is present, the semantic call raises and the CLI falls back to the Phase 1
rule-based result — no request is sent without a key.

## What the skill does

- Reads the file path the user explicitly provides
- Reads the file content
- Phase 1 (always): compresses that content locally, no network
- Phase 2 (only with `--api`): sends the Phase-1 output — not the raw original file — to the
  Groq chat completions API over HTTPS, using the credential above
- Writes a compressed version and `.original.md` backup

## What the skill does NOT do

- Does not execute user file content as code
- Without `--api`, does not make any network request
- With `--api`, only ever contacts the Groq chat completions endpoint — no other host,
  no telemetry, no analytics
- Does not use shell=True or string interpolation
- Does not access files outside the path the user provides
- Does not send file content to the API if `is_sensitive()` matches the filename (`.env`,
  `credentials`, `secrets`, `*.pem`, `*.key`, tokens containing `secret`/`password`/`apikey`/etc.)
  — `compress_file()` refuses with an error before any API call in that case

## File size limit

Files larger than 500KB are rejected before any tool calls.
