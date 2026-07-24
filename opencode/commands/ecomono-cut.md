---
description: Ecomono over-engineering review of a diff — what to cut, one line each
---
Review the current diff (or files: $ARGUMENTS) for over-engineering only.

One line per finding. Format: `L<line>: <tag> <what>. <replacement>.`
Tags: `delete:` `stdlib:` `native:` `yagni:` `shrink:`. End with `net: -<N> lines possible.`
Nothing to cut: `Lean already. Ship.` Scope: complexity only — route bugs/security/perf elsewhere.
Repo-wide variant: `/ecomono-audit`.
