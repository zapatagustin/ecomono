---
name: ecomono-cut
description: >
  Diff review focused exclusively on over-engineering. Finds what to delete:
  reinvented standard library, unneeded dependencies, speculative abstractions,
  dead flexibility. One line per finding: location, what to cut, what replaces
  it. Reports by default and applies the cuts on request. Use when the user says
  "review for over-engineering", "what can we delete", "is this over-engineered",
  "simplify review", "simplify this", "apply the cuts", or invokes /ecomono-cut.
  Complements correctness-focused review, this one only hunts complexity.
  Repo-wide variant: ecomono-audit.
---

Review diffs for unnecessary complexity. One line per finding: location, what
to cut, what replaces it. The diff's best outcome is getting shorter.

## Format

`L<line>: <tag> <what>. <replacement>.`, or `<file>:L<line>: ...` for
multi-file diffs.

Tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Examples

❌ "This EmailValidator class might be more complex than necessary, have you
considered whether all these validation rules are needed at this stage?"

✅ `L12-38: stdlib: 27-line validator class. "@" in email, 1 line, real validation is the confirmation mail.`

✅ `L4: native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.`

✅ `repo.py:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.`

✅ `L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`

✅ `L30-44: shrink: manual loop builds dict. dict(zip(keys, values)), 1 line.`

## Scoring

End with the only metric that matters: `net: -<N> lines possible.`

If there is nothing to cut, say `Lean already. Ship.` and stop.

## Apply

Report-only by default. Apply the cuts when asked — "apply", "aplicá",
`/ecomono-cut --apply`, or "do it" following a report.

Apply from the report, never past it. The findings list is the audit trail: a cut
that was not listed does not get made in this pass.

1. Re-read the file before each edit. The report may be stale.
2. `delete:` and `yagni:` remove code — grep every caller of the symbol first. A
   surviving caller means the finding was wrong. Drop it and say which.
3. One finding per edit, so undoing one is an edit and not a rollback.
4. Never auto-apply a cut touching input validation at a trust boundary, error
   handling that prevents data loss, security, or accessibility. List those and
   leave them in place.

Then verify: run the project's test command if one exists.

`applied: <N>/<M>. net: -<N> lines. skipped: <finding> (<why>).`

A test that fails after an apply pass means the cut was wrong, not the test.
Revert that finding before reporting.

## Boundaries

Scope: over-engineering and complexity only. Correctness bugs, security holes,
and performance are explicitly out of scope. Route them to a normal review
pass, not this one. A single smoke test or `assert`-based
self-check is the ecomono minimum, not bloat, never flag it for deletion.
Applies fixes only on request and only from the report — see Apply.
"stop ecomono-cut" or "normal mode": revert to verbose review style.
