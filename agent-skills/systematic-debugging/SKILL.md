---
name: systematic-debugging
description: >
  Find the root cause before proposing a fix. Use on any bug, test failure,
  crash, wrong output, or unexpected behavior, and before editing the code that
  looks guilty. Use when the user says "this is broken", "why does this fail",
  "debug this", or pastes an error. Fixes the cause, never the symptom.
---

A debugging session is the highest-rot context there is: dead hypotheses, stale
tracebacks, output from code you already changed. Those cost the same tokens as
fresh evidence and actively mislead. Discard them out loud as you go.

## Hard rules

- **Root cause, not symptom.** Grep every caller before editing. A guard in the
  shared function is a smaller diff than a guard in each caller — the lazy fix
  and the correct fix are the same fix.
- **Reproduce before theorizing.** No reproduction means no bug, only a report.
- **One hypothesis at a time.** Changing three things and seeing it pass teaches
  nothing about which one mattered.
- **Kill dead hypotheses explicitly.** Write "not the cache — ruled out, the
  header is set before the call". Then stop re-reading that evidence.
- Never claim fixed without running the check and showing its output.

## Sequence

1. **Reproduce.** Smallest input that fails. If it fails intermittently, that IS
   the finding — name it before hunting further.
2. **Read the actual error.** The whole trace, the real line. Not the line you
   assume.
3. **Bisect the distance** between the last known-good state and the failure:
   git history, an input that works, a call that returns correctly.
4. **State one hypothesis** and the observation that would refute it. Test that.
5. **Fix the cause.** Then confirm the reproduction from step 1 now passes.
6. **Leave the check.** Non-trivial logic gets one runnable assertion so the bug
   cannot return silently.

## Delegate the loop

Run the test/build/reproduce cycle in a subagent. The value is the conclusion —
"3 failures, all in date parsing, cause is the naive-vs-aware comparison at
`parser.py:88`" — not the five tracebacks that produced it. Each cycle run inline
lands another traceback in context permanently, and the ones from before your fix
are the misleading kind.

Prefer a subagent over clearing context: a fresh subagent returns a short
finding, while clearing re-pays the whole per-session structural block and throws
away the prompt cache.

## Output

The cause at `file:line`, why it produced this symptom, the fix, and the command
whose output proves it. If the cause is still unknown, say that plainly and name
the next observation that would settle it — never ship a guess as a diagnosis.
