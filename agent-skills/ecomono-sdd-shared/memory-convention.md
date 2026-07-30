# Artifact Convention

Reference, not required reading. The `mem_search` / `mem_get_observation` /
`mem_save` calls a phase actually needs are inlined in its own `SKILL.md`. This
file exists so the naming stays deterministic across phases that never read each
other's code.

## Naming

Deterministic, because the next phase searches by exact key rather than guessing:

```
title:     sdd/{change-name}/{artifact-type}
topic_key: sdd/{change-name}/{artifact-type}
type:      architecture
project:   {detected or current project}
scope:     project
```

`topic_key` is what makes a re-run an upsert instead of a second competing copy.

**No `capture_prompt` flag.** The retired Go engram accepted one on `mem_save`, so
an automated pipeline write would not also record the user's in-flight prompt. Here
prompt capture belongs to the host adapter — one row per message, written
independently of any save — so no save-time side effect remains for a flag to switch
off. Old engram documentation still shows it; do not reintroduce it.

## Artifact types

| Type | Produced by | Holds |
|---|---|---|
| `explore` | `ecomono-sdd-explore` | Investigation, options compared |
| `proposal` | `ecomono-sdd-propose` | Intent, scope, approach |
| `spec` | `ecomono-sdd-spec` | Delta specs, all domains concatenated |
| `design` | `ecomono-sdd-design` | Technical design and decisions |
| `tasks` | `ecomono-sdd-tasks` | Ordered breakdown |
| `apply-progress` | `ecomono-sdd-apply` | Cumulative implementation state |
| `verify-report` | `ecomono-sdd-verify` | Verification result |
| `archive-report` | `ecomono-sdd-archive` | Closure and lineage (all observation IDs) |
| `state` | orchestrator | DAG state, for recovery after compaction |

One key per type per change. A phase inventing a new type strands its output —
nothing downstream searches for it.

## Reading

Two steps, always. `mem_search` returns a truncated preview; the preview is not the
artifact, and a phase built on one produces confidently wrong output.

```
mem_search(query: "sdd/{change-name}/{artifact-type}", project: "{project}")  -> preview + id
mem_get_observation(id: {id})                                                 -> full content
```

Several artifacts: batch all searches, then batch all retrievals. Sequential
round-trips cost turns, and every turn re-reads the whole prefix.

Project context lives at `ecomono-sdd-init/{project}`, read the same way. Browse a
whole change with `mem_search(query: "sdd/{change-name}/")`.

## Writing

`mem_save` with the same `topic_key` upserts. `mem_update(id, content)` when you
already hold the exact ID.

```
mem_save(
  title:     "sdd/add-dark-mode/proposal",
  topic_key: "sdd/add-dark-mode/proposal",
  type:      "architecture",
  project:   "my-app",
  content:   "## Proposal\n\nAdd dark mode toggle..."
)
```

**Upsert overwrites.** Same `topic_key` + `project` + `scope` replaces the previous
content with no revision history. Deliberate — memory is working state, not an audit
trail — but it means this store cannot answer "what did the first draft say". If you
need that, the answer is git on real deliverables, not a second artifact store.

## Project resolution

Detected from the working directory's git remote, falling back to the repo root's
basename, then the directory name. There is no `--project` flag and no env override:
the Go engram had both, this implementation has neither. Pass `project` explicitly on
a call to target another one, or `mem_current_project` to see what was detected.

Saving under a name that does not match existing observations creates a *second
project* rather than warning about drift — a silent split, not an error. Fold one
into the other with `mem_merge_projects`; there is no CLI for it.

## Stale context

A memory flagged `needs_review` is stale context, not a trusted fact. Surface it and
verify against current evidence before building on it. Never call `mem_review` with
`mark_reviewed` automatically — only after explicit user confirmation or from a
dedicated maintenance command; marking unread memory as reviewed is worse than
leaving it flagged.

When lifecycle tooling is available, list with `mem_review` at session start or
before architecture-sensitive work. When it is not, do not fail: continue with
`mem_context`/`mem_search` and honour lifecycle metadata on whatever comes back.

The same discipline applies to superseded artifacts. A design that a later phase
replaced costs exactly what the current one costs and describes code that has since
changed. Name it superseded, then stop citing it.
