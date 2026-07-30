---
name: ecomono-plan
description: >
  Turn an agreed design into an ordered plan whose tasks each run in a fresh
  context. Use after brainstorming, when a spec or requirement needs breaking
  down, or when the user says "write a plan", "break this down", "what are the
  steps", or invokes /ecomono-plan. Not for single-edit work — that gets
  implemented, not planned.
---

A plan exists so the work can be split. If every task needs the planning
conversation resident to make sense, the plan bought nothing.

## Hard rule: self-contained tasks

Each task MUST be executable by an agent that has never seen this conversation.
That is the whole test.

- Name exact file paths, not "the auth module".
- State the expected end condition, not "make it work".
- No "as we discussed", "the approach above", "same as the previous task".
- Carry context via files on disk, not via prose pasted into a dispatch prompt —
  anything pasted into a prompt stays resident in that context for its lifetime.

A task failing this test is not a task, it is a note to yourself.

## Skip planning when

| Situation | Do instead |
|---|---|
| One file, mechanical, you know the edit | Implement it |
| Under ~3 steps with no ordering risk | Implement it |
| Design not yet agreed | `ecomono-brainstorm` first |

## Sequence

1. **Order by dependency**, not by importance. What unblocks the most goes first.
2. **Cut speculative tasks.** A task for a requirement nobody stated does not
   enter the plan. Say in one line what you dropped.
3. **Mark what runs isolated.** Reads, exploration, and test/build loops get
   delegated. Edits stay inline — they are cheap and the diff must be reviewable
   in the thread that owns the work.
4. **Name the verification** per task: the command or assertion that proves it
   done. "Tests pass" is not a verification; the test name is.
5. **Name the ceiling** of any deliberate shortcut, with its upgrade trigger, so
   it lands as an `ecomono:` comment in the code rather than as folklore.

## Output

An ordered checklist. Per task: the files, the end condition, the verification,
and whether it runs isolated or inline. Plus one line for what was cut and when
it would be worth adding.

Then stop. Writing the plan is not executing it.
