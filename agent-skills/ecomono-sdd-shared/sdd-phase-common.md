# SDD Phase — Common Protocol

Every phase skill loads this alongside its own `SKILL.md`. It holds only what all
phases share; anything phase-specific lives in the phase.

**You are an executor, not an orchestrator.** Do the phase work yourself. Never
launch a sub-agent, never call `delegate`/`task`, never hand work back — unless
your phase skill explicitly tells you to stop and report a blocker. Loading a
skill is not delegating.

## A. Skill loading

Stop at the first source that answers:

| Source | When |
|---|---|
| `## Skills to load before work` in your launch prompt | Present → read those exact paths. Ignore any redundant `SKILL: Load`. |
| `SKILL: Load` instructions | No block above. |
| `.atl/skill-registry.md` at the project root | Neither above. Match its trigger column to your task, read the exact listed paths. |
| Nothing | Proceed with your phase skill alone. Report `none`. |

The orchestrator picking paths for you is the preferred path — it already knows
the change. The registry is a fallback, and reading it is skill loading, not
delegation.

## B. Artifact retrieval

`mem_search` returns **300-character previews**. Previews are not source material —
building a phase on one produces confidently wrong output. Call
`mem_get_observation(id)` for every artifact you intend to use.

```
mem_search(query: "sdd/{change-name}/{artifact-type}", project: "{project}") -> id
mem_get_observation(id: {id})                                               -> full content
```

Issue all searches in one batch, then all retrievals in one batch. Sequential
round-trips cost turns, and every turn re-reads the whole prefix.

Fetch fresh each run. A copy of an artifact quoted earlier in the conversation may
have been superseded by a later phase, and a superseded artifact costs exactly what
a current one costs while pointing at code that no longer exists. When a version is
superseded, say so and stop citing it.

## C. Artifact persistence

A phase that produces an artifact and does not persist it breaks the pipeline —
downstream phases search and find nothing.

```
mem_save(
  title:     "sdd/{change-name}/{artifact-type}",
  topic_key: "sdd/{change-name}/{artifact-type}",
  type:      "architecture",
  project:   "{project}",
  content:   "{your full artifact markdown}"
)
```

`topic_key` makes this an upsert: saving again updates in place instead of leaving
two versions to disagree.

Persistence mode `none` (no memory backend available): return the artifact inline
and write nothing. Say so in the envelope so the orchestrator knows continuity is
off and the next phase needs the content passed forward.

## D. Return envelope

**Your final output MUST be text, not a tool call.** Do every `mem_save` before it.
When a sub-agent's last action is a tool call, the parent receives only the tool
result and your analysis is lost. Never call `mem_session_summary` — that belongs to
top-level agents.

| Field | Content |
|---|---|
| `status` | `success` \| `partial` \| `blocked` |
| `executive_summary` | 1–3 sentences: what was done |
| `detailed_report` | Full output, or omit when already inline |
| `artifacts` | Keys or paths written |
| `next_recommended` | Next phase, or `none` |
| `risks` | What you found, or `None` |
| `skill_resolution` | `paths-injected` \| `fallback-registry` \| `fallback-path` \| `none` |

```markdown
**Status**: success
**Summary**: Proposal created for `{change-name}`. Scope, approach and rollback defined.
**Artifacts**: `sdd/{change-name}/proposal`
**Next**: ecomono-sdd-spec or ecomono-sdd-design
**Risks**: None
**Skill Resolution**: paths-injected — 3 skills (react-19, typescript, tailwind-4)
```

Report `partial` or `blocked` honestly. A phase that claims `success` with unchecked
work sends the next phase to build on a floor that is not there.

## E. Review workload guard

SDD exists to protect the reviewer, not only to emit tasks. A correct change nobody
can review is not delivered.

- Default PR review budget: **400 changed lines** (`additions + deletions`).
- The orchestrator caches a delivery strategy at session start — `ask-on-risk`
  (default), `auto-chain`, `single-pr`, or `exception-ok` — and passes
  `delivery_strategy` to `ecomono-sdd-tasks`, then the resolved decision to
  `ecomono-sdd-apply`.
- `ecomono-sdd-tasks` MUST forecast the budget and emit these lines verbatim, so the
  orchestrator can parse them: `Decision needed before apply: Yes|No`,
  `Chained PRs recommended: Yes|No`, `400-line budget risk: Low|Medium|High`.
- High forecast → recommend chained or stacked PRs sliced along deliverable work
  units, never along arbitrary line counts.
- `ecomono-sdd-apply` MUST NOT start oversized work unless the strategy resolves to
  slices or an explicitly accepted `size:exception`.
- Every slice needs a clear start, a clear finish, autonomous scope, its own
  verification, and a reasonable rollback.
- Feature branch chain: PR #1 targets the tracker branch, each later child targets
  the previous PR's branch. If a child diff shows earlier slices, retarget or rebase
  until it is clean — a dirty diff defeats the point of slicing.

This is not process noise. It is the difference between review and rubber-stamping.
