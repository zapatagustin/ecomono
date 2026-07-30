# Strict TDD — Apply

> Loaded only when strict TDD is enabled **and** a test runner exists. The
> orchestrator already checked both. Follow every instruction.

TDD is not testing. It is **design driven by tests**: the test states what the code
should do, then the minimum code makes it real. Tests design the API, the contracts,
the behaviour. Code is the side effect.

Three laws:

1. No production code until a failing test exists.
2. No more test than is needed to fail.
3. No more code than is needed to pass.

## The cycle, per task

**0. Safety net** — only when modifying existing files. Run the existing tests for
those files and record the baseline (`5/5 passing`). Any already failing → STOP and
report it as a pre-existing failure. Do not fix it; it is not your task, and fixing it
hides whether *you* broke something. The baseline is what proves you did not.

**1. Understand** — the task, then its spec scenarios (your acceptance criteria), then
the design constraints, then the existing code and test patterns. Pick the test layer.

**2. RED — the test first.** Describe the expected behaviour from the spec. The test
must reference production code that does not exist yet, which guarantees failure
without running it. Code already exists → test the *new* behaviour that does not.
Gate: no GREEN until the test is written.

**3. GREEN — minimum code to pass.** Implement only what the failing test needs. Fake
It is valid; a hardcoded return is fine here. Then **execute**. Passing → continue.
Failing → fix the implementation, never the test. Gate: GREEN is confirmed by
execution, not by reading.

**4. TRIANGULATE — required by default.** You need a compelling reason to skip it. Add
a second case with different inputs and outputs; when Fake It breaks, generalise to
real logic. That is the entire point. Repeat until every spec scenario for the task is
covered. Minimum two cases per behaviour: one producing a non-trivial result, one
exercising a different path.

Watch for a GREEN that passes trivially. It is **not** a real GREEN if it passed
because the component was never rendered, because a loop iterated zero times, or
because the setup never triggered the path. A real GREEN means production code ran and
produced the expected output.

Skip triangulation only when all three hold: the task is purely structural (a config
value, a constant, a type export), there is exactly one possible output, and you write
`Triangulation skipped: {reason}` in the evidence table.

**5. REFACTOR — behaviour unchanged.** Extract constants and functions, improve names,
remove duplication, push toward purity. Leave it cleaner than you found it. Execute
after **each** step: still green → safe, continue; red → revert that step and try a
smaller one.

**6.** Mark the task `[x]`. **7.** Note deviations and issues while you still remember
why.

## Test layer

Use the highest available layer that fits. Never skip a task because a layer is
missing — degrade to the next one down.

| The task is | Layer | If unavailable |
|---|---|---|
| Pure logic, utility, calculation, transformation | Unit | — (always available) |
| Component rendering, interaction, state change | Integration | Unit with mocks |
| Multi-component flow, API interaction, provider behaviour | Integration | Unit with mocks |
| Critical business flow, full journey, cross-page | E2E | Integration, then unit |

## Running tests

Take the command from the cached testing capabilities
(`test_runner.command`), falling back to detection from `package.json`,
`pyproject.toml`, `go.mod`.

Run **only the relevant test file** during the cycle — `vitest run src/utils/tax.test.ts`,
`pytest path/test_x.py`, `go test ./pkg/... -run TestName`. The cycle has to stay fast
to be usable. Full-suite runs belong to `ecomono-sdd-verify`, not here.

Runner fails for infrastructure reasons rather than test failures → report `Blocked`
and move to the next task. Do not spend the batch fighting the environment.

## Prefer pure functions

```ts
// prefer — deterministic, trivially testable
function calculateDiscount(price: number, quantity: number): number {
  return quantity >= 5 ? price * quantity * 0.1 : 0
}

// avoid — two side effects, needs the world set up to test at all
function calculateDiscount(item: Item) {
  globalState.lastDiscount = item.price * 0.1
  updateDOM()
  return globalState.lastDiscount
}
```

TDD pushes you toward purity on its own. Follow it, but do not force it where it does
not fit — a stateful component is not a design failure.

## Refactoring existing code

Before touching production code, write **approval tests** that capture what it does
*now*: known inputs, assert the current outputs even when they are ugly or wrong. Run
them — they must pass, since they describe current reality. Then refactor, and run
them again. Still passing → behaviour preserved. Failing → the refactor broke
something; revert.

When the spec says behaviour should *change*, update the approval test to the new
expectation first. It fails — that is your RED — then implement.

## Assertion quality

**Every assertion must verify real behaviour. A test that passes without exercising
production logic is worse than no test, because it manufactures confidence.**

A real assertion satisfies all three:

1. It **calls production code** — a function, method or component from the
   implementation.
2. It **asserts a specific output** — a concrete value derived from the spec.
3. It **would fail if the production code were wrong.** Change the logic, this test
   breaks.

```ts
expect(calculateDiscount(100, 10)).toBe(10)                    // real input -> real output
expect(screen.getByText('Welcome, John')).toBeInTheDocument()  // rendered from data
assert result[0].status == "FAIL"                              // specific finding
assert response.status_code == 403                             // real response
```

### Banned

```ts
expect(true).toBe(true)               // tautology — no production code involved
assert 1 == 1                         // always passes
expect(result).toBeDefined()          // alone: proves existence, not behaviour
expect(result).not.toBeNull()         // alone: assert the actual value
expect(typeof result).toBe('object')  // alone: what is in it?
```

**Empty collections.** `expect(result).toEqual([])` is valid only when you set up a
precondition that *should* produce empty, production code actually ran and filtered to
get there, and a companion test with different setup produces non-empty. Cannot
explain *why* it is empty from the setup → the assertion is trivial.

**Ghost loops.** An assertion inside a loop that never iterates is dead code that
reports success:

```ts
const items = screen.queryAllByTestId("item")  // []
for (const item of items) {
  expect(item).toHaveTextContent("value")      // never executes
}

expect(items).toHaveLength(3)                  // fix: prove they exist first
for (const item of items) { /* now it runs */ }
```

**Smoke tests are not tests.** "Renders without crashing" proves nothing about
behaviour and counts toward nothing:

```tsx
render(<MyComponent data={mockData} />)
expect(screen.getByTestId("wrapper")).toBeInTheDocument()   // only proves it mounted

expect(screen.getByText("Expected Title")).toBeInTheDocument()  // proves what it did
expect(screen.getByRole("button")).toHaveTextContent("Submit")
```

### Mock hygiene

**More mocks than assertions means you are testing at the wrong level.**

| Mocks in a test file | Verdict |
|---|---|
| ≤ 3 | Healthy, focused |
| 4–6 | Consider extracting the logic to a pure function |
| 7+ | Stop. Extract to a pure function, or move to a layer where the dependencies are real |

**Extract before mocking.** If the behaviour is a transformation, mapping, filter or
conditional, extract it and test it directly:

```ts
// 15 mocks to check a one-line status conversion
vi.mock("next/navigation", ...); vi.mock("next/link", ...); /* 13 more */
render(<StatusCell row={mutedRow} />)
expect(screen.getByText("FAIL")).toBeInTheDocument()

// same coverage, zero mocks
export function resolveDisplayStatus(status: string, isMuted: boolean): string {
  return status === "MUTED" ? "FAIL" : status
}
expect(resolveDisplayStatus("MUTED", true)).toBe("FAIL")
expect(resolveDisplayStatus("PASS", false)).toBe("PASS")
```

### Test behaviour, not internals

```ts
expect(element.className).toContain("text-xs")   // breaks on any style refactor
expect(mockService.mock.calls.length).toBe(3)    // why 3? brittle
expect(component.state.isLoading).toBe(true)     // internal state, not behaviour

expect(screen.getByText("Error: Payment failed")).toBeInTheDocument()
expect(screen.getByRole("alert")).toHaveTextContent("Risk:")
expect(screen.getByRole("button")).toBeDisabled()
```

**CSS class assertions are never valid.** To verify styling, assert the semantic
outcome (`role="alert"`, text visible, button disabled), or use visual regression.
Never assert Tailwind class names — they are implementation detail, and the test will
fail on a refactor that changed nothing a user can see.

## Evidence, in your return summary

```markdown
### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 1.1 | `path/test.ext` | Unit | 5/5 | Written | Passed | 3 cases | Clean |
| 1.2 | `path/test.ext` | Integration | N/A (new) | Written | Passed | Single | Clean |

### Test Summary
- Tests written / passing: {N} / {N}
- Layers: Unit {N}, Integration {N}, E2E {N}
- Approval tests: {N} or "None — no refactoring tasks"
- Pure functions created: {N}
```

**Safety Net** — pre-existing tests run before modifying; `N/A (new)` for new files.
**RED** — test written first against code that did not exist. **GREEN** — executed and
passing; show the result. **TRIANGULATE** — extra cases that forced real logic;
`Single` when the spec has one scenario. **REFACTOR** — improved with tests still
green; `None needed` when it was already clean.

A task completed without a test written first is marked **FAILED** here. Report it
honestly — verify checks this table, and a fabricated row is the one failure mode that
makes every other check meaningless.
