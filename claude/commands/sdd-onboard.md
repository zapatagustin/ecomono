---
description: Guided SDD walkthrough — onboard a user through the full SDD cycle using their real codebase
---

If the native `sdd-onboard` sub-agent is available, delegate this command to it.
Otherwise, read the skill file at `~/.claude/skills/sdd-onboard/SKILL.md` FIRST, then follow its instructions exactly inline.

CONTEXT:
- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Artifact store mode: ecomono-memory

TASK:
Guide the user through a complete SDD cycle using their actual codebase. This is a real change with real artifacts, not a toy example. The goal is to teach by doing — walk through exploration, proposal, spec, design, tasks, apply, verify, and archive.

ECOMONO-MEMORY PERSISTENCE (artifact store mode: ecomono-memory):
Save onboarding progress as you go:
  mem_save(title: "sdd-onboard/{project}", topic_key: "sdd-onboard/{project}", type: "architecture", project: "{project}", content: "{onboarding state}")
topic_key enables upserts — re-running updates, not duplicates.

Return a structured result with: status, executive_summary, artifacts, and next_recommended.
