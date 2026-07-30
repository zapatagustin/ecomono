# Verify report format

The template `ecomono-sdd-verify` returns, and what its status values mean.

## Compliance status

A scenario's status is decided by **what a test did at runtime**, never by reading the
implementation:

| Status | Means |
|---|---|
| `COMPLIANT` | A covering test exists and passed |
| `FAILING` | A covering test exists and failed |
| `UNTESTED` | No covering test found |
| `PARTIAL` | The test passed but covers only part of the scenario |

`UNTESTED` and `PARTIAL` are the two that get talked away. Neither is a pass: untested
behaviour is unverified whatever the code looks like, and a partial cover is the shape of
a test written to the implementation rather than to the scenario.

## Template

~~~markdown
## Verification Report

**Change**: {change-name}
**Mode**: {Strict TDD | Standard}

### Completeness
| Metric | Value |
|---|---|
| Tasks total | {N} |
| Tasks complete | {N} |
| Tasks incomplete | {N} |

### Execution
Include the command and its output, not a verdict about it. A claim with no output is an
opinion.

**Build**: {passed | failed}
```text
{command and relevant output}
```

**Tests**: {N} passed, {N} failed, {N} skipped
```text
{command and failure detail}
```

**Coverage**: {N}% against threshold {N}% → {above | below | not available}

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| {REQ-01} | {scenario} | `{file} > {test}` | COMPLIANT |
| {REQ-02} | {scenario} | (none found) | UNTESTED |

**Compliance**: {N}/{total} scenarios

### Delta Completeness
Per `MODIFIED` requirement: the delta's scenario count against the current main spec.
Fewer in the delta is CRITICAL — archive replaces the requirement wholesale, so the
omitted scenarios would be deleted from the baseline with no history behind them.

| Capability | Requirement | Main spec | Delta | Result |
|---|---|---|---|---|
| `user-auth` | Session Expiration | 4 | 5 | ok |
| `user-auth` | Token Refresh | 6 | 3 | CRITICAL — 3 dropped, not declared REMOVED |

### Correctness (static evidence)
| Requirement | Status | Notes |
|---|---|---|

Static evidence supports a verdict; it never establishes one on its own.

### Coherence (design)
| Decision | Followed | Notes |
|---|---|---|

### Skipped
{Every dimension you could not check, and why. "None" only when you checked all of them.}

### Issues
**CRITICAL**: {list or None}
**WARNING**: {list or None}
**SUGGESTION**: {list or None}

### Verdict
{PASS | PASS WITH WARNINGS | FAIL} — {one line}
~~~

## Notes

**Skipped is not optional.** A report that omits its own blind spots reads as complete, and
the orchestrator archives on it. Name what you could not check even when the answer is
awkward.

Strict TDD active → insert the TDD compliance, test layer distribution, changed-file
coverage and quality metrics sections from
[strict-tdd-verify.md](../strict-tdd-verify.md).

Coverage and quality metrics never reach CRITICAL. Unchecked implementation tasks,
`FAILING` and `UNTESTED` scenarios, and a short delta always do.
