# Skill Resolver

Any agent that launches sub-agents resolves skills through this protocol. A
sub-agent starts with no project skill context, and the registry is a cheap index
that gives the delegator enough to pick without rewriting or summarising anything.

Apply before every launch that reads, writes, reviews, tests, documents, or creates
project artifacts. Skip only for purely mechanical commands.

## 1. Get the registry

Stop at the first source that answers:

1. The session cache, if you already read it this session.
2. `mem_search(query: "skill-registry", project: "{project}")` →
   `mem_get_observation(id)`.
3. `.atl/skill-registry.md` at the project root.
4. Nothing → launch without project SKILLS and say so, but never with an empty standards
   block: name the project's own rules instead and report `fallback-path`. A judge found
   this step and `ecomono-judgment`'s gates table prescribing opposite actions for one
   trigger, which matters now that `claude/hooks/judge-standards-gate.sh` refuses a launch
   carrying no block at all. It regenerates with
   `node ~/.claude/hooks/ecomono-skill-registry.js --cwd <repo>`, and also runs on
   every user prompt, so an empty registry usually means malformed frontmatter
   rather than a generator that never ran.

## 2. Match

| Dimension | Match against |
|---|---|
| Code / files | The trigger column names the language, framework, tool, or path |
| Task / action | The trigger column names the action: PR, review, docs, tests, release |

Smallest useful set. Past five matches, keep the five most relevant and let code
context beat task context — a skill about the file being edited outranks a skill
about the kind of work.

## 3. Pass paths, never summaries

```markdown
## Skills to load before work

Read these exact files before reading, writing, reviewing, testing, or creating artifacts:

- /absolute/path/to/agent-skills/ecomono-docs/SKILL.md
- /absolute/path/to/agent-skills/ecomono-pr/SKILL.md
```

`SKILL.md` is the runtime contract. A summary you generate is a second version of
someone else's rules with nothing keeping the two equal — it will drift, and the
sub-agent will follow the drifted copy.

## 4. Report resolution

Every sub-agent returns `skill_resolution`. The four values and their meanings are
defined once, in [sdd-phase-common.md](sdd-phase-common.md) §D — the file every phase
already loads. Read them there rather than restating them here, so the two never drift
apart.

Anything other than `paths-injected` means the delegator did not do its job: re-read
the registry before the next launch instead of letting every sub-agent pay to
rediscover the same paths.

`paths-injected` is about receiving exact FILE PATHS from the delegator, not about where the
delegator found them. Registry-resolved `SKILL.md` paths are the case this protocol exists for,
and for SDD phases they are the only correct answer. A delegator reviewing an arbitrary diff may
instead name the project's own standards directly — `claude/CLAUDE.md`, specific `docs/DESIGN.md`
sections — and a sub-agent that receives those has still received paths and should say so. What
`none` means in every case is the same: the sub-agent was handed nothing to review against and
had to invent its own bar.

## Compaction

The registry lives in `ecomono-memory` and in `.atl/skill-registry.md`, so a
delegator can recover its selection after a compaction by re-reading rather than
re-deciding. Because sub-agents receive exact files, skill meaning never degrades
into a generated paraphrase along the way.

## Users of this protocol

The SDD orchestrator for every phase and non-SDD delegation, and any future delegator. If you
are writing a new one, resolve here rather than inventing a second selection path.

`ecomono-judgment` is a scoped user, and the scoping is measured rather than assumed. It resolves
here when the target is SDD-shaped work, where the phase skills ARE the contract being reviewed.
**SDD-shaped** means exactly one thing, stated because leaving it to judgment would just move the
original problem: the target is a phase's own artifacts or the files implementing them — anything
under `sdd/{change-name}/`, or a change to an `ecomono-sdd-*` skill, agent or command. Everything
else is an arbitrary diff.
For an arbitrary diff it builds its standards block from the project's own rules instead: eight
judge runs and two fix runs in one session resolved nothing from the registry while their
delegator hand-wrote a richer block than the registry would have yielded, because the registry
lists skills and most of them have nothing to say about the code under review. The requirement
that survived is the one those ten runs actually met — judges and the fix agent get the SAME
block — not the mechanism they all skipped.
