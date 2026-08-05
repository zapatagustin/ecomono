# Design

## Goal

Decouple the ecomono agent stack (Claude Code + opencode config) from NixOS so it installs
on any Linux, while keeping NixOS as a first-class consumer. **This repo is the single
source of truth**; the NixOS config imports it as a flake input rather than holding its own
copy.

## Decisions

- **Single source, NixOS consumes.** Content lives here only. `nixos-config` points at
  `inputs.ecomono` — no duplication between the two. **This was documented before it was
  implemented**; see "The migration that made decision 1 true" below.
- **Symlink read-only trees, copy runtime-mutated files.** Config the agents only read
  (agents, skills, commands, hooks, plugins) is symlinked so editing the repo is live.
  `settings.json` is *copied* once and never overwritten — Claude Code rewrites it at
  runtime (theme/model/`/config`), which a read-only symlink would break.
- **`install.sh` targets Arch/Debian/generic Linux; NixOS uses the flake.** The installer
  detects NixOS and refuses, pointing at the flake. Non-destructive and idempotent:
  pre-existing real dirs are backed up to `*.pre-ecomono.bak`.
- **No binaries fetched.** The installer used to pull `gentle-ai` from GitHub releases;
  that dependency is gone (see "Owning the stack"). `node`/`claude`/`opencode` come from
  the OS package manager or upstream installers and the script only checks and hints.
  Memory was once a fetched Go binary (`engram`) too; it is now `ecomono-memory`, built
  from source here.

## Skill topology

**One tree.** `agent-skills/` holds every skill and is mounted at `~/.claude/skills`,
`~/.agents/skills`, and `~/.config/opencode/skills` (symlinked children on non-Nix). On
Nix, only `~/.claude/skills` is a merged store dir (a `runCommand` derivation copies every
skill into one output); `~/.agents/skills` and opencode's `skills` option instead symlink
straight to the flake's own copy of `agent-skills/`, no merge step. See README's Layout
section for the destinations.

It was two trees until the gentle-ai fork. `skills/` held the vendored Spec-Driven
Development family plus `judgment-day`, `branch-pr` and `cognitive-doc-design` — 14 skills
carrying `license: MIT`/`Apache-2.0` and `metadata.author: gentleman-programming`. They were
forked into `agent-skills/` under the `ecomono-` prefix, attribution preserved per file and
in `NOTICE.md`, which also closed a real gap: the repo declared those licences while
shipping neither licence text nor copyright notice.

Forking was safe because nothing recreated them. `gentle-ai sync` and `gentle-ai install`
were invoked nowhere in this repo or its deploy path — the vendored files were committed
once in `e8a444e` and lived as plain git files, so the `<!-- gentle-ai:* -->` markers around
them were already inert.

Every marker is now `<!-- ecomono:* -->`, including the ones wrapping the persona block in
`claude/CLAUDE.md` and `opencode/AGENTS.md`. Those two were the ones that mattered: a
third party's anchor into the repo's most identity-bearing files. They are kept rather than
deleted because `check-persona-drift.sh` uses them to delimit the block it compares.

Renaming the SDD family was also safe. `gentle-ai sdd-status` and `gentle-ai sdd-continue`
were the binary's own CLI subcommands and `sdd-new` a literal token its dispatcher emitted,
so a blanket rename would have broken the integration silently; the slash commands became
`/ecomono-sdd-*` while those strings stayed put. The binary has since been removed
entirely, so the constraint is historical.

The pre-extraction NixOS layout carried yet another tree: `opencode/config/skills`, a separate
compressed copy of 24 of these skills. Compared line by line before dropping it, the compressed
variants hold no rule the shared ones lack — the diff is prose only ("Load only when user
explicitly requests X" against "Load this skill only when the user explicitly asks for X") — and
they had already gone stale, still saying `Artifact Retrieval (Engram Mode)` after the rename.
Two variants of 24 files with nothing keeping them equal is the drift machine this document keeps
running into, so both agents now read one tree.

### The register is written four times

`claude/output-styles/ecomono.md` (106 lines, the active output style),
`agent-skills/ecomono/SKILL.md` (73 lines, on demand), and the `ecomono:persona` blocks in both
`claude/CLAUDE.md` and `opencode/AGENTS.md`. The first two are different axes — cold/deep-dive is
how much warmth and context, lite/full/ultra is how much lexical compression — so they are not
redundant with each other. The two persona blocks are: same content, two agents, nothing keeping
them equal.

They had already diverged. `opencode/AGENTS.md` was missing the entire "default cold, deep-dive
only on request" rule, so on opencode the register's own default did not exist. A missing rule
reads exactly like a rule being followed, which is why it went unnoticed. Fixed, and the other
three differences turn out to be deliberate: opencode has no `Skill` tool, so its skill-loading
section names a read mechanism instead.

Deduplicating is not available — the persona block has no
source file in this repo. So the fix is detection, not merging: `check-persona-drift.sh` compares
the two blocks as sets of lines (order-independent, since a sync may reorder) and fails on any
difference not listed in it as deliberate. It also fails when a listed difference *disappears*,
which is what catches a sync clobbering a local fix on the install shapes where that happens.
Verified by re-deleting the rule and confirming the check goes red.

### Harness-shipped skills

The skills Anthropic ships with the harness (`simplify`, `review`, `update-config`, `dataviz`,
`claude-api`, …) have **no body on disk**. Searched at claude-code 2.1.220: `~/.claude`,
`~/.claude/plugins`, `~/.claude/cache`, and the entire nix store path of the package — zero
matches for any of their names. Only third-party plugins (`superpowers`, `ponytail`, `caveman`)
keep `SKILL.md` files locally.

Porting them into this repo is therefore not an option: there is no tree to symlink and nothing
to version. It is also unnecessary — they arrive with `claude`, which every install already
requires. The only real question is which ones to *use*.

**Overlaps go to the ecomono skill.** Three shipped skills cover a job an ecomono skill already
owns, and the triggers collide outright: `ecomono-review`'s own description claims "review this
PR" and `/review` — exactly what the shipped `review` skill claims. Which one the harness matches
is arbitrary, and `## Contextual Skill Loading` calls invoking a matched skill "a blocking
requirement", so the collision resolves by luck. Same failure mode as skill weight, so the same
mechanism: `claude/hooks/heavy-skill-gate.sh` now carries a second list and denies with a
redirect.

| Shipped | Redirected to |
|---|---|
| `simplify` | `ecomono-cut` (diff), `ecomono-audit` (whole repo) |
| `review` | `ecomono-review` (comment format), `ecomono-judgment` (dual adversarial review) |
| `security-review` | the `ecomono-r1-risk` agent (R1), via `Agent` |

The hook is already registered on `Skill`, so `settings.template.json` is unchanged.
`claude/hooks/test-heavy-skill-gate.sh` asserts each route, that ungated and ecomono skills pass,
and both fail-open paths.

The redirect initially lost one capability — `simplify` *applies* its fixes and `ecomono-cut` only
reported. `ecomono-cut` now has an `## Apply` section, still report-first: it applies only findings
already in the report, one edit per finding, greps callers before any `delete:` or `yagni:`, and
refuses to auto-apply cuts touching a trust boundary, data-loss-preventing error handling,
security, or accessibility. The report stays the audit trail.

**Most gaps are not worth closing.** Shipped skills with no ecomono equivalent:

| Shipped | Verdict |
|---|---|
| `update-config` | Use it. Encodes the `settings.json` and hook schema, which moves every harness release; a copy here would drift. |
| `loop`, `schedule` | Use them. Thin wrappers over `ScheduleWakeup` / `CronCreate` — nothing to reimplement. |
| `run`, `keybindings-help`, `fewer-permission-prompts` | Use them. Harness utilities with no ecomono opinion to add. |
| `dataviz`, `artifact-design`, `artifact-capabilities` | Ignore. Artifacts are not part of this workflow (`dataviz` measured 3,950 tok, noise). |
| `claude-api` | Gated, delegate. An ecomono copy would carry pricing tables that go stale. |
| `init` | **Build ours.** It writes a `CLAUDE.md` documenting a codebase; `ecomono-sdd-init` bootstraps SDD persistence, a different job. An ecomono version would emit a compressed `CLAUDE.md` rather than prose. The only candidate on this list. |

## Context economics & model routing

An earlier draft of this section proposed routing the main loop to Haiku and claimed ~90%
savings. The prices and the cost model were both wrong. Everything below is measured on this
machine: 80 real session transcripts (9,692 assistant messages, 1.55B cache-read tokens) plus a
controlled A/B of 16 headless sessions over 4 fixed tasks.

### Where the cost actually is

```
cost composition (opus prices)   cache_read 50%   cache_write 31%   output 18%
context re-read per message      ~160k tokens average
sessions <=5 messages            24% of sessions    0.3% of spend
sessions >40 messages            51% of sessions   97.1% of spend
```

The API is stateless: the whole prefix is resent every turn. A context injection is therefore
paid on every *later* turn — its cost is `size x turns_remaining x price`, not a one-time
charge. 81% of spend is that prefix. Optimising cheap turns targets 0.3% of the bill; long
sessions carrying large contexts are the other 97%.

### Model tier is 5x, not 60x

| Model | input $/M | output $/M |
|---|---|---|
| Claude Opus 5 | 5.00 | 25.00 |
| Claude Sonnet 5 | 3.00 (2.00 intro to 2026-08-31) | 15.00 (10.00 intro) |
| Claude Haiku 4.5 | 1.00 | 5.00 |

Measured Opus→Haiku ratio, triangulated three ways: 5.0x predicted from the prefix, **4.97x**
across the 80 transcripts, **5.14x** in the controlled A/B. The earlier 60:1 figure came from
Claude Haiku 3 pricing, retired.

Sub-agent model assignment already exists — every agent in `claude/agents/` carries a `model:`
field. Agents *without* one inherit the parent's model: measured, a delegation from a Haiku main
loop ran the built-in `Explore` agent on Haiku, silently collapsing the tier plan.

The same inheritance runs the other way and costs more. From an Opus main loop, a delegation to
the built-in `Explore` agent runs file search on Opus, because a built-in type has no frontmatter
to put the field in. Three separate things have to hold for that not to happen, and none do: the
delegation rule in `claude/CLAUDE.md` names an agent but no model; the `default | sonnet` row that
would cover it lives in `agent-skills/ecomono-sdd-shared/sdd-orchestrator.md`, which the same file states is *not*
loaded every turn — so for any non-SDD delegation the default is unreachable at the moment it is
needed; and a default defined in a lazily-loaded file is not a default. By contrast
`opencode/opencode.json` sets `model` explicitly on every one of its ~18 subagents plus a global
default, and does not have this bug.

Enforcement is `claude/hooks/agent-model-gate.sh`, a `PreToolUse` gate on the `Agent` tool,
registered in `settings.template.json` next to the existing entries. Payload verified first at
claude-code 2.1.220 with a capture hook registered through `claude -p --settings`, two runs:

```
tool_name                  "Agent"      (matcher "Agent" fires)
tool_input keys            description, model, prompt, subagent_type
model passed explicitly    .tool_input.model = "haiku"
model omitted              .tool_input.model absent
```

So the omission is detectable. The gate must **not** deny every omission. Frontmatter wins when
the parameter is absent, so every project agent is already correct and denying them would break
working delegations; only the six built-in types have no file to carry the field — `Explore`,
`Plan`, `general-purpose`, `claude`, `claude-code-guide`, `statusline-setup`. Three further
boundaries: an absent `subagent_type` means `general-purpose`, so it is gated; `fork` is excluded
because a fork always inherits the parent model and ignores the parameter, making the demand
unsatisfiable; and unknown types pass, so a new plugin agent is not blocked by a list that has not
heard of it.

End-to-end on a headless run, same method as the skill gate — the model-less call was denied, the
reason reached the model, and it retried on its own:

```
call 1   subagent_type Explore   model absent   -> deny, reason delivered
call 2   subagent_type Explore   model "haiku"  -> ran
```

`claude/hooks/test-agent-model-gate.sh` covers the deny, the tier mapping in the reason, each of
the three boundaries above, and both fail-open paths.

### Decision: the main loop stays on Opus

Routing the main loop to Haiku is rejected. It addresses 0.3% of spend and gives up judgement
that is load-bearing. The context-ceiling rule the routing depended on requires the model to
predict a task's cost before starting it; measured compliance on Haiku was **1 of 4** runs where
the rule applied. The 242k-token payload below also exceeds Haiku's 200k context window outright.

### What saves tokens: context isolation

Delegation pays through keeping bulk out of the main thread's permanent context, not through
model-price arbitrage. Measured on the same prompt, with and without delegating:

```
delegated:  $0.0959   main-thread context  31,696 tok  (baseline, intact)
inline:     $0.0336   main-thread context  93,656 tok
```

Delegating cost 2.9x more up front and avoided 62k of permanent context growth. At Opus
cache-read prices that pays back in **2 turns**; over a 200-turn session it is roughly 100x.
Median return payload across 90 real `Agent` calls: **465 tokens**.

### Reference skills: a rare spike, not the driver

Skills load whole, up front, before their size is knowable — the only context source where the
price is invisible until after it is paid. Measured in one session of this repo, invoking
`claude-api`:

```
skill payload injected (message 11 of 72)   ~242,000 tok
prefix per message before                       44,257
prefix per message after                       386,708
attributable cost over 61 later messages          ~$7.4  of the session's ~$20
```

~37% of that session's cost was one skill body re-read 61 times. Compression via delegation:
242k → 465 tokens, ~520x.

**That figure is one session, and it does not generalise.** Sweeping all 80 transcripts for
skill-body injections found 16, across 14 sessions:

```
421,210 tok  claude-api      of which 242,150 is the session above and 179,060 one other
 25,490 tok  unidentified
  3,950 tok  dataviz
```

Two sessions hold 93% of all skill weight ever loaded here; every other injection lands between
620 and 12,750 tokens, which is noise. At corpus scale reference skills are **~1% of spend** — a
rare spike with one culprit, not a systemic driver. The gate is worth keeping because it is cheap
and fails open, but it should not be sold as the main lever, and the session that produced the
242k figure was atypical precisely *because* the work in it was about API pricing.

The actual driver is `turns × context size`. 9,692 assistant messages against a ~160k average
prefix is what produces 1.55B cache reads and half the bill. `Bash` illustrates it: 2,459 calls at
a median of 110 tokens of output each — the cost is not what a call returns, it is that a call is
a turn, and every turn re-reads the whole prefix.

An earlier draft explained the size with two aggravating factors: a 980K bundle on disk with no
`SKILL.md`, so the harness inlines the whole tree instead of using progressive disclosure, and
456K of per-language docs all inlined because this repo has no detectable source language.
**That explanation is unreproducible** — see "Harness-shipped skills" above: at claude-code
2.1.220 no such tree exists anywhere on this machine. The 242k figure itself stands, confirmed
twice by `cache_write`; only the account of *why* it is that large was resting on a disk layout
that cannot be found.

The skills in this repo are correctly structured by contrast: `SKILL.md` of 2–13KB against
bundles up to 148K, with zero inlined `<doc>` blocks — heavy content sits in reference files
loaded on demand.

The actionable split is by skill *kind*, since size is unknowable before invocation:

- **Process skills** (`ecomono*` — brainstorm, plan, tdd, debug, cut, review) are small and
  shape the whole turn → inline.
- **Reference skills** (docs, data tables) are large and get consulted → invoke inside an
  `Agent`, whose context dies on return.

### Decision: port four superpowers skills, retire the plugin

The plugin shipped 14 skills; 6 were ever invoked here, ~10 times total. It cost ~840 tok/turn of
skill listing plus a `SessionStart` hook that injects the whole `using-superpowers` body every
session — measured at a 868-token median and 5.6M token-turns of carry — to state a
skill-discovery rule `claude/CLAUDE.md` already carries under "Contextual Skill Loading". Pure
duplication.

Ported to `agent-skills/` under the ecomono prefix, so our implementations stay distinguishable
from third-party ones, at 480–600 tokens each against the plugin's 9–10KB originals:
`ecomono-brainstorm`, `ecomono-plan`, `ecomono-tdd`, `ecomono-debug`.

Not ported, deliberately:

- `subagent-driven-development` — 28KB of dispatch protocol that `_shared/sdd-orchestrator.md`
  already covers.
- `executing-plans` — self-declared fallback for harnesses without subagents
  (`executing-plans/SKILL.md:14`); never applies here.
- The rest registered zero invocations.

The claim that superpowers "runs everything in one context" is false and worth recording, because
the port inherits the opposite. `subagent-driven-development/SKILL.md:10`: *"They should never
inherit your session's context or history."* `requesting-code-review/SKILL.md:79`: *"reviewing the
diff inline burns the context window you need to keep driving the work."* It is a hybrid —
brainstorming and planning inline, implementation and review isolated. The four ported skills keep
that split and name it explicitly.

### The two premises, now encoded

Delegation here was justified only by cost. Two corrections went into `claude/CLAUDE.md`:

**Attention, not just cost.** Superseded content — a traceback from before the fix, a rejected
approach, output from code since changed — costs the same as fresh evidence and actively misleads,
however small. A cost-only rule fires on large payloads and misses this entirely: `bash_search`
has a 106-token median, so cost says "cheap" while 2,116 of them say "noise, re-read every turn".

**Isolate with a subagent, not with `/clear`.** Both produce a fresh context, but they are not
equivalent, and the popular advice to `/clear` religiously omits the price. Measured across the 25
sessions that contain one:

```
skill_listing        re-injected to 9,397 tok avg   (vs 3,435 for a single injection)
deferred_tools       3,166 tok avg
agent_listing        3,045 tok avg
mcp_instructions     1,244 tok avg
```

A `/clear` re-pays the whole per-session structural block and discards the prompt cache, so the
next turn is full-price input rather than a cache read. A subagent returns a 434-token median and
leaves the main thread's cache intact. Subagent strictly dominates for isolation; `/clear` is for
a real change of task.

### Where the context actually goes: 283 transcripts, carry-weighted

The corpus sweep above ranked categories by raw payload. Raw payload is the wrong unit: an
injection is re-read on every *later* API call in the session, so a small result landing early
outweighs a large one landing last. Re-measured across 283 sessions and 12,479 main-thread
assistant calls, weighting each payload by the turns that follow it (`carry`, in token-turns):

```
 83.7M  18.1%  bash_search      2,116 calls  median   106 tok   <- delegatable
 79.3M  17.2%  read_file          578 calls  median   570 tok   <- delegatable
 65.5M  14.2%  skill_listing      264 inj.   median 3,435 tok
 36.9M   8.0%  SessionStart hooks               plugin loaders
 29.3M   6.3%  agent_listing                 median 2,126 tok
 27.5M   6.0%  deferred_tools (MCP)          median   998 tok
 20.5M   4.4%  bash_test_build    572 calls  median   108 tok   <- delegatable
 14.5M   3.1%  nested_memory       28 inj.   max   21,531 tok
  4.9M   1.1%  edit_write         765 calls  median    42 tok
  2.4M   0.5%  mcp_docs (context7) 13 calls  max    1,646 tok
  1.3M   0.3%  web_fetch_search    44 calls  max    1,278 tok
```

Two conclusions, both of which cut against the intuitive read:

**~44% of carry cannot be delegated at all.** `skill_listing`, hook loaders, `agent_listing` and
`deferred_tools` are fixed per-session injection — no subagent touches them. They are a config
diet, not a delegation problem. Median structural overhead is **5,827 tok** per session (p90
15,029), paid on every call before any tool runs.

**Fetching is not a driver.** `WebFetch`/`WebSearch` cap at 1,278 tokens and context7 at 1,646 —
results arrive already distilled, not as raw pages. Screenshots: 2 in the entire corpus. Rules
for either would be speculative weight; none were added.

`edit_write` at 1.1% of carry (median 42 tok, 765 calls) confirms the asymmetry the delegation
rules rest on: **reads are expensive and discardable, writes are neither.** Routing edits to a
cheaper subagent would add a cold file read and a prompt restating the diff, to isolate 1% of
carry. 42.9% of all tool-result payload already lives in sidechains, so isolation works where
it is applied — the gap is compliance, not mechanism.

Usage data from the same sweep, for pruning the fixed 44%:

```
skills      91 ever listed    17 ever invoked   74 never    ~56 tok each per turn
MCP         claude_ai_*: 6 of 7 servers at 0 calls, listed in ~144 sessions each
agents      general-purpose 69 spawns   vs   ecomono-explore 7
```

The `caveman`/`ck`/`ponytail`/`engram` skill families in that "never invoked" set are historical —
`installed_plugins.json` now holds only `superpowers` and `typescript-lsp`, so those 31 listings
are already gone. The live residue is the zero-call `claude_ai_*` servers and this repo's own
unused skills.

The agent split is a real finding: the rule names `ecomono-explore`, but delegation actually
routes to `general-purpose` 10x more often. `ecomono-explore` is read-only, so any task that
ends in an edit cannot use it — there is no general writer agent to fall back to.

### Effort: measured, then left alone

A third arm ran the same four tasks on Opus at `effortLevel: medium`. Behaviour changed
substantially:

```
turns/run     high 7.4  →  medium 4.9   (-34%)
tools/run     high 5.8  →  medium 3.9   (-33%)
output/run    high 1844 →  medium 1224   (-34%)
```

On the exploration task both arms produced the same answer with the same file-and-line
citations, so `medium` lost nothing there. Its **cost** numbers are unusable: passing
`--settings` to override effort broke cache reuse, so every run in that arm paid 11–48k of
`cache_write` at 2x where the control paid 104–199 tokens of it. That is a harness artifact, not
an effect of effort.

This was first dismissed by pricing it against output: output is 18% of spend, so a 34% cut is
worth ~6%, which did not justify the quality risk. **That framing was wrong.** The load-bearing
number is not output but the -34% in *turns*, and turns drive `cache_read` — 50% of spend, since
every turn re-reads the whole prefix. On that basis the change is worth roughly **17%**, about
seventeen times the reference-skill gate above.

It is still not shipped, because only exploration was verified equivalent and 97% of spend sits in
long sessions doing design and debugging, which is what `high` buys. But it is now the largest
measured lever available and deserves a real trial rather than a dismissal: set `medium`, work
normally for a week, and compare transcripts before and after. That measurement costs nothing —
the data accumulates in `~/.claude/projects` on its own — and it avoids the cache confound that
made the headless arm's cost figures useless.

### Rate limits are counted in tokens, not dollars

The two meters diverge. `cache_read` is billed at 0.1x input but counts **in full** against plan
rate limits, and it is ~95% of the tokens a long session moves. Dollar intuition therefore
mispredicts limit consumption by an order of magnitude: a session can look moderately priced and
still exhaust an hourly allowance.

The session that produced this document is the worked example. 205 messages, a 534,804-token
prefix by the end, and **88,130,387 tokens against the limit** — 84M of it cache reads. Roughly
31k of that prefix is the base system prompt, 242k the `claude-api` body loaded at message 11, and
the remainder accumulated tool output and printed tables. Measuring the failure mode inside the
session being measured is what produced it, which is why `CLAUDE.md` now also routes measurement
output to a file rather than into the thread.

The cheapest optimisation for a session already in this state is not a config change — it is a new
session. A fresh one starts at ~31k, 17x cheaper per turn.

### Files changed

- `claude/CLAUDE.md`: added `## Context discipline` — the ceiling rule, the large-file rule, the
  process-vs-reference skill rule, and a rule routing measurement output to a file rather than
  into the thread. ~140 tokens of permanent prefix.
- `claude/settings.template.json`: unchanged. `effortLevel` stays `high`, `model` stays
  `opus[1m]`.

Rejected from the earlier draft:

| Proposed | Rejected because |
|---|---|
| `settings: model → haiku` | 0.3% of spend; costs the judgement the main loop needs |
| Lean-rewrite `CLAUDE.md` | 1.1k of a 31k prefix = 3.5%; noise |
| `agents/sdd-orchestrator.md` | Duplicates the existing 32KB `agent-skills/ecomono-sdd-shared/sdd-orchestrator.md` |
| `agents/sdd-orchestrator-opus.md` | A second copy of the same file; guaranteed drift |
| `agents/explore-agent.md` | The built-in `Explore` agent already covers it |
| `commands/sdd-*` triggers | They already point at the orchestrator protocol |

The earlier draft's stated problem — "the SDD protocol loads every turn" — was already false:
`claude/CLAUDE.md` holds it as an on-demand pointer and `commands/sdd-*.md` read it only when a
cycle starts.

### Status: prompt rules ineffective, enforcement moved to a hook

End-to-end verification after the change reached `~/.claude/CLAUDE.md` (home-manager
generation `rdw36nm0…`): **neither rule fires.** On Opus, a question spanning three subsystems
drew 4 `Read` and 6 `Bash` calls inline with no delegation; a question about API pricing invoked
`claude-api` through the `Skill` tool in the main thread, writing 250,123 cache tokens and
costing $2.54 to answer with two numbers. That write figure also confirms the ~242k estimate
above to within 3%.

Two corrections follow. First, non-compliance is not Haiku-specific — the 1-of-4 figure above
should be read as a property of the rule, not the model: it asks for a *prediction* ("will this
need 4+ files?") before the work that would answer it. Second, the reference-skill rule loses an
instruction conflict it cannot win by wording: the persona block calls invoking a matched skill
through the `Skill` tool "a blocking requirement", and `claude-api`'s own trigger text says never
to answer from memory. Two specific, imperative, repeated instructions outrank one bullet — and
the conflicting one sits inside the persona markers, now `ecomono:persona` and no longer a third party's anchor.

That last point is platform-dependent and the original phrasing was too strong. `install.sh`
symlinks `claude/CLAUDE.md` and `opencode/AGENTS.md` from the repo, so on Arch/Debian a sync
follows the symlink and overwrites the repo file — edits there are indeed lost. On NixOS both
land as read-only nix store paths, so sync cannot write them at all and an edit survives. Editing
the persona is therefore futile on one install shape and durable on the other, which is not a
foundation to build enforcement on. The gate below stays the mechanism either way.

So the prompt rules stay as documentation of intent at ~110 tokens, and enforcement moved to a
`PreToolUse` gate on the `Skill` tool — `claude/hooks/heavy-skill-gate.sh`, registered in
`settings.template.json` alongside the existing `check-diff-size.sh` entries.

The mechanism was verified link by link before shipping: `PreToolUse` does match `Skill`; the
payload carries `tool_input.skill`, so a name is available to gate on; `permissionDecision:
"deny"` blocks the call; `permissionDecisionReason` reaches the model; and the model then
delegates on its own. Measured on the same pricing question that cost $2.54 inline:

```
without the gate   cache_write 250,123   $2.5413   body injected into main thread
with the gate      cache_write   1,714   $0.4222   body injected: none
```

Same correct answer, 83% less cost, 146x less cache_write on that invocation — and the saving
compounds mid-session, where the inline body would have been re-read on every later turn.

Two properties worth keeping in mind. The gate **fails open**: a missing `jq` or an unparseable
payload exits 0, because a gate that errors closed would block every skill in the session. And
the denylist is **manual and should stay short** — on a cheap skill the gate is a net loss (the
model spends a denied call plus a delegation round trip on something whose body was small), so an
entry belongs there only after its weight has been measured.

### The second reason the 4-file rule never fired

The diagnosis above — the rule asks for a prediction before the work that would answer it — was
right but incomplete. There is a second cause, and it is not a wording problem.

The harness injects two lines into the system prompt *below* `CLAUDE.md` and below the output
style: "Do not call the AgentTool unless the user requested it" and "Do not use workflows or
deep-research unless the user requested it". They are in no file this repo ships — checked
`claude/`, `skills/`, `agent-skills/`, `claude/output-styles/`, `~/.claude/plugins/`, and the
consuming `nixos-config`. Origin is unconfirmed: claude-code 2.1.220 ships as a native binary and
the string is not recoverable with `strings`, so whether a custom `outputStyle` is the trigger is
untested. The one cheap test is a session with `--output-style neutral`, checking whether the
lines still appear.

Either way the conflict is structural, and it explains the shape of the earlier failure: a
question spanning three subsystems drew reads inline and no delegation, because the last word in
the prompt said not to delegate unasked. Both gates only *shape* delegations that happen —
`agent-model-gate.sh` fixes the tier, `heavy-skill-gate.sh` redirects a heavy skill into a
subagent. Neither one causes a delegation, so an instruction suppressing them at the top left the
whole discipline inert.

The fix is a prompt rule, which this section otherwise argues against — justified here because the
thing being overridden is also a prompt rule, not a mechanism, and user instructions outrank the
output-style block. `CLAUDE.md` now states that the triggers *are* the standing request. The
workflows/deep-research half is left in force; nothing here wants those firing unasked.

The routing target changed with it. The rule named the built-in `Explore`, which has no
frontmatter and so inherits the main loop's model — `agent-model-gate.sh` denies it until a
`model` is passed, making every general exploration pay a deny plus a retry. `claude/agents/
ecomono-explore.md` carries `model: sonnet` and passes untouched. It is named `ecomono-explore`
rather than `explore` so that subagent-type resolution can never confuse it with the built-in.

### Reproducing the measurement

Transcripts at `~/.claude/projects/*/*.jsonl` carry per-message `usage`. Sum
`cache_read_input_tokens + cache_creation_input_tokens` per assistant message for real prefix
growth, and price reads at 0.1x input, writes at 1.25x (5m TTL) or 2x (1h TTL). Do not estimate
from a token count alone — cache state dominates the result.

## The migration that made decision 1 true

Decision 1 above claimed `nixos-config` consumes this flake. It did not. `nixos-config` had no
`ecomono` input and no node for it in its lock; `modules/home-manager/claude-code/default.nix` and
`.../opencode/default.nix` sourced their own `./claude` and `./config` trees, and
`modules/home-manager/ai/default.nix` carried a line-for-line duplicate of this flake's activation
script. A rebuild rebuilt from those copies, so a change committed here reached nothing.

The symptom that exposed it: a hook shipped from this repo never appeared in `~/.claude/hooks`
after a rebuild. `~/.claude/CLAUDE.md` matched the `nixos-config` copy byte for byte and differed
from this repo — and had been missing the fourth `## Context discipline` bullet since it was
written, which is why that rule never fired in any session.

Neither tree was a superset, so the merge was not mechanical:

| Behind here | Behind there |
|---|---|
| engram → ecomono-memory rename across the SDD prose | `programs.opencode.skills`, never set by this flake |
| `_shared/sdd-orchestrator.md` | a 474K `memory.plugin.js` bundle this repo does not version |
| the top-level opencode `permission` block | 24 compressed opencode skill variants |

Three resolutions, each recorded where it belongs above: `skills = ./skills` closes the first gap;
`memory.ts` plus the shipped `storage/` replaces the bundle; the compressed variants go. The
`permission` block was the one real loss and the reason to check rather than assume — the
extraction had left it under `agent.orchestrator`, so the deny rules for `.ssh`, `.env`,
`credentials.json`, `*.pem` and `*.key`, and the `ask` gates on `git push`, `git rebase` and
`git reset --hard`, applied to one agent instead of every one. Restored at top level.

One regression was introduced and caught before shipping: this flake's activation script resolved
`claude` with `command -v` alone, where the deleted module used an absolute store path. The HM
activation service does not reliably carry the new profile on `PATH`, so plugin and MCP
registration would have failed silently. It now falls back to `config.home.profileDirectory`
before giving up, still without pinning a `claude` package.

The pattern behind all of it, and behind the persona blocks and the model inheritance above: a
value defined in one place while the consumer reads another. Every instance was invisible for the
same reason — an absent rule reads exactly like a followed one. That is why the enforcement in this
repo is hooks and drift checks rather than prose.

## Portability notes

- Only `opencode/tui.json` needs install-time patching (`/home/agustin` → `$HOME`): it's
  JSON and can't expand env vars. `memory.ts`'s hardcoded fallback was fixed at source to
  `${process.env.HOME}`.
- `opencode/plugins/` stays a writable real dir — opencode installs `node_modules`
  alongside the plugin sources at runtime.

## Owning the stack

Three dependencies were removed rather than maintained. Each removal is recorded because
each one looked load-bearing and was not.

### superpowers

14 skills, of which 6 were ever invoked here (~10 times total). It cost ~840 tok/turn of
skill listing plus a `SessionStart` hook injecting the whole `using-superpowers` body every
session — measured at a 868-token median and 5.6M token-turns of carry — to state a
skill-discovery rule `claude/CLAUDE.md` already carried. Pure duplication.

Four were rewritten from scratch as `ecomono-brainstorm`, `ecomono-plan`, `ecomono-tdd`
and `ecomono-debug`, at 480–600 tokens each against the plugin's 9–10KB originals.
`subagent-driven-development` was skipped because the orchestrator protocol already covers
it, and `executing-plans` because it is a self-declared fallback for harnesses without
sub-agents. `flake.nix` and `install.sh` now uninstall the plugin using the same retirement
pattern as the old engram plugin, so existing installs converge instead of keeping it.

The claim that superpowers "runs everything in one context" is false and worth recording,
because the ports inherit the opposite. `subagent-driven-development/SKILL.md:10`: *"They
should never inherit your session's context or history."* It was a hybrid — brainstorming
and planning inline, implementation and review isolated — and the four ports keep that
split and name it.

### The vendored SDD family

Fourteen skills under `skills/` were third-party work, not ours renamed: `license: MIT` or
`Apache-2.0` with `metadata.author: gentleman-programming`. Forked into `agent-skills/`
under the `ecomono-` prefix, then **rewritten from scratch** — see `NOTICE.md` for what is
and is not owed.

The rewrite dropped `openspec` entirely. It was never our convention: it is the on-disk
layout the `gentle-ai` binary read natively, and no project on this machine has an
`openspec/` directory. With it went the four-mode persistence matrix, the whole Native SDD
Dispatcher Guard, the `gentle-ai.sdd-status` schema, and every field that existed only
because artifacts used to be files.

Dropping it exposed a real gap: delta specs had nothing to be delta against, because
`openspec/specs/` had been the main-spec store. So `spec/{capability}` is now the
accumulated baseline, merged by archive. That makes the system cumulative rather than a
pile of per-change tickets — `verify` can check against the system's specified behaviour
rather than only the change in front of it.

It also introduced the one irreversible operation in the system. Of the four delta
operations, `ADDED` and `RENAMED` are safe and `REMOVED` already demands `Reason` and
`Migration`; only `MODIFIED` *replaces*, so a partially copied block silently deletes the
scenarios it omitted, and a memory upsert has no git behind it. Guarded in four places,
cheapest first: spec counts its own block at authoring time, verify re-checks before
archive runs, archive **blocks** rather than warns, and archive keeps
`spec/{capability}/prev` one revision deep. Volume still stops a merge even when counts
pass.

Measured result: 16,824 words of shared contracts and the two heaviest phases became
10,380, and the whole `agent-skills/` tree carries no upstream expression.

### The gentle-ai binary

`gentle-ai skill-registry refresh` was its last live use. Its output is 50 lines — header,
sources, contract prose, a table of (name, description, scope, path), loading protocol — so
`claude/hooks/ecomono-skill-registry.js` reproduces it in ~180 lines with no dependencies
and a `--selftest` over the frontmatter parser, which caught a leading-space bug in folded
descriptions before it shipped.

Its other two subcommands were never reachable: `sdd-status` and `sdd-continue` read only
`openspec/changes/`, and the contract already routed the default store around them with a
documented manual fallback. Removing the binary degrades to the path that was already
being taken.

Gone with it: `nix/gentle-ai.nix`, the flake package output and `home.packages` entry, the
installer's binary fetch, `BIN_DIR`, `ECOMONO_SKIP_BINARIES`, and three now-unreachable
helpers in `lib/common.sh`. **This repo fetches no binaries.**

### The drift machine, closed

`opencode/opencode.json` embedded a hand-maintained 3,384-word copy of the orchestrator
protocol. The rewrite left it untouched, so on opencode the orchestrator still followed the
old protocol — shelling out to a deleted binary, offering artifact stores that no longer
existed, unaware of the baseline.

Fixed by deleting the duplication, not syncing it. The ten phase agents in the same file
already used a pointer, and the orchestrator has `read: true`, so it now points at the
protocol file the same way: 3,384 words to 116. This section had already named two copies
with nothing keeping them equal as the recurring failure here; that was the last one.

### What was worth taking from RDD

Upstream gentle-ai replaced its review control plane with **Receipt-Driven Development**:
review runs after the candidate exists, the candidate is a hash of the diff bytes, the
reviewer tier comes from risk evidence, and every delivery gate validates one immutable
receipt.

Most of it is Go — a CAS-locked authority store under `.git/gentle-ai/review-transactions/v3/`,
hash-bound state transitions, five delivery gates, an AST test asserting that any command
named in a refusal actually resolves the block. This repo fetches no binaries, so none of
that is portable. Ported as prose instead:

| Idea | Where it landed |
|---|---|
| Candidate freeze | `ecomono-judgment` hashes the diff before launching judges, re-checks at each later checkpoint the skill defines, discards the round if the bytes moved |
| Receipt | Written twice from one verdict: a file named by the hash under the git common directory, which is what a shell gate can read, and a `mem_save` at `review/{subject-hash}`, `type: decision`, which is what a later session can search |
| Gate validates the receipt | Two readers of one receipt: one of archive's four gates, fed the hash by the orchestrator because the archive agent has no `Bash`, and `claude/hooks/review-receipt-gate.sh` on `git push` / `gh pr create`, which recomputes the hash and reads the file copy. The second runs on both harnesses — `opencode/plugins/review-receipt-gate.ts` shells out to the same script rather than porting it |
| Tier by evidence, not size | The pre-pr trigger rule, rewritten. Size went back to being the review workload guard's problem |

Deliberately not taken: the seven audit ledgers, the 36-journey friction bench, shadow
evaluation, the digest-pinned JSON contract mode, the v1/v2/v3 authority-root versioning,
and the `rdd-defect-workflow` skill — every one of them exists to make a *team's* migration
provable, and there is one operator here.

Declined once and then taken: the kill switch. While the gate lived only in the archive
phase's prose, upstream's `review mode disable` was ceremony here — the archive gate reuses
the partial-archive idiom, reporting unreviewed and letting the user decide, and one operator
who can decline *was* the kill switch. That reasoning expired the moment a hook could block
`git push`. It shipped as the `ecomono/review-mode` marker; see "What the port still owes".

The upstream gap worth knowing: gentle-ai's own `sdd-archive` prose still hard-requires
`reviewGate.result: allow` while its native gate already allows. Prose and code disagreeing
is the failure this document keeps returning to. The gate ported here is the code's
behaviour, not the prose's.

### Why there is no check for the Key Learnings convention

Every delegated agent is supposed to close with a `## Key Learnings` section. The 10
`ecomono-sdd-*` phase agents do not duplicate the wording: each one's `claude/agents/*.md`
says "per the same §D" and its `opencode.json` prompt just points at that phase's
`SKILL.md`, which in turn references `sdd-phase-common.md` §D — one shared source. The
convention *is* duplicated, verbatim, in the seven agents outside that group —
`ecomono-judge-a`, `ecomono-judge-b`, `ecomono-judge-fix`, and `ecomono-r1`–`r4` — each of
which carries the same paragraph both in `claude/agents/*.md` and again in its
`opencode.json` prompt string, with nothing keeping the two copies equal. `ecomono-judge-fix`
shipped without it and nobody noticed, which is the usual argument for a drift check. One
was written, and it was deleted four review rounds later.

It kept passing while the instruction was absent. Each round closed one bypass and the next
round found another shape:

| Round | How it passed with no instruction |
|---|---|
| 1 | A thin opencode prompt was exempted by matching the wording "read your skill file at", without ever opening the file it named. `ecomono-sdd-onboard` was a live case — its SKILL.md had no instruction and no `sdd-phase-common.md` reference |
| 2 | The exemption resolved the path, but the match was `key[ _]learnings` anywhere in the text: a passing prose mention counted |
| 3 | Fences were stripped, so the match moved to a `~~~` fence, or an unterminated ``` fence the stripper's paired regex never saw |
| 4 | A sentence that *denies* the convention — "this phase does not emit `key_learnings`" — satisfies the anchor. So does a table cell documenting another agent, and an HTML comment |

The last two have no syntactic fix. "Does this file carry a live closing instruction" is a
question about what a sentence means, and every hardening pass answered a different,
narrower question that a new shape then walked around. The check also failed in the other
direction: an unterminated fence early in a file pairs with the next closing fence and
swallows a genuine instruction, reporting drift on a compliant agent.

So the convention is documented in `sdd-phase-common.md` §D and enforced by nothing. That is
a worse guarantee than a working check and a better one than a check that reports `ok` while
the thing it guards is missing — which is the failure mode this document names over and over,
and which the check reproduced four times in a row.

The distinction worth keeping: `check-persona-drift.sh` diffs two persona blocks as sets of
lines and fails on any difference not listed as deliberate — purely syntactic, no judgment
about what either block means. Most of `check-gate-drift.sh` has that same shape: it counts
`###` gate titles in the skill file and confirms each one is also named in the agent's gate
list, and that the spelled-out count agrees across three files. But one of its four checks
does not — the check that the two `/ecomono-sdd-archive` command files forward the subject
hash is a bare `grep -qF 'SUBJECT HASH'`, presence-only, the same shape that failed for
key-learnings four times. It has not yet drifted into a false pass, but nothing about the
check rules that out; a command file could mention `SUBJECT HASH` in an unrelated sentence
and still pass. Before writing the next check, decide which shape it is — a two-artifact
comparison, or a claim about what a sentence means — and do not assume presence checks are
safe just because this one has not failed yet.

### What the port still owes

Measured against the five ideas named above as RDD's irreducible core, two shipped, one was
declined on purpose, and two are missing:

| Idea | State |
|---|---|
| Candidate freeze, bound to a hash of the reviewed bytes | shipped |
| Reviewer tier from risk evidence, not diff size | shipped |
| A kill switch that is structurally absent when off | shipped, once the gate became a hook that can actually block — the `ecomono/review-mode` marker |
| A refusal may name a command only if running it resolves the block | followed by the push gate's refusal, asserted by its test on both harnesses. Not enforced anywhere as a rule, and deliberately not: upstream's version is an AST test over refusal strings, which is a question about what a sentence means — the shape this document has already buried twice |
| One receipt validated identically at **every** delivery gate | two of upstream's five — `pre-push` and `pre-pr` — plus archive, which is this repo's own boundary and not one of the five. Both harnesses now, from one script |

Upstream validates a receipt at `post-apply`, `pre-commit`, `pre-push`, `pre-pr` and
`release`. The port originally checked one of those, in the archive phase, which meant the
receipt mattered only if someone ran `/ecomono-sdd-archive` — an ordinary commit and push
consulted nothing, and the nine commits that built and reviewed the mechanism were themselves
pushed without the gate ever firing.

**The cause was a design decision, recorded here as a mistake.** The receipt was made a
`mem_save` observation, which was the lazy choice and cost no new storage. But the memory
store is reachable only through MCP tools inside an agent session, and the only surface in
this repo that can actually block a delivery is `claude/hooks/`, which is shell. A shell hook
cannot read `review/{hash}`. Upstream's gates work because its receipt is a file under
`.git/gentle-ai/review-transactions/v3/`. That difference was noted while planning the port
and then designed away, which put the receipt out of reach of the one thing that could
enforce it.

**Both halves now exist.** `ecomono-judgment` writes the verdict twice, and
`claude/hooks/review-receipt-gate.sh` reads the file copy on `git push` and `gh pr create`.

The file is `$(git rev-parse --git-common-dir)/ecomono/receipts/{subject-hash}`, first line
the verdict token alone, so the gate reads one line and refuses on anything but `APPROVED` —
an `ESCALATED` receipt blocks rather than passes. It sits under the git directory rather than
in the work tree because the subject hash covers `git diff <merge-base>`: a receipt written
beside the reviewed code would alter the bytes it certifies as it was written.
`--git-common-dir` rather than `--git-dir` keeps one receipt visible from every worktree,
since the reviewed bytes do not change per worktree.

The gate recomputes the hash with the skill's formula, unchanged. The skill resolves the base
branch by judgment and a hook cannot, so the gate tries every plausible base —
`@{upstream}`, `origin/HEAD`, `origin/master`, `origin/main`, `master`, `main` — and accepts a
receipt matching any of them. This is the one place the port deliberately widens rather than
duplicates: two independent derivations of one hash that can disagree is a defect this repo
has already shipped once, and a wrong base simply produces a hash no receipt was ever written
under. The empty-diff hash `e3b0c44298fc` is skipped rather than matched, closing the skeleton
key the freeze guards already refuse to create.

Widening is not symmetric, which is why `git config ecomono.reviewBase` exists. A base that
resolves but is *wrong* — a stale local `master` in a repo whose real base is `develop` —
produces a hash nobody signed and denies a delivery holding a perfectly good receipt, and
re-running the review does not help, because the skill keeps writing the receipt under the
base it correctly resolved. Configured, that branch is used alone. It was found by a judge
who reproduced the lockout rather than reasoning about it.

Two states that look alike are kept apart. No base resolves at all — a repo on `develop`
before its first `push -u`, which is ordinary — means the gate cannot tell what is being
delivered, so it asks and names the config that fixes it. A base that resolves with an empty
diff means there is nothing under review, so it allows. Collapsing those two into one silent
allow would make "the gate could not run" indistinguishable from "the review passed", which
is the failure this whole mechanism exists to prevent.

The hook is registered with a bare `Bash` matcher and no `if:` clause, unlike
`check-diff-size.sh`. Measured against a live `claude -p --settings`: an `if:` clause splits
the command on shell control operators and matches each simple command's own program, so
`bash -c "git push"` never reaches the hook and neither does `git  push` with two spaces. A
filter that silently drops the deliveries the gate exists for is worse than running on every
`Bash` call, which `secret-access-gate.sh` already does. The same probe confirmed that
`permissionDecision: "deny"` is honored under `bypassPermissions`, which only `"ask"` had been
measured for before.

The release valve took three rounds to get right, and each correction came from a judge
reproducing the failure rather than arguing it. As an unanchored substring it was defeated by
a legal branch name: `git push origin HEAD:refs/heads/x-ECOMONO_ALLOW_UNREVIEWED_PUSH=1`
disarmed the gate with no malice and no contrivance. Anchored to a leading assignment but
matched on the raw command, it then refused the ` cmd` habit that keeps a line out of shell
history — the override the refusal text itself recommends. And anchored with a trailing
wildcard, `ECOMONO_ALLOW_UNREVIEWED_PUSH=1 echo hi && git push` let an arbitrary unreviewed
push through: the assignment authorised a command it was not attached to, one that in real
shell semantics never sees the variable at all. Closing that with a chaining check left one
more: `ECOMONO_ALLOW_UNREVIEWED_PUSH=1 $(git push somewhere) git push` contains none of `&`,
`;`, `|` or a newline, and the shell runs what is inside the substitution while building the
argv. Closing *that* broke `gh pr create --body "$(cat <<'EOF' … EOF)"` — the idiom this
repo's own instructions call canonical — because the scan cannot tell a chain operator from
the same byte inside a quoted argument.

**So the single-command enforcement was deleted rather than fixed again.** Four rounds found
four shapes of one three-line check, each after the previous fix, and the fourth was refusing
ordinary commands while still admitting shapes nobody had listed. "Is this one command" is a
question about shell grammar; a substring scan cannot answer it, and every partial answer cost
either a delivery or a false refusal.

The override now authorises the whole command line — every delivery chained into the same tool
call, not one. The first version of this paragraph justified that with "whoever types the
prefix already typed the rest of the line", and the next round's judges both refused it: the
Bash tool call is composed by the agent, and no hook can tell an operator's line from one the
agent extended. The justification was wrong; the decision survives it. This gates forgetting,
not intent, and an agent set on bypassing writes the bare prefix — one token shorter than any
chain it could hide behind. A narrower override buys the appearance of safety at the price of
refusing ordinary commands. What survives is the check that answers a question about text: does
the line begin with the assignment. That stops a ref name carrying the string from disarming
the gate, which is a real accident rather than a hypothetical one.

The lesson is the same one this document keeps recording, in a new place: a check whose
question is about meaning rather than about bytes will keep passing for the wrong reason. The
key-learnings check was deleted for it after four rounds. This one was cut down to the part
that is syntactic, which is the version that survives.

Delivery detection went the other way — it got more precise, because there the question really
is syntactic. `git push` as a contiguous substring missed `git -C path push`, `git -c k=v push`,
`git --no-pager push` and `gh -R owner/repo pr create`: ordinary invocations, silently allowed,
no deny and no `ask`. The first two are the shape this hook's own test fixtures use to drive
git, and four rounds of judges read past it. The match is now token-level — find `git` or `gh`,
skip global flags, compare the subcommand — after normalising whitespace and dropping quote
characters, since `bash -c "git push"` otherwise tokenises as `"git`. `git` aliases are
resolved too, because `alias.p = push` is a habit rather than an evasion: chains are followed
(`aa` → `bb` → `push` really does push) and the value is whitespace-normalised, since a tab
after `push` slipped past a space-padded match.

Tokenising cost one regression on the way, and it is the most instructive thing in this
section. Trading the substring match for token equality closed `git -C path push` and opened
`git push;` — a semicolon glued to the verb keeps `push;` inside the token, and `push;` does not
equal `push`. So did `git push|tee log`, `git push&` and `(cd r && git push)`. The shape it
broke is more common than the shape it fixed, it was a plainly written delivery rather than
anything the ceiling covers, and two full rounds of judges reviewed that code against a
criterion that named this exact class before a third found it. The fix is to give shell control
characters their own token before splitting, which is what the shell does. The lesson is that
replacing a blunt check with a precise one is a change of failure modes, not an improvement,
until the new modes have been looked for as hard as the old ones were.

The alias lookup sits **after** the marker check, not in the token scan. In the scan it fired on
every `git status`, `git log` and `git add` in every repository the hook is installed in, armed
or not — one subprocess on the most common commands in a session, to answer a question only an
armed repository asks. Both judges measured it. The cost claim in the hook now states each tier
exactly, and a test with a `git` shim counts the invocations rather than trusting the sentence.

**And there the precision stops, deliberately.** Each round found one more shape: substring,
then flags, then quotes, then aliases, then `git${IFS}push`. `$(echo git push)`, a
backslash-escaped `gi\t push`, a parameter expansion that only becomes a separator at run time,
a `gh` alias, a wrapper script — all still pass. What the last three have in common is the whole
answer: the hook reads `.tool_input.command` **before** the shell expands it, so anything that
becomes a delivery during expansion is invisible by construction. That is a boundary, not a
backlog. A text scanner reasoning about what a string will *do* is the same shape as the
key-learnings check this document buried: a question about meaning wearing the clothes of a
syntactic test. The ceiling is written into the hook, naming what is not caught, so the next
reader inherits the boundary rather than the illusion. What changes it is the resolved argv from
a PostToolUse audit, or CI. A sixth pattern does not.

The normalisation carries one thing that is easy to get backwards, and both judges caught the
comment claiming otherwise: `read -ra` already collapses runs of spaces and tabs, so `tr -s` is
not what makes `git  push` work. What it buys is the whitespace bash does not split on — a
carriage return between the two words leaves one token, and one token matches nothing. The
comment now says that, and the CR case is pinned in the test rather than asserted in prose.

One more silent allow came from the same family. `git diff | sha256sum` writes nothing when
the diff fails, and hashing nothing produces exactly the empty-diff constant, which the loop
skips — so a partial clone that cannot serve a blob landed in "nothing under review" and the
push went through. The diff now goes to a file so its exit status is readable, and a failure
asks rather than allowing. Three states that look alike, kept apart: no base resolves, the diff
cannot be computed, and there is genuinely nothing to review.

**The kill switch stopped being ceremony at that point, so it shipped.** It was declined while
the gate lived in prose, because an operator who could simply not invoke it *was* the kill
switch. A hook that blocks `git push` is a different object. Review mode is armed per
repository by an `ecomono/review-mode` marker beside the receipts, and with the marker absent
the gate exits before it computes a hash or reads a receipt — structurally off, nothing to
bypass, which is the property upstream's `review mode disable` has and a config flag does not.
It is not literally inert: a push command in an unarmed repository still pays `jq` and two
`git rev-parse` calls before reaching the marker check, which is the honest version of the
claim. That default also keeps a globally-installed hook from arming every repository the user
owns, which is the fastest way to get a gate deleted. `ECOMONO_ALLOW_UNREVIEWED_PUSH=1`, in
the environment or as a leading prefix on the command, stands it down for one delivery without
disarming the repo.

One convention was broken deliberately. Every other hook here fails **open** on a malformed
payload or a missing `jq`, and this one does too — extended to a missing `sha256sum` and to an
unresolvable base branch. A gate that fails open is not a gate, but a review gate that fails
closed on a malformed hook payload leaves the operator unable to push the fix for the hook.
The tradeoff costs nothing in real enforcement, since anything that can empty `PATH` can also
set the release valve; a client-side hook was never protection against intent. It is recorded
in an `ecomono:` comment in the gate, as this document argued it should be.

What remains unported: `post-apply` and `pre-commit` have no reader. Neither is a delivery to
anywhere — the bytes are still local and still revisable — which is why they were not built,
not an oversight to be closed later. `release` does not exist here at all.

**The gate now runs on both harnesses, from one implementation.**
`opencode/plugins/review-receipt-gate.ts` intercepts the `bash` tool and shells out to
`~/.claude/hooks/review-receipt-gate.sh` with the same `{"tool_input":{"command":…}}` payload
Claude Code feeds it, then translates the one JSON object it prints. Until it existed, a push
from opencode was ungated even in an armed repository.

Shelling out rather than porting is the same rule that shaped the hash: two independent
derivations of one answer that can disagree is a defect this repo has already shipped once. A
TypeScript rewrite would be a second copy of the hash formula, the base-branch candidate list,
the token-level detector, the alias chase and the release valve — five things kept equal to a
shell script by nothing but attention, and it would inherit six rounds of prose without the six
rounds of fixes. The cost is one subprocess per `bash` call in **every** repository, not only
an armed one — the plugin has no marker check of its own, and the cheap exit lives inside the
script, past the spawn. Measured at 10–40 ms here. Two reviewers corrected an earlier version of
this sentence that said "in an armed repository", which undercounted where the spawn happens.

One behaviour deliberately differs. The script has three outcomes and opencode's
`tool.execute.before` has two — throw or return; throwing is how opencode's own documentation
blocks a tool call. So the two `ask` states, where the gate is armed but cannot compute a
subject, refuse on opencode instead of prompting. `permission.ask` does carry a
`"ask" | "deny" | "allow"` status, and it was rejected: it only fires when the tool actually
requests a permission, so a ruleset that allows `bash` outright would make the gate silently
stop existing — the failure this mechanism is entirely about. Stricter costs one retry after a
`git config ecomono.reviewBase`; the alternative costs the delivery.

The end-to-end test is the part worth keeping. Stubbing the script proves the translation and
nothing about the port — it is the two halves fitting together that can break, so
`opencode/plugins/tests/` drives the real script through the plugin against a real armed
repository: unarmed allows, a non-delivery allows, an unreviewed push refuses with the script's
own text, `git -C . push` and `gh -R o/r pr create` refuse, the leading-prefix valve stands the
gate down, an `ESCALATED` receipt refuses, an `APPROVED` receipt for the delivered bytes allows,
and one more commit after the review refuses again.

One guard in the plugin took three rounds and a wrong conclusion to get a test for, and the
sequence is the useful part. Writing the payload into the stdin of a script that has already
exited raises EPIPE, and an unhandled `error` event on a stream takes down the opencode process
— not the tool call — on an ordinary allowed command. Both judges removed
`child.stdin?.on("error", …)` and watched the suite stay green, which is how the original
assertion was found to be decorative.

The fault only surfaces while the event loop is still cold. Four shapes were measured with the
line deleted, 20 runs each: in the main suite 0/20 failed, alone in its own file 5/20, looping
40 attempts 1/20 — worse, because only the first attempt can fail — and with the fixture
pre-built by the runner, 2/20. **The conclusion drawn from those numbers was that the guard
could not be tested, and it was wrong.** The check was deleted and "no regression test is
possible" written into the code and into this document.

The re-judge round reopened it, and it was right to. A test does catch the mutation — 29 of 30
runs, against 0 of 30 false positives: the same logic in its own file with *nothing before the
spawn*, no `node:assert` import, no shared fixture module, no cleanup call after the await.
Importing `assert` and calling `rmSync` is enough work to take the identical test from catching
it every run to catching it none. Even the file's header comment cost a run, which is why the
prose lives here and a pointer lives there. It is not deterministic and a race never is, but a
regression that survives one run in thirty does not survive being worked on.

The judge's own explanation was wrong too, and checking it mattered: it attributed the 5/20 to a
payload near the 64 KiB pipe buffer, when that measurement used 1 MB. A sweep at 64 KiB+1,
100 KB, 200 KB, 500 KB and 1 MB reproduces at every size — the payload only has to clear the
buffer, and the pre-spawn work is what actually moved the number.

The lesson is not the one the deleted version recorded. "This cannot be tested" is a claim about
every possible test, and four failed attempts do not establish it — they establish that four
shapes failed. The rule this document keeps arriving at, applied here: a negative result needs
the same standard of evidence as a positive one, and the cheap move when a test will not fail on
a mutation is to keep removing things from the test, not to delete it.

Three more things were found by building it. `os.homedir()` is documented to read `$HOME` on POSIX and
bun does not — it resolves once at process start and ignores later assignment — so the plugin
reads the variable first, which is both the documented semantics and what lets a test point at
a fixture. And the tests live in a subdirectory because opencode auto-loads every `.ts`
directly under `plugins/`: `opencode debug info` lists `cave-compress.ts` and
`skill-registry.ts` as loaded although `opencode.json` names only `memory.ts`. A test file at
that level would be loaded as a plugin on every session start.

That auto-load also exposed a drift class rather than closing one. `install.sh` links every
child of `opencode/plugins/`; `flake.nix` listed them by hand, so a plugin added to the
directory and forgotten in the flake ships on Arch and Debian and silently does not exist on
NixOS — and the check that would catch it is a check for a list that should not have existed.
The flake now enumerates the directory with `builtins.readDir`, which deletes the class instead
of guarding it.

### Open: onboard is registered as delegated and written as interactive

`agent-skills/ecomono-sdd-onboard/SKILL.md` says it "runs **inline**, not delegated… a
sub-agent cannot have it", and carries `metadata.delegate_only: false` — the only SDD phase
skill that does. Five places disagree: `claude/agents/ecomono-sdd-onboard.md` exists with
`model: haiku`, both command files delegate to it, and the orchestrator's model table assigns
it a tier as a delegated phase. Its own procedure then asks the user to pick among options and
to approve each phase, which a delegated call cannot do — on opencode only the `orchestrator`
holds `question: true`, and the Claude agent's tool list has no ask mechanism either.

Nothing reads `delegate_only`; it is self-descriptive metadata. So this is a truth problem
rather than a runtime one, which is how it survived unnoticed.

An attempt to close it during an unrelated review made it worse and was reverted. Flipping the
flag to match the five places that delegate it left the interactive steps asserting something
the tool grants forbid. Adding a `resume_at` contract, so the orchestrator could hold the pauses
between per-phase relaunches, then failed on its own precondition: every persistence path needs
a `{change-name}`, which in the normal flow arrives as the literal `/ecomono-sdd-new <name>`
argument, and no phase here has ever had to derive one from a runtime conversation. Two blind
judges traced that independently; the receipt at `review/07569a6f9102` records the chain.

Closing it properly needs three things at once. Each is a decision, not just an edit, which is
why this is its own cycle rather than a fix to bolt onto a review of something else — the more
useful lesson here than any of the individual defects.

**1. Where a `{change-name}` comes from.** Every artifact key is `sdd/{change-name}/{type}`, and
in the normal flow that slug is the literal `/ecomono-sdd-new <name>` argument. Onboard chooses
its change mid-conversation, so no argument exists. No phase in this repo has ever had to derive
one, so there is no pattern to copy: it has to be minted, either by the pick step from the option
the user chose, or by the orchestrator when it collects that answer. Whichever mints it also has
to forward it on *every* later relaunch, not only the first — a phase name alone does not tell a
resumed agent which change it is continuing. `ecomono-sdd-explore`'s `sdd/explore/{topic-slug}`
standalone fallback does not apply, because onboard produces real artifacts.

**2. Which single persistence key.** The reverted attempt produced two, and neither read the
other: `ecomono-sdd-onboard/{project}`, project-scoped and matching `ecomono-sdd-init/{project}`,
and `sdd/{change-name}/state`, the canonical DAG-state key `memory-convention.md` defines. The two
judges disagreed on which was correct — one read the project-scoped key as a parallel invention,
the other as an established shorthand not meant to carry resume state. Note the constraint that
settles it either way: a project-scoped key cannot hold per-change state for more than one
walkthrough, and the canonical key needs decision 1 first.

**3. A read-back step.** Nothing searched the persisted state, so a compaction mid-cycle would
silently restart at the pick step with the written data orphaned. `claude/commands/ecomono-sdd-apply.md`'s
"CHECK PREVIOUS PROGRESS" step is the shape to copy; onboard has no equivalent.

One trap, because it caught this twice: `agent-skills/ecomono-sdd-onboard/SKILL.md` and
`claude/agents/ecomono-sdd-onboard.md` are loaded independently and nothing enforces they agree.
The second is where "execute all steps in this context window" lives. Editing either alone
produces two files actively contradicting each other about the same agent.

