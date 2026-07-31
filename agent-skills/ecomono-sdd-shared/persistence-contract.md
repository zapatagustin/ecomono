# Persistence Contract

Where SDD artifacts live, who reads them, who writes them. Shared by every SDD
skill and by the orchestrator.

## Modes

Two. The orchestrator passes `artifact_store.mode` and caches the choice for the
session; it asks once, on the first `/ecomono-sdd-new`, `/ecomono-sdd-ff` or
`/ecomono-sdd-continue`.

| Mode | Artifacts live in | Survives compaction | Survives session end | Project files |
|---|---|---|---|---|
| `ecomono-memory` | the memory backend | yes | yes | never |
| `none` | the conversation only | no | no | never |

Default: `ecomono-memory` when the backend answers, `none` otherwise. Never
invent a third mode, and never write artifacts into the project tree — SDD
artifacts are working state, not deliverables.

**Known ceiling of `ecomono-memory`:** a `topic_key` write is an upsert only once its
judgment is resolved (sdd-phase-common.md §C has the rule), so re-running a phase
retires its previous artifact. There is no revision history
and `archive` persists a report rather than a folder. That is deliberate — memory
is working state, not an audit trail — but it means "what did the first draft of
the design say" is a question this store cannot answer. Need that, and the answer
is git on real deliverables, not a second artifact store.

**`none` is degraded, not equivalent.** Nothing survives compaction, so a long
change will lose its own earlier phases. The orchestrator MUST say so when it
resolves to `none` rather than proceeding silently, and MUST pass artifact content
forward in each launch prompt, since the next phase has nowhere to read it from.

## Who reads, who writes

Sub-agents launch with a fresh context: no orchestrator instructions, no memory
protocol, no conversation history. That is the point, not a limitation — a
reviewer or executor that inherited the orchestrator's reasoning would anchor on
it instead of judging the artifact.

| Situation | Reads | Writes |
|---|---|---|
| Non-SDD task | orchestrator pre-searches and injects a summary | sub-agent, via `mem_save` |
| SDD phase with dependencies | sub-agent, straight from the backend | sub-agent |
| SDD phase without dependencies (`explore`) | nobody | sub-agent |

The split is not arbitrary:

- **Orchestrator reads for non-SDD** because it knows which context is relevant. A
  sub-agent searching blind pays for results nobody needed.
- **Sub-agents read for SDD** because artifacts are large. Inlining a spec and a
  design into a launch prompt spends the orchestrator's context on content only
  the executor will use — and that prompt stays resident for the rest of the
  session.
- **Sub-agents always write** because they hold the detail. By the time a result
  has been summarized back up, the nuance worth persisting is gone.

Pass artifact *references* — topic keys — not artifact *content*. Anything pasted
into a launch prompt lives in that context for its whole lifetime.

## Orchestrator launch prompt

One template. For a phase with no dependencies, drop the read block.

```
Artifact store mode: {ecomono-memory|none}

READ FIRST (search returns truncated previews — the preview is not the artifact):
  mem_search(query: "sdd/{change-name}/{type}", project: "{project}")  -> id
  mem_get_observation(id: {id})                                        -> full content

PERSIST BEFORE RETURNING (mandatory):
  mem_save(
    title:     "sdd/{change-name}/{artifact-type}",
    topic_key: "sdd/{change-name}/{artifact-type}",
    type:      "architecture",
    project:   "{project}",
    content:   "{your full artifact markdown}"
  )
Return without this and the next phase finds nothing. The pipeline stops there.
```

For a non-SDD sub-agent, the persistence ask is different — discoveries, not
artifacts:

```
PERSIST BEFORE RETURNING (mandatory):
  mem_save(title: "{verb + what}", type: "{decision|bugfix|discovery|pattern}",
           project: "{project}", content: "{What / Why / Where / Learned}")
```

Response ordering is not optional and is specified once, in
[sdd-phase-common.md](sdd-phase-common.md) section D: the final output is text, the
saves happen before it, and `mem_session_summary` belongs to top-level agents only.

## Orchestrator state

The orchestrator persists DAG state after every phase transition, so a compaction
mid-change is recoverable:

```
mem_save(topic_key: "sdd/{change-name}/state")
mem_search("sdd/*/state") -> mem_get_observation(id)
```

Under `none` this is impossible. Warn, and keep the change small enough to finish
in one context.

## Skill registry

The orchestrator resolves skill paths ahead of launch and injects them as
`## Skills to load before work`. Sub-agents read those exact files before starting.

Regenerate with `node ~/.claude/hooks/ecomono-skill-registry.js --cwd <repo>`, or
let `ecomono-sdd-init` do it. It also runs on every user prompt, so a stale
registry is usually a sign the skill's frontmatter is malformed, not that the
generator did not run.

## Detail level

The orchestrator may pass `detail_level`: `concise | standard | deep`. It controls
what the envelope says, never what gets persisted. Always persist the full
artifact — a phase truncating its own output to look tidy costs the next phase the
detail it needed.
