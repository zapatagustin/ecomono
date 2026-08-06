---
description: Guided SDD walkthrough — onboard a user through the full SDD cycle using their real codebase
---

Read the skill file at `~/.claude/skills/ecomono-sdd-onboard/SKILL.md` FIRST, then follow its instructions exactly inline. Onboard always runs inline — no sub-agent to delegate to.

CONTEXT:
- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Artifact store mode: ecomono-memory

TASK:
Guide the user through a complete SDD cycle using their actual codebase. This is a real change with real artifacts, not a toy example. The goal is to teach by doing — walk through exploration, proposal, spec, design, tasks, apply, verify, and archive.

ECOMONO-MEMORY PERSISTENCE (artifact store mode: ecomono-memory):
Save onboarding progress as you go:
  mem_save(title: "ecomono-sdd-onboard/{project}", topic_key: "ecomono-sdd-onboard/{project}", type: "architecture", project: "{project}", content: "{onboarding state}")
If that save returns `judgment_required`, resolve every candidate per
`~/.claude/skills/ecomono-sdd-shared/sdd-phase-common.md` §C. That step, not
`topic_key` on its own, is what makes re-running an update rather than a duplicate.

Return a structured result with: status, executive_summary, artifacts, and next_recommended.
