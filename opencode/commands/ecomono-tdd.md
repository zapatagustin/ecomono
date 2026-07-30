---
description: Ecomono TDD — failing assertion first, red then green, loop delegated
---
Implement with the check first: $ARGUMENTS.

The failing assertion is the specification — the only artifact proving the behavior
was absent before and present after.

Rules: the test MUST fail first for the right reason; run it and read the failure.
Never weaken a test to make it pass — wrong test gets fixed deliberately and said
out loud. Never claim passing without the command output. Test behavior at the
boundary, not internals; a test coupled to the implementation breaks on every
refactor and proves nothing about the contract.

Scope to the risk: branch, loop, parser, money/security path → required. Trivial
one-liner, rename, config value → none, YAGNI applies to tests too. Bugfix → the
reproduction becomes the regression test. One `assert`-based `demo()`/`__main__` or
one minimal `test_*.py`. No frameworks, no fixtures. Project already has a test
setup → match it, never introduce a second.

Sequence: name the behavior in one line → write the boundary assertion → run it,
watch it fail, confirm the message names the missing behavior and not a typo →
implement the minimum that turns it green → run it, watch it pass, show output →
refactor only with the test green.

Delegate the runner and take back the verdict: the loop dumps a full output every
cycle and the pre-fix ones are stale evidence that misleads later reasoning. Keep
the failing assertion and the cause inline. Exception: the single decisive run you
must quote as proof stays inline — delegate the loop, not the evidence.

Output: test, implementation, command output showing red then green. Skipped a
check? Say which and why in one line.
