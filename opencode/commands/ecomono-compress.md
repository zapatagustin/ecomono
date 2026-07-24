Compress a memory file into ecomono format to save input tokens.

Usage: /ecomono-compress FILEPATH

Target: natural-language memory files (CLAUDE.md, AGENTS.md, todos, preferences, notes).
Not for: source code, configs, lockfiles, generated files, anything machine-parsed.

Steps:
1. Read FILEPATH.
2. Back up original to FILEPATH with `.original` inserted before extension
   (e.g. `CLAUDE.md` → `CLAUDE.original.md`). Skip backup if `.original` file already exists.
3. Rewrite FILEPATH in ecomono: drop articles, filler, pleasantries, hedging.
   Fragments OK. Short synonyms. Pattern: [thing] [action] [reason]. [next step].
4. Preserve exact: code blocks, commands, URLs, file paths, error strings,
   API names, function names, env var names, headings, list structure, frontmatter.
5. Report: original size, new size, % saved, backup path.

If FILEPATH missing or unreadable: stop, tell user.
If file looks like code/config (not prose): stop, ask user to confirm.
