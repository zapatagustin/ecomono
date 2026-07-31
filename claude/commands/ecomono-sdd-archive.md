---
description: Archive a completed SDD change — syncs specs and closes the cycle
---

If the native `ecomono-sdd-archive` sub-agent is available, delegate this command to it.
Otherwise, read the skill file at `~/.claude/skills/ecomono-sdd-archive/SKILL.md` FIRST, then follow its instructions exactly inline.

CONTEXT:
- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Artifact store mode: ecomono-memory

TASK:
Archive the active SDD change. Read the verification report first to confirm the change is ready. Then:

STATUS GATE:
Read `~/.claude/skills/ecomono-sdd-shared/sdd-status-contract.md` and produce structured status before acting. If `$ARGUMENTS` is missing or ambiguous, ask the user to choose and STOP. Do not guess. Continue only when verify-report exists, contains no CRITICAL issues, and tasks are complete. CRITICAL verification issues have no override. If unchecked tasks remain, send the change back to `ecomono-sdd-apply` unless apply-progress/verify-report prove they are stale checkboxes and the orchestrator explicitly requests mechanical reconciliation. If status reports `workspace-planning`, STOP and explain that workspace archive is not supported in this slice. Carry `contextFiles`, task progress, dependency states, and `actionContext` into the native sub-agent prompt when delegating.

ECOMONO-MEMORY PERSISTENCE (artifact store mode: ecomono-memory):
CRITICAL: mem_search returns 300-char PREVIEWS, not full content. You MUST call mem_get_observation(id) for EVERY artifact.
STEP A — SEARCH (get IDs only):
  mem_search(query: "sdd/{change-name}/proposal", project: "{project}") → save proposal_id
  mem_search(query: "sdd/{change-name}/spec", project: "{project}") → save spec_id
  mem_search(query: "sdd/{change-name}/design", project: "{project}") → save design_id
  mem_search(query: "sdd/{change-name}/tasks", project: "{project}") → save tasks_id
  mem_search(query: "sdd/{change-name}/apply-progress", project: "{project}") → save apply_progress_id
  mem_search(query: "sdd/{change-name}/verify-report", project: "{project}") → save verify_id
STEP B — RETRIEVE FULL CONTENT (mandatory):
  mem_get_observation(id: proposal_id) → full proposal
  mem_get_observation(id: spec_id) → full spec
  mem_get_observation(id: design_id) → full design
  mem_get_observation(id: tasks_id) → full tasks
  mem_get_observation(id: apply_progress_id) → full apply progress
  mem_get_observation(id: verify_id) → full verification report

STEP A2 — SEARCH MAIN SPECS (once the delta spec is parsed and the capabilities it touches are known):
  For each touched capability: mem_search(query: "spec/{capability}", project: "{project}") → save spec_{capability}_id
STEP B2 — RETRIEVE MAIN SPECS (mandatory):
  For each capability: mem_get_observation(id: spec_{capability}_id) → full main spec content (or none-found, if the capability has no baseline yet)

Then:
1. Sync delta specs into main specs (source of truth), by requirement name — ADDED, RENAMED, REMOVED, MODIFIED. Before upserting each capability's main spec, save its pre-merge content:
   mem_save(title: "spec/{capability}/prev", topic_key: "spec/{capability}/prev", type: "architecture", project: "{project}", content: "{pre-merge main spec content}")
   Then upsert the merged spec:
   mem_save(title: "spec/{capability}", topic_key: "spec/{capability}", type: "architecture", project: "{project}", content: "{merged main spec}")
   Either save may return `judgment_required`. Resolve every candidate with `mem_judge(judgment_id: "{candidate.judgment_id}", relation: "{candidate.suggested_relation}")` — pass the suggestion through rather than picking a relation. Forcing `supersedes` on a candidate the store only flagged as `related` retires a live artifact, including the change's own delta spec. See sdd-phase-common.md §C.
2. Re-read every merged `spec/{capability}` and confirm it holds what was intended.
3. Verify the archive is complete, then write and persist the archive report, recording all observation IDs for traceability:
   mem_save(title: "sdd/{change-name}/archive-report", topic_key: "sdd/{change-name}/archive-report", type: "architecture", project: "{project}", content: "{archive report with observation IDs}")

Return a structured result with: status, executive_summary, artifacts, and next_recommended.
