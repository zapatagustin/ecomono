---
description: Explore and investigate an idea or feature — reads codebase and compares approaches
---

If the native `ecomono-sdd-explore` sub-agent is available, delegate this command to it.
Otherwise, read the skill file at `~/.claude/skills/ecomono-sdd-explore/SKILL.md` FIRST, then follow its instructions exactly inline.

CONTEXT:
- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Topic to explore: $ARGUMENTS
- Artifact store mode: ecomono-memory

TASK:
Explore the topic "$ARGUMENTS" in this codebase. Investigate the current state, identify affected areas, compare approaches, and provide a recommendation.

ECOMONO-MEMORY PERSISTENCE (artifact store mode: ecomono-memory):
Read project context (optional):
  mem_search(query: "ecomono-sdd-init/{project}", project: "{project}") → if found, mem_get_observation(id) for full content
Save exploration:
  mem_save(title: "sdd/$ARGUMENTS/explore", topic_key: "sdd/$ARGUMENTS/explore", type: "architecture", project: "{project}", content: "{exploration}")

This is an exploration only — do NOT create any files or modify code. Just research and return your analysis.

Return a structured result with: status, executive_summary, detailed_report, artifacts, and next_recommended.
