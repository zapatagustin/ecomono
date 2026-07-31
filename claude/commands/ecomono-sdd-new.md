---
description: Start a new SDD change — runs exploration then creates a proposal
---

Read `~/.claude/skills/ecomono-sdd-shared/sdd-orchestrator.md` in full FIRST — it holds the SDD + Agent-Teams orchestrator protocol (moved out of CLAUDE.md). Follow it inline.
The Claude Code session model is controlled by Claude Code; ecomono only configures models for Agent tool calls to phase sub-agents.

WORKFLOW:

1. Launch `ecomono-sdd-explore` to investigate the codebase for this change
2. Present the exploration summary to the user
3. Launch `ecomono-sdd-propose` to create a proposal based on the exploration
4. Present the proposal summary and ask the user if they want to continue with specs and design

CONTEXT:

- Working directory: Detect agent-side before proceeding by running `git rev-parse --show-toplevel` with the Bash tool; if that fails, run `pwd` with the Bash tool.
- Current project: Derive agent-side from the detected working directory basename. Do not use slash-command shell interpolation for this value.
- Change name: $ARGUMENTS
- Execution mode: ask/cache per orchestrator
- Artifact store mode: ask/cache per orchestrator
- Delivery strategy: ask/cache per orchestrator

ECOMONO-MEMORY NOTE:
Sub-agents handle persistence automatically. Each phase saves its artifact to ecomono-memory with topic_key "sdd/$ARGUMENTS/{type}".

Read the orchestrator instructions to coordinate this workflow. Do NOT execute phase work inline when a native sub-agent is available.
