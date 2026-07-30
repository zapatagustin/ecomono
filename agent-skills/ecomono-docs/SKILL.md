---
name: ecomono-docs
description: "Write docs that reduce cognitive load. Trigger: guides, READMEs, RFCs, onboarding, architecture, PR descriptions, or any doc that reads long and dense."
license: Apache-2.0
metadata:
  author: gentleman-programming
  derived_from: Gentleman-Programming/gentle-ai (cognitive-doc-design)
  modified: true
  version: "1.0"
---

Write for a reader who is skimming, interrupted, and looking for one specific thing. That
is the actual reader of every doc, including the ones written for careful study.

Use for PR descriptions and review notes, contributor guides, architecture and onboarding
docs, and anything that already feels long or hard to scan.

## Patterns

| Pattern | Rule |
|---|---|
| Lead with the answer | Decision, action or outcome first. Context after. Nobody reads background to find out whether the doc is relevant |
| Progressive disclosure | Happy path first, then details, then edge cases, then references |
| Chunking | Small sections. Short flat lists. A 15-item list is read as none |
| Signposting | Headings, labels, summaries — so a reader dropping in mid-doc knows where they are |
| Recognition over recall | Tables, checklists, examples, templates. Prose that must be held in the head is prose that gets re-read |
| Review empathy | The reader must verify your intent without reconstructing how you got there |

## Default shape

Unless the repo already has a stronger template:

```markdown
# {Outcome-oriented title}

{One paragraph: what changed, who it helps, why it matters.}

## Quick path
1. {First action}
2. {Second action}
3. {Verification — how they know it worked}

## Details
| Topic | Decision |
|---|---|

## Checklist
- [ ] {something the reader can confirm}

## Next step
{Link or action that continues the workflow.}
```

The title states an outcome, not a topic. "Configuring the cache" makes the reader guess
whether it applies to them; "Cache config: what to set and when" does not.

## PR and review docs

Make the review path explicit, because a reviewer with no path reads linearly and runs out
of attention before the part that mattered:

- What to review **first**.
- What is intentionally **out of scope**.
- How to **verify** — a command, a flow, a test name.
- Which tradeoffs were deliberate, so a shortcut reads as a decision rather than an
  oversight.

## Rules

- Cut every sentence that survives its own deletion. If removing it loses nothing, it was
  costing attention for nothing.
- One idea per paragraph. Two ideas means the second gets skipped.
- Concrete over general: a path, a command, a number. "Configure appropriately" is not
  instruction.
- Never bury a constraint in prose. A limit, a required order, a destructive step goes in
  its own line or callout — a reader who misses it will not have been careless, they will
  have been skimming as designed.
- Match the repo's existing docs where they are consistent. A single well-designed doc in
  a directory of differently-shaped ones adds friction rather than removing it.
- Say what the doc does **not** cover. An unstated boundary is read as a gap in the work,
  not a gap in the doc.
