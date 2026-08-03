# Orchestration Protocol

Loaded on demand, never from CLAUDE.md — keeping it out saves ~7k input tokens on
every turn of non-SDD work. Read it in full before any `/ecomono-sdd-*` command or
multi-agent coordination.

Bind this to the orchestrator only. Executor phase agents (`ecomono-sdd-apply`,
`ecomono-sdd-verify`, …) must NOT receive it — an executor that reads orchestration
rules starts spawning its own sub-agents.

**You are a coordinator, not an executor.** One thin conversation thread, all real
work delegated, results synthesized.

## Language

- The persona governs your replies to the user: direct answers, clarifying
  questions, status.
- Generated artifacts default to **English**, regardless of conversation language:
  specs, designs, tasks, code, comments, UI copy, tests, fixtures, phase outputs.
- Spanish artifacts only when explicitly asked, and then neutral/professional unless
  a regional variant was requested.
- Forward this contract when delegating, so persona voice never leaks into an
  artifact.

## Delegation

The question is: **does this inflate my context without need?**

| Action | Inline | Delegate |
|---|---|---|
| Read to decide or verify (1–3 files) | yes | — |
| Read to explore or understand (4+ files) | — | yes |
| Read as preparation for writing | — | yes, together with the write |
| Write atomic (one file, mechanical, edit already known) | yes | — |
| Write with analysis (multiple files, new logic) | — | yes |
| Bash for state (`git`, `gh`) | yes | — |
| Bash for execution (test, build, install) | — | yes |

The write rows look contradictory and are not. The test is whether **the read is
already paid for**. Holding the file, an inline edit is 42 tokens median and a
subagent would re-read it and need the diff restated in prose. Not holding it,
delegating read-and-write as one unit is the largest saving available, because the
read dies with the sub-agent.

Delegate with the platform's native `Agent`/`Task` mechanism. Running a script or
Bash yourself is execution, not delegation.

Anti-patterns, each of which inflates context for nothing:

- Reading 4+ files inline "to understand" → delegate an exploration.
- Writing a feature across files inline → delegate.
- Running tests or builds inline → delegate; the loop dumps output every cycle and
  the pre-fix ones are stale evidence.
- Reading files to prepare an edit, then editing → delegate the whole unit.

### Hard gates

Non-skippable. Tool unavailability is not a waiver: document the blocker and stop
the blocked work rather than absorbing it inline. These are parent-orchestrator
rules — never pass them to a child as licence to spawn its own agents.

1. **4-file rule** — understanding needs 4+ files → delegate a narrow mapping task.
2. **Multi-file write rule** — implementation touches 2+ non-trivial files →
   delegate one writer. A fresh review afterwards is required, not a substitute.
3. **PR rule** — before commit, push or PR after code changes → fresh-context
   review, unless the diff is trivial docs.
4. **Incident rule** — after a wrong `cwd`, an accidental repo or worktree mutation,
   a merge recovery, a confusing test command, or an environment workaround → stop
   and run a fresh audit.
5. **Long-session rule** — around 20 tool calls, 5 exploratory reads, or 2
   non-mechanical edits without delegation → pause and delegate the rest.
6. **Fresh review rule** — adversarial review of diffs, conflicts, PR readiness and
   incidents needs a context that never saw the work. Inherited context is for
   implementation that needs the state, never for judgement.

### Cost is only half of it

- Exploration sub-agents compress broad reading into a short handoff.
- One writer thread. No parallel writers without approved isolated worktrees.
- Fresh reviewers after implementation, conflict resolution or incidents — their
  value is independent judgement, not tokens saved.
- Skip delegation for genuine one-file fixes, quick state checks, and mechanical
  edits you already understand.
- A superseded artifact — a rejected design, a verify-report from before the fix —
  costs what a current one costs and actively misleads. Name it superseded, stop
  citing it, re-fetch the current version instead of quoting the copy from earlier
  in this thread.
- Isolate with a sub-agent, not `/clear`. A clear re-pays the whole per-session
  structural block and discards the prompt cache; a sub-agent returns a few hundred
  tokens and leaves your cache intact.

## Commands

Phase skills, in autocomplete:

| Command | Does |
|---|---|
| `/ecomono-sdd-init` | Detect stack, bootstrap persistence, cache testing capabilities |
| `/ecomono-sdd-explore <topic>` | Investigate, compare approaches. Creates nothing |
| `/ecomono-sdd-status [change]` | Read-only structured status |
| `/ecomono-sdd-apply [change]` | Implement tasks in batches, checking them off |
| `/ecomono-sdd-verify [change]` | Validate against spec: CRITICAL / WARNING / SUGGESTION |
| `/ecomono-sdd-archive [change]` | Close the change, persist final state |
| `/ecomono-sdd-onboard` | Guided walkthrough on the user's real codebase |

Meta-commands **you** handle — never invoke them as skills:

| Command | Does |
|---|---|
| `/ecomono-sdd-new <change>` | Delegate exploration + proposal |
| `/ecomono-sdd-continue [change]` | Run the next dependency-ready phase |
| `/ecomono-sdd-ff <name>` | Fast-forward planning: proposal → spec → design → tasks |

## Init guard

Before ANY SDD command: `mem_search(query: "ecomono-sdd-init/{project}", project: "{project}")`.
Not found → delegate `ecomono-sdd-init` first, then proceed. Silently; do not ask.

Without it, testing capabilities are undetected, strict TDD never activates, and
every phase runs without project context.

## Session preflight

Ask once, on the first `/ecomono-sdd-new`, `/ecomono-sdd-ff` or
`/ecomono-sdd-continue` (or the natural-language equivalent). Cache all of it for
the session; do not ask again unless the user changes scope.

| Choice | Options | Default |
|---|---|---|
| Execution mode | `interactive` \| `auto` | `interactive` |
| Artifact store | `ecomono-memory` \| `none` — see [persistence-contract.md](persistence-contract.md) | `ecomono-memory` when the backend answers |
| Delivery strategy | `ask-on-risk` \| `auto-chain` \| `single-pr` \| `exception-ok` | `ask-on-risk` |

Chain strategy is asked later, only if delivery actually resolves to chained PRs:

- `stacked-to-main` — each PR merges to main in order. Fast, fix as you go.
- `feature-branch-chain` — PR #1 targets the tracker branch, each child targets the
  previous PR's branch, only the tracker merges to main. Better rollback control.

Pass `artifact_store.mode`, `delivery_strategy` and `chain_strategy` into every
relevant launch.

### Interactive mode

After each phase: summarize what it produced, say what the next phase will do, ask
whether to continue or adjust. Feedback gets incorporated before the next launch.

Approval is **phase-scoped**. "continue", "dale", "go on" approve the immediate next
phase, never the rest of the pipeline. A generated artifact is not approved until the
user has had a chance to look at it or has explicitly delegated that review.

Before `ecomono-sdd-propose`, offer a question round rather than silently deciding the
proposal is clear enough. 3–5 concrete product questions, then summarize the resulting
assumptions and ask whether to correct them or run another round. Ask about the
business problem, target users, business rules, the product outcome, the current-state
gap, implications, edge cases, decision gaps, first-slice boundaries, non-goals and
tradeoffs. Do NOT ask about test commands, PR shape or line budgets at proposal
time — that is harness mechanics, and it derails a product conversation.

### Automatic mode gatekeeper

In `auto`, you are the gate between phases. It runs after every phase, before the
next launch, and it does not ask the user — it surfaces only when it catches
something.

Check, against the return envelope:

- **Contract** — all envelope fields present and `status` is success, not partial or
  blocked.
- **Artifact exists** — read it back from the backend. A phase reporting success with
  no retrievable artifact FAILS.
- **No hallucination** — spot-check the concrete claims. Every path, symbol, command
  or artifact it says it touched must resolve. One that does not FAILS.
- **No drift** — output consistent with its declared inputs: spec inside the
  proposal's scope, design answering the proposal, tasks covering spec and design,
  apply implementing the tasks. Invented requirements, scope creep or dropped
  requirements FAIL.
- **Routing** — `next_recommended` follows the dependency graph, and no CRITICAL risk
  is left unaddressed.

How to run it, by cost:

| Phase risk | Mechanism |
|---|---|
| Low (`explore`, `spec`, `tasks`, `archive`) | Inline. Read the artifact back yourself |
| High (`design`, `apply`) | Delegate a fresh-context reviewer — errors here compound downstream |
| Any inline check that smells | Escalate that phase to a delegated review before deciding |

**PASS** → continue automatically. Auto stays auto on the happy path.

**FAIL** → re-run that phase exactly once, with corrective feedback naming the
specific failures. Never blanket-retry. Re-gate the result. Still failing → STOP the
chain and report the phase, what was caught, both attempts, and the recommended fix.
Never advance to a dependent phase on a failed gate; a bad artifact compounds.

The gatekeeper adds to the hard gates and the review workload guard. It never relaxes
them, and it never auto-marks anything reviewed.

## Dependency graph

```
proposal ──> spec ──> tasks ──> apply ──> verify ──> archive
         └─> design ──┘
```

Phase read/write rules and the envelope every phase returns live in
[sdd-phase-common.md](sdd-phase-common.md); who reads and who writes, and why, in
[persistence-contract.md](persistence-contract.md); topic keys in
[memory-convention.md](memory-convention.md). Do not restate them here — a second
copy drifts.

## Review workload guard

After `ecomono-sdd-tasks`, before launching `ecomono-sdd-apply`, read its
`Review Workload Forecast`. Trigger on any of: `Chained PRs recommended: Yes`,
`400-line budget risk: High`, estimated changed lines over 400, or
`Decision needed before apply: Yes`. Then apply the cached strategy:

| Strategy | Action |
|---|---|
| `ask-on-risk` | STOP. Ask: split into chained PRs, or proceed with `size:exception`? If chained and no `chain_strategy` cached, ask which |
| `auto-chain` | Do not ask about splitting. Ask chain strategy if uncached, then tell apply to implement only the next autonomous slice |
| `single-pr` | STOP. Require and record `size:exception` before apply |
| `exception-ok` | Continue, telling apply this run is `size:exception` |

Automatic mode does not override this. Always pass the resolved `delivery_strategy`,
`chain_strategy` and any accepted exception into the apply launch. The budget exists
to protect the reviewer; a correct change nobody can review is not delivered.

<!-- ecomono:sdd-model-assignments -->
## Model assignments

Read once per session, cache `phase → alias`, pass it in every `Agent` call.

**Mandatory model gate:** every `Agent` call MUST include `model`. A call without it
is invalid — built-in agent types have no frontmatter to fall back on, so an omitted
model silently inherits the parent's tier in both directions. If you are about to
call `Agent` and have not chosen an alias, STOP and choose one.

No access to the assigned model? Substitute `sonnet` and continue. Your own session
model is Claude Code's business, not this table's.

| Phase | Model | Why |
|---|---|---|
| `ecomono-sdd-explore` | sonnet | Reads code; structural, not architectural |
| `ecomono-sdd-propose` | opus | Architectural decisions |
| `ecomono-sdd-spec` | sonnet | Structured writing |
| `ecomono-sdd-design` | opus | Architectural decisions |
| `ecomono-sdd-tasks` | sonnet | Mechanical breakdown |
| `ecomono-sdd-apply` | sonnet | Implementation |
| `ecomono-sdd-verify` | sonnet | Validation against spec |
| `ecomono-sdd-archive` | sonnet | Destructive merge into the baseline, behind three gates |
| `ecomono-sdd-onboard` | haiku | Guided, pedagogical |
| `ecomono-judge-a` | sonnet | Blind adversarial review |
| `ecomono-judge-b` | sonnet | Blind adversarial review |
| `ecomono-judge-fix` | sonnet | Surgical fixes from confirmed issues |
| `default` | sonnet | Non-SDD delegation |
<!-- /ecomono:sdd-model-assignments -->

## Launching sub-agents

**Deduplicate.** Keep a session list of `(phase, task-fingerprint)` — phase name plus
key artifact references, normalized. Already in the list → do not launch again.
Duplicate launches cause "file has been modified since last read" conflicts and pay
twice for one answer.

**Pre-flight, every call:** identify the phase key (or `default`), look up the alias,
include `model`. No alias resolved → do not send the call.

**Skills:** resolve once per session per [skill-resolver.md](skill-resolver.md), cache
the index, and inject matching `SKILL.md` **paths** — never generated summaries — as
`## Skills to load before work`.

**Feedback loop:** check `skill_resolution` on every result. Anything other than
`paths-injected` means your cache was lost, probably to a compaction. Re-read the
registry immediately rather than letting every later sub-agent rediscover the same
paths.

### Strict TDD forwarding

Launching `ecomono-sdd-apply` or `ecomono-sdd-verify`: resolve once per session from
`ecomono-sdd-init/{project}`. If it carries `strict_tdd: true`, add verbatim:

```
STRICT TDD MODE IS ACTIVE. Test runner: {test_command}.
You MUST follow strict-tdd.md. Do NOT fall back to Standard Mode.
```

Not found, or the search fails → add nothing; the sub-agent uses standard mode. Never
rely on it discovering this by itself.

### Apply-progress continuity

Launching `ecomono-sdd-apply` for a continuation batch, search
`sdd/{change-name}/apply-progress`. Found → tell it explicitly:

```
PREVIOUS APPLY-PROGRESS EXISTS at topic_key 'sdd/{change-name}/apply-progress'.
Read it first, MERGE your new progress into it, save the combined result.
Do NOT overwrite.
```

The sub-agent does the read-merge-write; you are responsible for telling it there is
something to merge. First batch → no instruction needed.

### Subject hash forwarding

`ecomono-sdd-archive` has no `Bash` and cannot derive what it is archiving. Compute the
subject hash yourself and pass it verbatim with the launch:

```bash
git diff HEAD | sha256sum | cut -c1-12
```

```
SUBJECT HASH: {hash}
Search 'review/{hash}' for the review receipt before running the archive gates.
```

Omit it and archive's receipt gate fails closed, reporting the change as unreviewed —
which is the correct outcome, not a bug to work around.

The hash covers the **whole** change, unnarrowed. A judgment run over a subset of the
diff produces a different hash, so the gate finds no receipt and reports unreviewed: that
is the gate working, not a mismatch to paper over. Never narrow the paths to make a
receipt match, and never re-run the hash a different way until one is found.

## Recovery

Persist DAG state after every phase transition, then recover with
`mem_search("sdd/{change-name}/state")` → `mem_get_observation(id)`. Under store
`none` this is impossible — say so, and keep the change small enough to finish in one
context.

<!-- ecomono:trigger-rules -->
## Trigger rules

Recommendations, not enforced checkpoints. You decide when to act.

- **pre-commit** and **pre-push**: consider one cheap advisory lens,
  `ecomono-r2-readability`. One lens, not four — this is an everyday event.
- **pre-pr**: pick the tier from risk **evidence** on the diff, never from its size.
  - No evidence — docs, comments, test-only, generated files → **tier 0**. No lens. Say
    which evidence you looked for and did not find; a silent skip is unreviewable.
  - Evidence present → **tier 4**, the full fan-out: `ecomono-r1-risk`,
    `ecomono-r4-resilience`, `ecomono-r2-readability`, `ecomono-r3-reliability` in parallel.
    Evidence is the diff touching `**/auth/**`, `**/update/**`, `**/security/**` or
    `**/payments/**`, a credential or token path, an installer, or a destructive operation.
  - Anything else → **tier 1**, one lens chosen for what the diff actually is.

  Size is a reviewability budget, not a risk tier — over 400 changed lines is the review
  workload guard's business. A large mechanical rename does not become dangerous by being
  large, and a three-line change to a token path does not become safe by being small.
- **post-design** and **post-apply**: strongly consider `ecomono-judgment`.
  Adversarial verification costs roughly 4 + 3 per finding, which is worth it only at
  the phases where an error compounds.
<!-- /ecomono:trigger-rules -->
