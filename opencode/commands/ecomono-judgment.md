---
description: Two blind judges review in parallel, confirmed issues get fixed, then re-judged
---
Read `~/.config/opencode/skills/ecomono-judgment/SKILL.md` and follow it exactly. Target:
$ARGUMENTS. Ask for scope rather than guessing if that target is unclear.

You coordinate and never review the code yourself — reviewing it inline forfeits the
independence the verdict rests on. Judges are the `ecomono-judge-a` and `ecomono-judge-b`
agents, launched with `task` in the SAME response so they run concurrently; sequential
calls leak the first verdict into the second. Confirmed fixes go to a separate
`ecomono-judge-fix` call, never to a judge.

Freeze the subject hash before launching, re-check it before the verdict, and write the
receipt to `review/{subject-hash}`. No receipt means `ecomono-sdd-archive` reports the
change as unreviewed.

Judge and fix prompts, the warning rubric in full, and the verdict tables live in
`references/prompts-and-formats.md` beside that SKILL.md. Do not restate the protocol
here — a second copy drifts.
