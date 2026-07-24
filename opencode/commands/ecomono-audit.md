---
description: Ecomono over-engineering audit of the whole repo — ranked list of what to cut
---
Audit the whole repo (or path: $ARGUMENTS) for over-engineering. Scan the tree, not a diff.

One line per finding, ranked biggest cut first: `<tag> <what to cut>. <replacement>. [path]`.
Tags: `delete:` `stdlib:` `native:` `yagni:` `shrink:`. End with `net: -<N> lines, -<M> deps possible.`
Nothing to cut: `Lean already. Ship.` Scope: complexity only — route bugs/security/perf elsewhere.
Lists findings, applies nothing.
