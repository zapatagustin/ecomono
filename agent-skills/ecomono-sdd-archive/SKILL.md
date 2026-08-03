---
name: ecomono-sdd-archive
description: "Merge delta specs into the main specs and close the change. Trigger: orchestrator launches archive after verification passes."
disable-model-invocation: true
user-invocable: false
metadata:
  version: "2.1"
  delegate_only: true
---

**You are the executor.** Archive it yourself, do not delegate, do not call the Skill
tool. Reached this through `Skill`? You are the orchestrator — stop and delegate to the
`ecomono-sdd-archive` sub-agent instead.

Skill loading, retrieval, persistence and the return envelope are sections A–D of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Artifacts default to
English.

## Purpose

Merge the change's delta specs into the **main specs** — the accumulated baseline at
`spec/{capability}` — then record closure. This is the phase that makes SDD cumulative
rather than a pile of per-change tickets.

**Reads:** every artifact for the change, plus `spec/{capability}` for each capability
the delta touches.
**Writes:** `spec/{capability}` (merged), `spec/{capability}/prev` (pre-merge revision),
and artifact `archive-report` at `sdd/{change-name}/archive-report`.

**This is the only phase that destroys data.** Every gate below exists because of that.

## Gates — all must pass before touching a main spec

### Task completion

`ecomono-sdd-apply` owns marking tasks; you validate the persisted artifact reflects
reality. Read the full `sdd/{change-name}/tasks` observation.

Any implementation task still `- [ ]` → STOP, return `blocked`, and report that apply
must be re-run or corrected. Do not merge, do not claim the cycle is complete.

The one exception: the orchestrator explicitly instructs a stale-checkbox
reconciliation **and** `apply-progress` / `verify-report` prove every unchecked task is
actually done. Record the exact reconciliation reason in the archive report. Internal
todo state is never proof.

### Verification

CRITICAL issues in `verify-report` **always** block. There is no override, and no
instruction from the orchestrator changes that — a CRITICAL that gets archived becomes
the baseline's problem forever.

Missing proposal, spec or design → report it. Continue only when the user explicitly
chooses a partial archive, and record what was missing.

### Review receipt

The orchestrator passes `SUBJECT HASH` with your launch — you have no `Bash`, so you
cannot derive it. Search `review/{subject-hash}` → `mem_get_observation`.

| Found | Verdict | Action |
|---|---|---|
| yes | `JUDGMENT: APPROVED` | Gate passes |
| yes | `JUDGMENT: ESCALATED` | STOP, return `blocked`. An escalation is an open question, not a slow pass |
| no | — | The bytes being archived are unreviewed. Report it |
| no hash passed | — | Same as above. Fail closed |

Unreviewed → continue only when the user explicitly accepts an unreviewed archive, and
record it in `Exceptions Recorded` with the hash you searched. Same policy as a partial
archive: the gate reports, the user decides, the report remembers.

A receipt whose hash does not match the bytes in front of you is a receipt for a different
change. Never treat a near-miss as a match, and never re-key a receipt to make one fit.

### Edit scope

`allowedEditRoots` present → stay inside them. Cannot prove scope → STOP and ask.

## Merging

For each delta, match requirements **by name**:

| Delta section | Action | Risk |
|---|---|---|
| `ADDED` | Append to the main spec's requirements | Safe |
| `RENAMED` | Rename in place, preserving scenarios unless the delta also modifies them | Safe. Requires explicit old → new |
| `REMOVED` | Delete the requirement, after recording `Reason` and `Migration` | Explicit. Refuse without both notes |
| `MODIFIED` | **Replace** the matching requirement wholesale | **Destructive** |

Preserve every requirement the delta does not mention. Keep the heading hierarchy
intact.

No main spec exists for a capability → the delta is a full spec. Write it to
`spec/{capability}` directly.

### The MODIFIED guard

A `MODIFIED` block replaces a requirement entirely, so a partially copied block silently
deletes the scenarios it omitted. Because the main spec is a memory upsert, there is no
git history to recover from.

**Before writing, count.** For each MODIFIED requirement, compare the scenario count in
the delta block against the one in the current main spec:

- **Fewer scenarios in the delta → STOP.** Return `blocked` naming the requirement and
  both counts. Do not merge, do not "merge the parts that look complete". Either the
  delta is truncated and spec must fix it, or the drop was intentional and belongs in
  `REMOVED` with its notes.
- Same or more → proceed.

Report the accounting for every merged requirement (`user-auth / Session Expiration: 4 → 5`).
A merge that reports no counts cannot be audited.

This check is not advisory. Earlier phases check the same thing — spec at authoring time,
verify before you run — and this is the last place it can be caught, on the one
operation that cannot be undone.

### Keep one revision

Before upserting `spec/{capability}`, save the current content to
`spec/{capability}/prev`. One revision per capability, overwritten each merge.

Both of those saves are upserts only once judged, and either can come back with
`judgment_required` — the store flags anything it might relate to, so even a first-ever
write can raise candidates. Resolve each by passing its own `suggested_relation` to
`mem_judge`, per sdd-phase-common.md §C. The `supersedes` one retires the old baseline;
skip it and the baseline forks into two live specs that disagree.

`ecomono: single-revision rollback, not history — the ceiling is that only the last merge is recoverable. Upgrade path: version the key per change (spec/{capability}@{change}) if audits ever need the full chain.`

That restores the safety net files got from git, at the cost of one extra key per
capability rather than one per change.

## Closing

Verify before reporting success:

- [ ] Every merged main spec re-read and holding what you intended
- [ ] Scenario accounting recorded for every MODIFIED requirement
- [ ] `spec/{capability}/prev` written for each merged capability
- [ ] Tasks artifact has no unchecked implementation tasks (or the recorded exception)
- [ ] Review receipt found and approved for the passed subject hash (or the recorded exception)
- [ ] Every artifact observation ID captured for lineage
- [ ] No save left with `judgment_required` unresolved

## Output

```markdown
## Archive Complete

**Change**: {change-name}

### Specs Merged
| Capability | Delta | Scenarios | Revision saved |
|---|---|---|---|
| `user-auth` | 1 modified, 2 added | 4 → 7 | `spec/user-auth/prev` |

### Lineage
| Artifact | Observation ID |
|---|---|
| proposal / spec / design / tasks / apply-progress / verify-report | {id} |

### Exceptions Recorded
{Stale-checkbox reconciliation, partial archive, an unreviewed archive accepted (name the
subject hash searched), or a destructive merge stopped for confirmation despite passing
scenario counts — each with its reason. Or "None."}

### Status
Cycle complete for `{change-name}`.
```

## Rules

- Gates first. Never touch a main spec before task completion and verification pass.
- CRITICAL verification issues block, always, with no override.
- No receipt, or no subject hash passed → unreviewed. Fail closed and report; an absent
  hash is not a pass. An `ESCALATED` receipt blocks outright.
- `MODIFIED` with fewer scenarios blocks. This is the rule that keeps the baseline
  from silently shrinking.
- `REMOVED` and `RENAMED` without their notes are refused, not inferred.
- You do not own task completion. Apply does. You may only reconcile mechanically, with
  proof, and you record it.
- A destructive merge that removes large sections → stop and ask, even when the counts
  technically pass. Volume is its own signal.
- Report the lineage. An archive nobody can trace back to its artifacts is a claim, not
  a record.
