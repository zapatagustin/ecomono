---
name: ecomono-sdd-spec
description: "Write delta specs: requirements and scenarios added, modified, removed or renamed. Trigger: orchestrator launches spec for a change."
disable-model-invocation: true
user-invocable: false
license: MIT
metadata:
  author: gentleman-programming
  derived_from: Gentleman-Programming/gentle-ai (sdd-spec)
  modified: true
  version: "2.0"
  delegate_only: true
---

**You are the executor.** Write the specs yourself, do not delegate, do not call the
Skill tool. Reached this through `Skill`? You are the orchestrator — stop and delegate to
the `ecomono-sdd-spec` sub-agent instead.

Skill loading, retrieval, persistence and the return envelope are sections A–D of
[sdd-phase-common.md](../ecomono-sdd-shared/sdd-phase-common.md). Artifacts default to
English.

## Purpose

Turn the proposal into **delta specs**: what is being added, modified, removed or renamed
in the system's specified behaviour.

**Reads:** `sdd/{change-name}/proposal` (required), and the main spec
`spec/{capability}` for every capability the proposal lists as modified.
**Writes:** artifact `spec`, at `sdd/{change-name}/spec`. Several domains → one artifact
with domain headers, not several artifacts.

## Main specs are the baseline

`spec/{capability}` holds the current specified behaviour of the system, accumulated
across changes. Your delta describes changes **to that**, and `ecomono-sdd-archive` merges
it in once the change is verified.

This is why the capability names matter: they are the key. Invent a new name for an
existing capability and you fork the baseline into two specs that disagree.

## Sequence

### 1. Map capabilities from the proposal

The proposal's **Capabilities** section is your contract:

| Proposal says | You write |
|---|---|
| Under `New` | A **full spec** for that capability. Nothing to be a delta against |
| Under `Modified` | A **delta**. Read `spec/{capability}` first — your delta modifies it |

No Capabilities section (older proposal) → infer from `Affected Areas`, but prefer the
explicit mapping whenever it exists. Inferring is how a capability gets missed.

### 2. Read the existing main spec

For every modified capability, read `spec/{capability}` in full before writing. You
cannot write a correct delta against a spec you have not read, and you need its scenario
counts for the check in step 4.

### 3. Write the delta

RFC 2119 keywords — MUST, SHALL, SHOULD, MAY. Scenarios as GIVEN / WHEN / THEN.

```markdown
# Delta for {capability}

## ADDED Requirements

### Requirement: {name}
The system MUST {specific behaviour}.

#### Scenario: {happy path}
- GIVEN {precondition}
- WHEN {action}
- THEN {outcome}

#### Scenario: {edge case}
- GIVEN {precondition}
- WHEN {action}
- THEN {outcome}

## MODIFIED Requirements

### Requirement: {existing name}
{Full updated requirement text — this REPLACES the existing one entirely}
(Previously: {what changed, one line})

#### Scenario: {unchanged scenario — copied, still valid}
- GIVEN / WHEN / THEN

#### Scenario: {updated scenario}
- GIVEN / WHEN / THEN

## REMOVED Requirements

### Requirement: {name}
(Reason: {why it is going})
(Migration: {what replaces it, or "None"})

## RENAMED Requirements

### Requirement: {old name} → {new name}
(Reason: {why})
(Migration: {how references, tests and docs update, or "None"})
```

A brand-new capability gets a full spec instead: purpose, then requirements with their
scenarios. No delta headers.

### 4. MODIFIED: copy whole, then edit

This is the one operation in the system that **destroys** data, so it gets its own rule.

1. Locate the requirement in `spec/{capability}`.
2. **Copy the entire block** — from `### Requirement:` through *every* scenario.
3. Paste it under `## MODIFIED Requirements`.
4. Edit the copy to the new behaviour.
5. Add `(Previously: …)`.

**Why whole:** archive REPLACES the requirement in the main spec with your block. A
partial block silently deletes the scenarios you did not copy. The main spec is a memory
upsert — there is no git history to recover it from, only the single previous revision
archive keeps.

**Self-check before persisting.** For each MODIFIED requirement, compare your block's
scenario count against the original you read in step 2:

- Fewer scenarios → you truncated. Copy the missing ones, or move the intent to
  `REMOVED` with its `Reason` and `Migration`. Never leave a silent drop.
- Same or more → fine.

State the counts in your return summary (`{name}: 4 → 4 scenarios`). Verify and archive
both re-check this; you are the cheapest place to catch it.

Adding behaviour **without** changing existing behaviour → use `ADDED`, not `MODIFIED`.
Reaching for MODIFIED when ADDED would do is what creates the truncation risk in the
first place.

## Output

```markdown
## Specs Created

**Change**: {change-name}

### Specs Written
| Capability | Type | Requirements | Scenarios | Baseline |
|---|---|---|---|---|
| `user-auth` | Delta | 2 modified | 4 → 5 | `spec/user-auth` |
| `data-export` | Full | 3 added | 7 | new capability |

### Scenario Accounting
{Per MODIFIED requirement: original count → delta count. Any drop declared as REMOVED.}

### Next
Ready for tasks (ecomono-sdd-tasks), or design if it has not run.
```

## Rules

- Every requirement needs at least one scenario. A requirement with no scenario cannot
  be verified, so it is a wish.
- Scenarios are testable: concrete preconditions, one action, an observable outcome.
  "THEN it works" is not an outcome.
- RFC 2119 keywords, deliberately. MUST and SHOULD mean different things to verify.
- MODIFIED copies whole. This is the rule that prevents irreversible loss.
- REMOVED and RENAMED always carry `Reason` and `Migration`. Archive refuses them
  otherwise, and it is right to.
- Do not rename a capability to fit your delta. The name is the baseline's key.
