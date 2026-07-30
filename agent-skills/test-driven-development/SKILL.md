---
name: test-driven-development
description: >
  Write the failing check before the implementation. Use when implementing a
  feature or a bugfix, and before writing implementation code for non-trivial
  logic — a branch, a loop, a parser, a money or security path. Use when the user
  says "TDD", "write tests first", or asks for tests alongside a change.
---

Red, green, refactor. The failing assertion is the specification: it is the only
artifact that proves the behavior was absent before and present after.

## Hard rules

- The test MUST fail first, for the right reason. A test that passes before the
  implementation tests nothing. Run it and read the failure.
- Never weaken a test to make it pass. If the test is wrong, fix the test
  deliberately and say so; do not tune assertions until green.
- Never claim passing without the command output. Evidence before assertions.
- Test behavior at the boundary, not internals. A test coupled to the
  implementation breaks on every refactor and proves nothing about the contract.

## Scope the check to the risk

| Code | Check |
|---|---|
| Branch, loop, parser, money/security path | Required |
| Trivial one-liner, pure rename, config value | None — YAGNI applies to tests too |
| Bugfix | The reproduction becomes the regression test |

One `assert`-based `demo()`/`__main__` or one minimal `test_*.py`. No frameworks,
no fixtures, no per-function suites unless asked. If the project already has a
test setup, match it — do not introduce a second one.

## Sequence

1. **Name the behavior** in one line. Cannot name it → not ready to test it;
   go back to the design.
2. **Write the assertion** at the boundary. Smallest input that distinguishes
   correct from incorrect.
3. **Run it. Watch it fail.** Confirm the failure message names the missing
   behavior, not a typo or an import error.
4. **Implement the minimum** that turns it green. Not the general case, not the
   configurable version.
5. **Run it. Watch it pass.** Show the output.
6. **Refactor only with the test green**, re-running after each step.

## Delegate the runner

Run the suite in a subagent and take back the verdict. The loop —run, read
failure, edit, run again— dumps a full output every cycle, and the outputs from
before your fix are stale evidence that misleads later reasoning. Keep the failing
assertion and the cause inline; leave the tracebacks in the subagent.

Exception: the single decisive run whose output you must quote as proof stays
inline. Delegate the loop, not the evidence.

## Output

The test, the implementation, and the command output showing red then green. If
you skipped a check, say which and why in one line.
