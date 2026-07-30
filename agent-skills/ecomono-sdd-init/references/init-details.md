# Init details

Detection checklist and payload shapes for `ecomono-sdd-init`.

## What to look for

**Test runner** — `package.json` scripts and deps, `pyproject.toml`, `pytest.ini`,
`go.mod`, `Cargo.toml`, `Makefile`. Capture the **exact command**, not just the framework
name: `apply` and `verify` run it, and "uses vitest" is not runnable.

**Test layers**

| Layer | Signals |
|---|---|
| Unit | The runner itself |
| Integration | `testing-library`, `httpx`, `httptest`, `WebApplicationFactory` |
| E2E | `playwright`, `cypress`, `selenium`, `chromedp` |

**Coverage** — `vitest --coverage`, `jest --coverage`, `c8`, `pytest-cov`,
`go test -cover`, `coverlet`.

**Quality** — linter, type checker, formatter, with their commands.

Record what is **absent** as clearly as what is present. A missing coverage tool is a fact
`verify` needs; an unmentioned one becomes a phase looking for something that was never
there.

## Skill registry

Do not re-derive the scan. Run the generator:

```
node ~/.claude/hooks/ecomono-skill-registry.js --cwd <repo>
```

It walks the skill roots, reads frontmatter, skips anything marked
`disable-model-invocation`, dedupes by name preferring project-level, and writes
`.atl/skill-registry.md`. It also runs on every user prompt, so an empty or stale registry
usually means malformed frontmatter rather than a generator that never ran.

Describing its rules here would create a second copy of them with nothing keeping the two
equal. The generator is the source of truth; `--selftest` covers its parser.

Also worth scanning for project conventions, which the registry does not cover:
`AGENTS.md`, project-level `CLAUDE.md`, `.cursorrules`. When one of these is an index,
follow its referenced paths and record both the index and what it points at.

## Memory writes

```text
mem_save  topic_key: ecomono-sdd-init/{project}
          type: architecture
          content: detected project context

mem_save  topic_key: sdd/{project}/testing-capabilities
          type: config
          content: the table below

mem_save  topic_key: skill-registry
          type: config
          content: the generated registry
```

## Testing capabilities format

```markdown
## Testing Capabilities

**Strict TDD**: {enabled | disabled} — {the signal that decided}
**Detected**: {date}

### Runner
- Command: `{command}`
- Framework: {name}

### Layers
| Layer | Available | Tool |
|---|---|---|
| Unit | yes/no | {tool or —} |
| Integration | yes/no | {tool or —} |
| E2E | yes/no | {tool or —} |

### Coverage
- Available: yes/no
- Command: `{command or —}`

### Quality
| Tool | Available | Command |
|---|---|---|
| Linter | yes/no | {command or —} |
| Type checker | yes/no | {command or —} |
| Formatter | yes/no | {command or —} |
```

Strict TDD carries the deciding signal on the same line. `enabled` alone gives the user
nothing to act on; `enabled — vitest detected, no explicit preference set` tells them
where the switch is.

## Output

Report project, stack, persistence mode, strict TDD with its signal, the capabilities
table, the observation IDs saved, the registry path, and the next step.

Then name the mode's ceiling, since the user chose it once and will not be asked again:

- `ecomono-memory` — artifacts are local and not shareable, and a re-run of a phase
  overwrites its previous artifact with no history.
- `none` — nothing survives compaction or session end. Recommend enabling the backend, and
  keep changes small enough to finish in one context.

Anything you could not detect goes in `risks`, named. A silent gap here becomes a
confident wrong assumption in every phase that follows.
