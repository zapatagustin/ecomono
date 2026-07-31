---
description: Initialize SDD context — detects project stack and bootstraps persistence backend
---

If the native `ecomono-sdd-init` sub-agent is available, delegate this command to it.
Otherwise, read the skill file at `~/.claude/skills/ecomono-sdd-init/SKILL.md` FIRST, then follow its instructions exactly inline.

CONTEXT:
- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Artifact store mode: ecomono-memory

TASK:
Initialize Spec-Driven Development in this project. Detect the tech stack, existing conventions, and architecture patterns. Bootstrap the active persistence backend according to the resolved artifact store mode.

ECOMONO-MEMORY PERSISTENCE (artifact store mode: ecomono-memory):
After detecting the project context, save it:
  mem_save(title: "ecomono-sdd-init/{project}", topic_key: "ecomono-sdd-init/{project}", type: "architecture", project: "{project}", content: "{detected context}")
When that save returns `judgment_required`, resolve each candidate with `mem_judge`
(`supersedes` for the previous init context). That is what makes re-running init an
update rather than a duplicate — `topic_key` alone does not.

Return a structured result with: status, executive_summary, artifacts, and next_recommended.
