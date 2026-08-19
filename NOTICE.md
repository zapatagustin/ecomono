# Notice

What in this repo came from somewhere else, and what is owed for it.

## Lineage: gentle-ai — Gentleman Programming

Upstream: <https://github.com/Gentleman-Programming/gentle-ai>

The Spec-Driven Development workflow here started as fourteen vendored skills from that
project — the SDD phase family plus `judgment-day`, `branch-pr` and
`cognitive-doc-design` — which carried `license: MIT` or `Apache-2.0` and
`metadata.author: gentleman-programming`.

**Every one of them has since been rewritten from scratch.** Not renamed, not edited:
each file's text was replaced, and the structure changed with it. The openspec artifact
layout was removed entirely, the four-mode persistence matrix collapsed to two, a
cumulative main-spec baseline was introduced where none existed, the native-dispatcher
integration was deleted along with the binary it called, and roughly half the remaining
words were duplication of contracts that now live in one place.

No upstream expression survives, so no attribution is owed and the per-file
`derived_from` markers have been removed. What was taken and kept is the **idea**: the
phase sequence, the delta-spec model, blind dual review. Ideas are not owned, and this
note exists to name the debt anyway, because the workflow was worth learning from and
saying so costs nothing.

One more idea was taken later: closing every delegated agent report with a `Key Learnings`
section so what the sub-agent learned survives its context
([gentle-ai#1707](https://github.com/Gentleman-Programming/gentle-ai/pull/1707)). Upstream
feeds it to engram passive capture; here the orchestrator persists it with `mem_save`,
because read-only agents have no memory write access. Same idea, different plumbing, no
upstream text.

The `gentle-ai` binary is no longer used or vendored. Its only live function here — the
skill-registry generator — was reimplemented as
`claude/hooks/ecomono-skill-registry.js`; its SDD dispatchers only ever read an
`openspec/` layout this setup does not use.

## Lineage: superpowers

`agent-skills/ecomono-brainstorm`, `ecomono-plan`, `ecomono-tdd` and `ecomono-debug`
replace four skills from the `superpowers` Claude Code plugin. They were written from
scratch against this repo's rules — no upstream text was reused — so nothing is owed.
Recorded for the same reason as above: the plugin was retired in their favour and the
lineage of the idea is worth naming.

## Attribution owed: cave-compress

`opencode/plugins/cave-compress.ts` and `claude/hooks/ecomono-compress.js` **do** carry
ported code: the pure compression functions from `@juliusbrussee/caveman-code`, MIT
licensed, © Julius Brussee. Those functions were kept substantially as written, so the
attribution stays, in each file's header and here.

### MIT License

```
Copyright (c) Julius Brussee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vendored as-is

`agent-skills/find-skills` is a third-party skill kept as received. It carries no
licence header of its own; it is a discovery front-end for the community skill
ecosystem (`skills.sh`, `anthropics/skills`, `vercel-labs`) rather than original work
here.
