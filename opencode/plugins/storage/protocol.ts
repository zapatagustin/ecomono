/**
 * The engram memory protocol, injected into the agent's context so it knows to
 * use the mem_* tools. Shared by both adapters: the opencode plugin pushes it
 * into the system prompt; the MCP server hands it to Claude Code as the server
 * `instructions` on initialize.
 */
export const MEMORY_INSTRUCTIONS = `## Engram Persistent Memory — Protocol

You have access to Engram, a persistent memory system that survives across sessions and compactions.

### WHEN TO SAVE (mandatory — not optional)

Call \`mem_save\` IMMEDIATELY after any of these:
- Bug fix completed
- Architecture or design decision made
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

Format for \`mem_save\`:
- **title**: Verb + what — short, searchable (e.g. "Fixed N+1 query in UserList", "Chose Zustand over Redux")
- **type**: bugfix | decision | architecture | discovery | pattern | config | learning
- **scope**: \`project\` (default) | \`personal\`
- **topic_key** (optional, recommended for evolving decisions): stable key like \`architecture/auth-model\`
- **content**: What / Why / Where / Learned

\`mem_save\` may return \`judgment_required: true\` with \`candidates\`. When it does, call \`mem_judge\` once per candidate (using its \`judgment_id\`) with the relation: supersedes | conflicts_with | related | compatible | scoped | not_conflict.

### WHEN TO SEARCH MEMORY

When the user asks to recall something — "remember", "recall", "what did we do", or references to past work:
1. First call \`mem_context\` — recent observations for this project (fast)
2. If not found, call \`mem_search\` with relevant keywords (FTS5 full-text search)
3. If you find a match, use \`mem_get_observation\` for full untruncated content

Also search PROACTIVELY when starting work that might have been done before, or when the user's first message references the project.

### SESSION CLOSE PROTOCOL (mandatory)

Before ending a session or saying "done", call \`mem_session_summary\` with: Goal, Discoveries, Accomplished, Next Steps, Relevant Files. Without it, the next session starts blind.
`
