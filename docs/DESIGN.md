# Design

## Goal

Decouple the ecomono agent stack (Claude Code + opencode config) from NixOS so it installs
on any Linux, while keeping NixOS as a first-class consumer. **This repo is the single
source of truth**; the NixOS config imports it as a flake input rather than holding its own
copy.

## Decisions

- **Single source, NixOS consumes.** Content lives here only. `nixos-config` points at
  `inputs.ecomono` — no duplication between the two.
- **Symlink read-only trees, copy runtime-mutated files.** Config the agents only read
  (agents, skills, commands, hooks, plugins) is symlinked so editing the repo is live.
  `settings.json` is *copied* once and never overwritten — Claude Code rewrites it at
  runtime (theme/model/`/config`), which a read-only symlink would break.
- **`install.sh` targets Arch/Debian/generic Linux; NixOS uses the flake.** The installer
  detects NixOS and refuses, pointing at the flake. Non-destructive and idempotent:
  pre-existing real dirs are backed up to `*.pre-ecomono.bak`.
- **Binaries scope: fetch the hard ones, check the rest.** `gentle-ai` is a static Go
  binary from GitHub releases — the *same tarball* runs on every distro, so the installer
  fetches it. `node`/`claude`/`opencode` come from the OS package manager or upstream
  installers; the script only checks and hints. Memory used to be fetched the same way
  (the `engram` Go binary); it is now `ecomono-memory`, built from source in this repo.

## Skill topology

Three skill sets, deduplicated from the old NixOS layout (which copied `claude/skills` and
`opencode/config/skills` separately):

- `skills/` — Claude-only skills.
- `agent-skills/` — the shared set (`ecomono*`, `find-skills`, `proxy-manager`), mounted at
  `~/.agents/skills` and referenced by both agents.
- `~/.claude/skills` = `skills/` ∪ `agent-skills/` (symlinked children on non-Nix; merged
  store dir on Nix).

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

Sub-agent model assignment already exists — all 17 agents in `claude/agents/` carry a `model:`
field. Agents *without* one inherit the parent's model: measured, a delegation from a Haiku main
loop ran the built-in `Explore` agent on Haiku, silently collapsing the tier plan.

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

Two aggravating factors: the bundle is 980K on disk with no `SKILL.md`, so the harness inlines
the whole tree instead of using progressive disclosure; and 456K of it is per-language docs, all
eight of which are inlined because this repo has no detectable source language. Invoking a
reference skill from a config-only repo is the worst case of the worst case.

The skills in this repo are correctly structured by contrast: `SKILL.md` of 2–13KB against
bundles up to 148K, with zero inlined `<doc>` blocks — heavy content sits in reference files
loaded on demand.

The actionable split is by skill *kind*, since size is unknowable before invocation:

- **Process skills** (`brainstorming`, `superpowers:*`, `ecomono*`) are small and shape the whole
  turn → inline.
- **Reference skills** (docs, data tables) are large and get consulted → invoke inside an
  `Agent`, whose context dies on return.

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
| `agents/sdd-orchestrator.md` | Duplicates the existing 32KB `skills/_shared/sdd-orchestrator.md` |
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
the conflicting one sits inside the `gentle-ai:persona` markers, so `gentle-ai sync` regenerates
any edit made there.

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

### Reproducing the measurement

Transcripts at `~/.claude/projects/*/*.jsonl` carry per-message `usage`. Sum
`cache_read_input_tokens + cache_creation_input_tokens` per assistant message for real prefix
growth, and price reads at 0.1x input, writes at 1.25x (5m TTL) or 2x (1h TTL). Do not estimate
from a token count alone — cache state dominates the result.

## Portability notes

- Only `opencode/tui.json` needs install-time patching (`/home/agustin` → `$HOME`): it's
  JSON and can't expand env vars. `memory.ts`'s hardcoded fallback was fixed at source to
  `${process.env.HOME}`.
- `opencode/plugins/` stays a writable real dir — opencode installs `node_modules`
  alongside the plugin sources at runtime.
