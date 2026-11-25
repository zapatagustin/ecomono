---
description: Hand this session off to a clean one — save the summary, print the opener and the resume command
---

Hand off this session. Do not compact.

1. Save a session summary with `mem_session_summary`: goal, discoveries, done, next steps, relevant files, plus this session's id and transcript path (`~/.claude/projects/<project>/<session id>.jsonl`; take the id from the context notice or the newest file there).
2. Print the opener for the new session: one short paragraph naming the goal, what is done, the next step, and that the summary is in memory under this session id.
3. Print the way back: `claude --resume <session id>`. Tell the user the previous transcript is read only through `ecomono-explore`, never inline.
