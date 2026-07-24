---
description: Harvest ecomono: shortcut markers into a debt ledger
---
Harvest every `ecomono:` comment in the repo (or path: $ARGUMENTS) into a debt ledger.

Scan: `grep -rnE '(#|//) ?ecomono:' .` (skip node_modules, .git, build output).
One row per marker, grouped by file: `<file>:<line>, <what was simplified>. ceiling: <limit>. upgrade: <trigger>.`
Flag any marker with no upgrade path as `no-trigger`. End with `<N> markers, <M> with no trigger.`
Nothing found: `No ecomono: debt. Clean ledger.` Reads only, changes nothing.
