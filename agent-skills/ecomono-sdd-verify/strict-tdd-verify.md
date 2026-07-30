# Strict TDD — Verify

> Loaded only when strict TDD is enabled **and** a test runner exists. The
> orchestrator already checked both.

Standard verification asks whether the code works. This asks whether it was **built
correctly** — whether TDD was actually followed. Apply reports its evidence; your job
is to check that evidence against reality, not to take it at face value. A report is a
claim.

## Evidence check

Read `apply-progress` and find the **TDD Cycle Evidence** table. No table → **CRITICAL**:
strict TDD was active and apply did not follow the protocol. Stop treating the rest of
its report as trustworthy.

Per row:

| Column | Check | Flag |
|---|---|---|
| RED | The named test file exists in the codebase | CRITICAL if missing |
| GREEN | That test file **passes when you run it** | CRITICAL if it fails now — it was never green |
| TRIANGULATE | `N cases` → N distinct cases exist in the file. `Single` → the spec really has one scenario | WARNING if the spec has several and only one case exists |
| Safety Net | `N/N` → baseline was captured. `N/A (new)` → the file really was new | WARNING if the file was modified but shows `N/A` |
| REFACTOR | Subjective. Trust the report | — |

Report `{N}/{total} tasks have complete TDD evidence`.

Cross-referencing is the point. A row claiming GREEN for a test that fails today is
either a fabrication or a regression, and both matter more than anything else in the
report.

## Test layer distribution

Classify every test file this change created or modified:

| Layer | Indicators |
|---|---|
| Unit | No `render()`, no `page.`, no HTTP; dependencies mocked |
| Integration | `render()`, `screen.`, `userEvent.`, testing-library imports |
| E2E | `page.goto()`, playwright/cypress imports, browser context |
| Unknown | Cannot classify — report as-is |

Report counts per layer and total. Then cross-reference against the cached
capabilities: integration or E2E tests present but the tooling was never detected →
WARNING, because one of the two is wrong.

Note which layer covers each spec scenario. Critical business logic covered only by
unit tests, where integration or E2E tooling *is* available → SUGGESTION.

## Changed-file coverage

Coverage tool available → run it, then filter to **only** the files in
apply-progress's `Files Changed` table. Whole-project coverage answers a question
nobody asked.

Per file report the path, line coverage, branch coverage when available, and the
**specific uncovered line ranges** — a percentage alone gives nobody anything to act
on. Then the aggregate across changed files.

| Coverage | Flag |
|---|---|
| ≥ 95% | Excellent |
| ≥ 80% | Acceptable |
| < 80% | WARNING, with the uncovered lines listed |

No coverage tool → `Coverage analysis skipped — no coverage tool detected`. That is
not a failure. Never flag absent tooling as a defect.

## Quality metrics

Only on changed files, only when the tooling exists.

- Linter → errors are WARNING, warnings are SUGGESTION.
- Type checker → usually whole-project; filter its output to changed files. Type
  errors are WARNING.
- Neither → `Quality metrics skipped — no tools detected`.

Coverage and quality are **informational, never blocking**. They never reach CRITICAL.

## Assertion quality audit

**Mandatory.** Trivial tests are worse than missing tests: a gap is visible, a
tautology reports success.

The canonical list of banned patterns and what makes an assertion real lives in
[../ecomono-sdd-apply/strict-tdd.md](../ecomono-sdd-apply/strict-tdd.md#assertion-quality).
Audit against that list, not a second copy — if the two drift, apply writes tests you
then reject for following its own instructions.

Scan every test file this change touched and classify what you find:

| Finding | Severity |
|---|---|
| Tautology (`expect(true).toBe(true)`, `assert True`) | **CRITICAL** — proves nothing |
| Assertion that never calls production code | **CRITICAL** — exercises nothing |
| Ghost loop: assertions inside a loop over a possibly-empty collection | **CRITICAL** — always passes |
| Test passing because preconditions stop the code path running | **CRITICAL** — e.g. asserting a component's behaviour when it is never rendered |
| Empty-collection assertion with no companion non-empty test | WARNING |
| Type-only assertion (`toBeDefined`, `not.toBeNull`) with no value assertion | WARNING |
| Smoke-test only: `render()` + `toBeInTheDocument()`, no behavioural assertion | WARNING |
| Implementation coupling: CSS classes, internal state, mock call counts | WARNING |
| Mock-heavy: `vi.mock()` count more than 2× the `expect()` count | WARNING — wrong layer |

Type-only assertions are fine when combined with a value assertion in the same test.
Judge the test, not the line.

Also judge triangulation quality:

- One case for a behaviour whose spec has several scenarios → WARNING,
  `Insufficient triangulation for {behavior}`.
- All cases asserting the same shape of value — every one checking an empty array →
  WARNING, `No variance in test expectations`. A well-triangulated behaviour asserts
  *different* expected values; that variance is what forced real logic.

## Report sections

```markdown
### TDD Compliance
{N}/{total} tasks with complete evidence. {CRITICAL/WARNING counts}

### Test Layer Distribution
Unit {N} · Integration {N} · E2E {N} · Total {N}

### Changed File Coverage
| File | Lines | Branches | Uncovered |
|---|---|---|---|

### Assertion Quality
| File | Line | Assertion | Issue | Severity |
|---|---|---|---|---|
| `path/test.ts` | 15 | `expect(true).toBe(true)` | Tautology — proves nothing | CRITICAL |

**Assertion quality**: {N} CRITICAL, {N} WARNING

### Quality Metrics
Linter: {result} · Type checker: {result}
```

Zero assertion issues → `**Assertion quality**: all assertions verify real behaviour`.

## Rules

- The evidence table is the primary artifact. Check it first.
- Never trust a reported test file without running it.
- Run the assertion audit every time. It is the check that catches a green suite
  proving nothing.
- Missing evidence table → CRITICAL. Tautologies → CRITICAL. Both mean the protocol
  was not followed, whatever the summary says.
- Coverage, quality metrics and layer distribution never block. WARNING and SUGGESTION
  only.
- Absent tooling is reported cleanly and never counted as a failure.
- Do not fix anything. Report; the orchestrator decides.
