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

### The largest single lever: reference skills

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

The global default stays at `high` regardless. Output is 18% of spend, so a 34% output cut is
worth roughly 6% — but only exploration was verified equivalent, and 97% of spend sits in long
sessions doing design and debugging, which is exactly what `high` buys. More importantly the
same saving is already captured by the delegation rule below: exploration moved into the
`Explore` agent spends its turns and output in a context that is discarded on return. One
mechanism, no cost to main-loop judgement.

### Files changed

- `claude/CLAUDE.md`: added `## Context discipline` (~110 tokens) — the ceiling rule, the
  large-file rule, and the process-vs-reference skill rule. At 200 turns that block costs ~$0.01
  per session against ~$7 saved.
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
