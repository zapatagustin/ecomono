---
description: Continue the next SDD phase in the dependency chain
agent: orchestrator
---

Follow the SDD orchestrator workflow to continue the active change.

HARD GATE:
SDD Session Preflight must already be complete for this session. It must include execution mode, artifact store, chained PR strategy, and review budget. If missing, ask the exact orchestrator preflight prompt and STOP. Do not launch the next phase in the same turn.

WORKFLOW:

1. Resolve status per the schema in `~/.config/opencode/skills/ecomono-sdd-shared/sdd-status-contract.md`. When the session artifact store is `ecomono-memory`, resolve it entirely from ecomono-memory (`mem_search` + `mem_get_observation` on the change's topic keys). When the store is `none`, derive it from conversation state using the same schema. If `$ARGUMENTS` is missing and more than one active change exists, ask the user to choose and STOP. Do not guess.
2. Produce or consume structured status before acting: schemaName, planningHome/changeRoot, artifactPaths/contextFiles, task progress, dependency states, next recommended action, blocked reasons, and actionContext.
3. Check which artifacts already exist for the active change (proposal, specs, design, tasks)
4. Determine the next phase needed based on the dependency graph:
   proposal → [specs ∥ design] → tasks → apply → verify → archive
5. Launch the appropriate sub-agent(s) for the next phase only if authoritative status says the dependency is ready. Route only by `nextRecommended` and dependency states; never infer from free text. If `blockedReasons` is non-empty, do not proceed to apply, archive, or terminal work. If `nextRecommended` is `verify`, verification/remediation may run only to refresh evidence; if `nextRecommended` is `resolve-blockers`, report `blockedReasons` and stop; if `nextRecommended` is a planning token (`propose`, `spec`, `design`, or `tasks`), launch the corresponding planning phase.
6. Present the result and ask the user to proceed

CONTEXT:

- Working directory: before doing anything else, run `git rev-parse --show-toplevel 2>/dev/null || pwd` with your bash tool and use the returned path as the authoritative workspace. In OpenCode Desktop (Electron) the parse-time interpolation resolves to the app data directory, not the project.
- Current project: the `basename` of the detected workspace above.
- Change name: $ARGUMENTS
- Execution mode: ask/cache per orchestrator
- Artifact store mode: ask/cache per orchestrator; do not hardcode ecomono-memory
- Delivery strategy: ask/cache per orchestrator
- Review budget: ask/cache per orchestrator

ECOMONO-MEMORY NOTE:
To check which artifacts exist in ecomono-memory, search: mem_search(query: "sdd/$ARGUMENTS/", project: "{project}") to list all artifacts for this change.
Sub-agents handle persistence automatically using the selected artifact store.

Read the orchestrator instructions to coordinate this workflow. Do NOT execute phase work inline — delegate to sub-agents.

STATUS CONTRACT:

Read the installed shared status contract from this agent's skills directory and follow it: when the store is `ecomono-memory`, resolve status from ecomono-memory using the manual status schema; when the store is `none`, derive it from conversation state using the same schema. Use `~/.config/opencode/skills/ecomono-sdd-shared/sdd-status-contract.md` for OpenCode, `~/.config/kilo/agent-skills/ecomono-sdd-shared/sdd-status-contract.md` for Kilo Code, `~/.qwen/agent-skills/ecomono-sdd-shared/sdd-status-contract.md` for Qwen, or the equivalent configured skills directory for the current adapter. Do not use a workspace-relative `agent-skills/ecomono-sdd-shared/...` path. Carry `actionContext` and allowed edit roots into any sub-agent launch. If status reports `workspace-planning` with no allowed edit roots, do not launch apply/verify/archive work that would infer repo-local ownership.
