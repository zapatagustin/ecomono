---
description: Ecomono plan — ordered tasks that each run in a fresh context
---
Break down into an ordered plan: $ARGUMENTS.

Hard rule: every task MUST be executable by an agent that never saw this
conversation. That is the whole test. Exact file paths, not "the auth module".
Expected end condition, not "make it work". No "as we discussed", no "same as the
previous task". Carry context via files on disk, not prose pasted into a prompt —
anything pasted stays resident in that context for its lifetime.

Skip planning: one mechanical file you already understand, or under ~3 steps with
no ordering risk → implement it. Design not agreed → `/ecomono-brainstorm` first.

Sequence: order by dependency, not importance → cut speculative tasks and say in
one line what you dropped → mark what runs isolated (reads, exploration, test/build
loops delegated; edits inline, they are cheap and the diff must be reviewable in the
thread that owns the work) → name the verification per task, the command or the test
name, never "tests pass" → name the ceiling of any deliberate shortcut with its
upgrade trigger so it lands as an `ecomono:` comment.

Output: ordered checklist. Per task — files, end condition, verification, isolated
or inline. Plus one line for what was cut and when it would be worth adding. Then
stop; writing the plan is not executing it.
