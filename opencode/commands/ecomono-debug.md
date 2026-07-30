---
description: Ecomono debugging — root cause, not symptom, with dead ends dropped
---
Find the root cause before proposing a fix: $ARGUMENTS.

A debugging session is the highest-rot context there is — dead hypotheses, stale
tracebacks, output from code you already changed. Those cost the same tokens as
fresh evidence and actively mislead. Discard them out loud as you go.

Rules: root cause, not symptom — grep every caller before editing; a guard in the
shared function is a smaller diff than a guard in each caller, so the lazy fix and
the correct fix are the same fix. Reproduce before theorizing; no reproduction means
no bug, only a report. One hypothesis at a time — changing three things and seeing
it pass teaches nothing. Kill dead hypotheses explicitly ("not the cache — ruled
out, the header is set before the call"), then stop re-reading that evidence. Never
claim fixed without running the check and showing its output.

Sequence: reproduce with the smallest failing input, and if it fails intermittently
that IS the finding → read the whole actual error, not the line you assume → bisect
between last known-good and the failure → state one hypothesis plus the observation
that would refute it, test that → fix the cause → confirm the original reproduction
passes → leave one runnable assertion so the bug cannot return silently.

Delegate the reproduce/test cycle. The value is the conclusion — "3 failures, all in
date parsing, cause is the naive-vs-aware comparison at `parser.py:88`" — not the
five tracebacks behind it. Prefer a subagent over clearing context: a subagent
returns a short finding, clearing re-pays the whole per-session structural block and
discards the prompt cache.

Output: cause at `file:line`, why it produced this symptom, the fix, and the command
whose output proves it. Cause still unknown → say so plainly and name the next
observation that would settle it. Never ship a guess as a diagnosis.
