/**
 * The ecomono-memory protocol, injected into the agent's context so it knows to
 * use the mem_* tools. Shared by both adapters: the opencode plugin pushes it
 * into the system prompt; the MCP server hands it to Claude Code as the server
 * `instructions` on initialize.
 */
export const MEMORY_INSTRUCTIONS = `## ecomono-memory — Persistent Memory Protocol

You have access to ecomono-memory, a persistent memory system that survives across sessions and compactions.

### WHEN TO SAVE (mandatory, once per request)

Call \`mem_save\` after any of these:
- Bug fix completed
- Architecture or design decision made
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

Save once per request, when it is done, not after every fix; a fix with a non-obvious root cause still gets its own entry. The save can share a turn with other tool calls.

Do not blindly repeat a memory write that returned an error: check whether the row exists first (\`mem_search\`, \`mem_context\`), a retry can duplicate it.

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
3. \`mem_context\` headers carry the row id (\`## #id Title\`) and cut bodies to 300 chars: call \`mem_get_observation\` with that #id for full untruncated content

\`mem_search\`'s return is a \`{ results, match_mode }\` envelope — \`match_mode\` is \`"all"\`, \`"any"\`, or \`"any (fallback)"\` when a multi-term search auto-widened.

Also search PROACTIVELY when starting work that might have been done before, or when the user's first message references the project.

### SESSION CLOSE PROTOCOL (mandatory)

Before ending a session or saying "done", call \`mem_session_summary\` with: Goal, Discoveries, Accomplished, Next Steps, Relevant Files. Without it, the next session starts blind.

### DELIVERY GUARANTEE

Memory calls are internal bookkeeping, never the reply. Finish memory writes before the final answer, and if a memory call fails, still deliver the answer — say the save failed, do not let it replace the result.
`
