# Status Contract

Any command that selects, continues, applies, verifies or archives a change
produces this status first. It is the handoff between orchestrator and executor,
and it exists so orchestration never guesses state, scope, or what is safe to edit.

## Change selection

| Situation | Do |
|---|---|
| A change name was given | Use it, after confirming it exists in the store |
| No name, exactly one active change | Use it |
| No name, unambiguous from session state | Use it |
| Multiple candidates, or unclear | Ask. Do not guess |
| No active changes | Report none active, suggest `/ecomono-sdd-new <change>` |

Guessing a change name is the one failure here that silently writes artifacts into
the wrong lineage.

## Schema

Artifacts are topic keys, not paths — nothing is written to the project tree.

```yaml
schemaName: ecomono.sdd-status
schemaVersion: 1
changeName: <change-name-or-null>
artifactStore: ecomono-memory | none
artifacts:
  proposal:       missing | partial | done
  spec:           missing | partial | done
  design:         missing | partial | done
  tasks:          missing | partial | done
  applyProgress:  missing | partial | done
  verifyReport:   missing | partial | done
topicKeys:
  proposal: sdd/<change>/proposal        # and so on, per memory-convention.md
taskProgress:
  total: 0
  completed: 0
  pending: 0
  allComplete: false
dependencies:
  proposal: blocked | ready | all_done
  spec:     blocked | ready | all_done
  design:   blocked | ready | all_done
  tasks:    blocked | ready | all_done
  apply:    blocked | ready | all_done
  verify:   blocked | ready | all_done
  archive:  blocked | ready | all_done
applyState: blocked | ready | all_done
actionContext:
  workspaceRoot: <absolute path>
  allowedEditRoots: [<absolute paths>]
nextRecommended: propose | spec | design | tasks | apply | verify | archive
                 | new | select-change | resolve-blockers
blockedReasons: []
```

Empty list fields are `[]`, never null. `changeName` is nullable; everything else is
present so consumers parse one shape.

`nextRecommended` is a routing token, not prose. Route on it and on `dependencies`,
nothing else. The human explanation goes in `blockedReasons` — a token carrying
narrative cannot be matched against.

## Routing

- `blockedReasons` non-empty → do not proceed to apply, archive, or any terminal
  action. Report them and stop.
- Exception: `nextRecommended: verify` may run against blockers, but only to refresh
  or remediate their evidence.
- `nextRecommended: resolve-blockers` → always report and stop.
- `nextRecommended` is a planning token (`propose`, `spec`, `design`, `tasks`) →
  launch that phase. A missing planning artifact is that phase's expected output,
  not a genuine blocker; treating it as one deadlocks the change.

## Apply state

| State | Means |
|---|---|
| `blocked` | Required artifacts missing, task selection ambiguous, or edit scope unsafe |
| `ready` | Tasks exist, at least one implementation task unchecked, edit scope safe |
| `all_done` | Tasks exist and every implementation task is `[x]` |

## Dependency states

- `proposal`, `spec`, `design`, `tasks` — whether their prerequisites are blocked,
  ready, or done.
- `apply` is `ready` only when spec, design and tasks exist and task progress is not
  already complete.
- `verify` is `ready` when tasks exist and either apply-progress exists or the tasks
  artifact shows all intended implementation complete. Unchecked tasks stay blockers
  for full verification.
- `archive` is `ready` only when a verify-report exists, is *clearly* passing, and
  tasks are complete. Clearly passing means an explicit PASS/SUCCESS signal and no
  negation anywhere: FAIL, FAILURE, BLOCKED, CRITICAL, PENDING, TODO, `not passed`,
  `pass: no`. A CRITICAL issue has no override. The only recorded exceptions are
  non-critical partial archives, and stale-checkbox reconciliation where
  apply-progress and verify-report together prove the work was done.

Archive is where an optimistic read becomes permanent, which is why its gate is the
strictest one here.

## Action context guard

The orchestrator carries `actionContext` into every phase launch. This is a safety
boundary, not bookkeeping:

- `allowedEditRoots` present → edit only inside those roots.
- Cannot prove a file sits inside the workspace or an allowed root → stop and ask.
- Cannot prove edit ownership at all → stop before editing, not after.

## What every command shows

Before launching an executor or archiving:

1. The selected change and how it was resolved.
2. Artifact states and the topic keys used as context.
3. Task progress, plus the unchecked list when tasks exist.
4. `nextRecommended`.
5. `blockedReasons` whenever `nextRecommended` is not `verify`, plus any edit-root
   blockers.
