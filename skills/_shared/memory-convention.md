# ecomono-memory Artifact Convention (reference documentation)

NOTE: Critical ecomono-memory calls (`mem_search`, `mem_save`, `mem_get_observation`) are inlined directly in each skill's SKILL.md. This document is supplementary reference — sub-agents do NOT need to read it to function.

## Naming Rules

ALL SDD artifacts persisted to ecomono-memory MUST follow this deterministic naming:

```
title:     sdd/{change-name}/{artifact-type}
topic_key: sdd/{change-name}/{artifact-type}
type:      architecture
project:   {detected or current project name}
scope:     project
```

There is no `capture_prompt`. The Go engram took it on `mem_save` to keep automated pipeline writes from also recording the user's in-flight prompt; here prompt capture is the host adapter's job — one row per message, written independently of any save — so there is no save-time side effect left for a flag to switch off. Don't reintroduce it from older engram documentation.

### Artifact Types

| Artifact Type | Produced By | Description |
|---------------|-------------|-------------|
| `explore` | sdd-explore | Exploration analysis |
| `proposal` | sdd-propose | Change proposal |
| `spec` | sdd-spec | Delta specifications (all domains concatenated) |
| `design` | sdd-design | Technical design |
| `tasks` | sdd-tasks | Task breakdown |
| `apply-progress` | sdd-apply | Implementation progress (one per batch) |
| `verify-report` | sdd-verify | Verification report |
| `archive-report` | sdd-archive | Archive closure with lineage |
| `state` | orchestrator | DAG state for recovery after compaction |



### State Artifact

```
mem_save(
  title: "sdd/{change-name}/state",
  topic_key: "sdd/{change-name}/state",
  type: "architecture",
  project: "{project}",
  content: "change: {change-name}\nphase: {last-phase}\nartifact_store: ecomono-memory\nartifacts:\n  proposal: true\n  specs: true\n  design: false\n  tasks: false\ntasks_progress:\n  completed: []\n  pending: []\nlast_updated: {ISO date}"
)
```

Recovery: `mem_search("sdd/{change-name}/state")` → `mem_get_observation(id)` → parse YAML → restore state.

## Recovery Protocol (2 steps)

Memory lifecycle rule (when ecomono-memory exposes lifecycle metadata/tooling):
- At session start or before architecture-sensitive work, call `mem_review` with action `list` for the current project when the tool is available.
- If `mem_review` is unavailable, do not fail the task. Continue with normal `mem_context`/`mem_search`, and still apply lifecycle metadata from any returned observations when present.
- `active` memories may be used normally.
- `needs_review` memories are stale context, not trusted facts.
- Surface `needs_review` context and verify it against current evidence before relying on it.
- Do NOT call `mem_review` with action `mark_reviewed` automatically. Only call `mark_reviewed` after explicit user confirmation or through a dedicated memory maintenance command.

```
Step 1: mem_search(query: "sdd/{change-name}/{artifact-type}", project: "{project}") → truncated preview + ID
Step 2: mem_get_observation(id: {observation-id}) → complete content
```

When retrieving multiple artifacts, group all searches first, then all retrievals:

```
STEP A — SEARCH (get IDs only):
  mem_search(query: "sdd/{change-name}/proposal", ...) → save ID
  mem_search(query: "sdd/{change-name}/spec", ...) → save ID
  mem_search(query: "sdd/{change-name}/design", ...) → save ID

STEP B — RETRIEVE FULL CONTENT (mandatory):
  mem_get_observation(id: {proposal_id})
  mem_get_observation(id: {spec_id})
  mem_get_observation(id: {design_id})
```

Loading project context:
```
mem_search(query: "sdd-init/{project}", project: "{project}") → get ID
mem_get_observation(id) → full project context
```

## Writing Artifacts

Standard write:
```
mem_save(
  title: "sdd/{change-name}/{artifact-type}",
  topic_key: "sdd/{change-name}/{artifact-type}",
  type: "architecture",
  project: "{project}",
  content: "{full markdown content}"
)
```

Concrete example — saving a proposal for `add-dark-mode`:
```
mem_save(
  title: "sdd/add-dark-mode/proposal",
  topic_key: "sdd/add-dark-mode/proposal",
  type: "architecture",
  project: "my-app",
  content: "## Proposal\n\nAdd dark mode toggle..."
)
```

Update existing artifact (when you have the observation ID):
```
mem_update(id: {observation-id}, content: "{updated full content}")
```

Use `mem_update` when you have the exact ID. Use `mem_save` with same `topic_key` for upserts.

### Browsing All Artifacts for a Change

```
mem_search(query: "sdd/{change-name}/", project: "{project}")
→ Returns all artifacts for that change
```

## Project Name Resolution

The project name is detected from the git remote of the working directory, falling back to the repository root's basename and then to the directory name. There is no `--project` flag and no env override: the Go engram had both, the native implementation has neither. Pass `project` explicitly on a tool call to target a different one, or call `mem_current_project` to see what was detected.

Saving under a name that does not match existing observations creates a second project rather than warning about drift. Use `mem_merge_projects` to fold one into the other; there is no CLI.

## Upsert Behavior

Same `topic_key` + `project` + `scope` → UPDATE (overwrite), not INSERT. Previous content is lost and no revision history is kept. This is by design — memory is working state, not an audit trail. For iteration history or team collaboration, use `openspec` or `hybrid` mode.

## Why This Convention

- Deterministic titles → recovery works by exact match
- `topic_key` → enables upserts without duplicates
- `sdd/` prefix → namespaces all SDD artifacts
- Two-step recovery → search previews are always truncated; `mem_get_observation` is the only way to get full content
- Lineage → archive-report includes all observation IDs for complete traceability
