---
description: Continue the next SDD phase in the dependency chain
---

Read `~/.claude/skills/ecomono-sdd-shared/sdd-orchestrator.md` in full FIRST — it holds the SDD + Agent-Teams orchestrator protocol (moved out of CLAUDE.md). Follow it inline.
The Claude Code session model is controlled by Claude Code; ecomono only configures models for Agent tool calls to phase sub-agents.

WORKFLOW:

1. Resolve status per the schema in `~/.claude/skills/ecomono-sdd-shared/sdd-status-contract.md`. When the session artifact store is `ecomono-memory`, resolve it entirely from ecomono-memory (`mem_search` + `mem_get_observation` on the change's topic keys). When the store is `none`, derive it from conversation state using the same schema. Produce this structured status before acting.
2. Resolve the active change. If `$ARGUMENTS` is missing and more than one active change exists, ask the user to choose and STOP. Do not guess.
3. Check which artifacts already exist for the active change (proposal, specs, design, tasks)
4. Determine the next phase needed based on the dependency graph:
   proposal → [specs ∥ design] → tasks → apply → verify → archive
5. Launch the appropriate sub-agent(s) for the next phase only if authoritative status says the dependency is ready. Route only by `nextRecommended` and dependency states; never infer from free text. If `blockedReasons` is non-empty, do not proceed to apply, archive, or terminal work. If `nextRecommended` is `verify`, verification/remediation may run only to refresh evidence; if `nextRecommended` is `resolve-blockers`, report `blockedReasons` and stop; if `nextRecommended` is a planning token (`propose`, `spec`, `design`, or `tasks`), launch the corresponding planning phase. Carry `actionContext` and allowed edit roots into any sub-agent launch.
6. Present the result and ask the user to proceed

CONTEXT:

- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Change name: $ARGUMENTS
- Execution mode: ask/cache per orchestrator
- Artifact store mode: ask/cache per orchestrator
- Delivery strategy: ask/cache per orchestrator

ECOMONO-MEMORY NOTE:
To check which artifacts exist, search: mem_search(query: "sdd/$ARGUMENTS/", project: "{project}") to list all artifacts for this change.
Sub-agents handle persistence automatically with topic_key "sdd/$ARGUMENTS/{type}".

Read the orchestrator instructions to coordinate this workflow. Do NOT execute phase work inline when a native sub-agent is available.

STATUS CONTRACT:

Read `~/.claude/skills/ecomono-sdd-shared/sdd-status-contract.md` and follow it: when the store is `ecomono-memory`, resolve status from ecomono-memory using the manual status schema; when the store is `none`, derive it from conversation state using the same schema. If status reports `workspace-planning` with no allowed edit roots, do not launch apply/verify/archive work that would infer repo-local ownership.
