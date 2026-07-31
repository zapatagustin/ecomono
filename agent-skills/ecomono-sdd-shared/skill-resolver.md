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
4. Nothing → launch without project skills and say so. It regenerates with
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

## Compaction

The registry lives in `ecomono-memory` and in `.atl/skill-registry.md`, so a
delegator can recover its selection after a compaction by re-reading rather than
re-deciding. Because sub-agents receive exact files, skill meaning never degrades
into a generated paraphrase along the way.

## Users of this protocol

The SDD orchestrator for every phase and non-SDD delegation, `ecomono-judgment`
before each judge and the fix agent, and any future delegator. If you are writing a
new one, resolve here rather than inventing a second selection path.
