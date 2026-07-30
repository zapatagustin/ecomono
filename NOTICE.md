# Notice

This repository contains work derived from third-party open-source projects. The
sections below record what was taken, from whom, under which licence, and that it
was modified. Every derived file also carries the same attribution in its own
frontmatter, so the provenance survives being copied out of the repo.

## gentle-ai — Gentleman Programming

Upstream: <https://github.com/Gentleman-Programming/gentle-ai>

The Spec-Driven Development skill family and three standalone skills originate
there. They have been forked into `agent-skills/` under the `ecomono-` prefix and
**modified**: renamed, rewritten against this repo's context-discipline rules, and
re-pointed at the `ecomono-memory` persistence backend rather than the upstream
default. They are no longer upstream files and should not be read as representing
upstream's current behaviour.

Forked under MIT:

| Derived work | Upstream skill |
|---|---|
| `agent-skills/ecomono-sdd-explore` | `sdd-explore` |
| `agent-skills/ecomono-sdd-propose` | `sdd-propose` |
| `agent-skills/ecomono-sdd-spec` | `sdd-spec` |
| `agent-skills/ecomono-sdd-design` | `sdd-design` |
| `agent-skills/ecomono-sdd-tasks` | `sdd-tasks` |
| `agent-skills/ecomono-sdd-apply` | `sdd-apply` |
| `agent-skills/ecomono-sdd-verify` | `sdd-verify` |
| `agent-skills/ecomono-sdd-archive` | `sdd-archive` |
| `agent-skills/ecomono-sdd-init` | `sdd-init` |
| `agent-skills/ecomono-sdd-onboard` | `sdd-onboard` |
| `agent-skills/ecomono-sdd-shared` | `_shared` |

Forked under Apache-2.0:

| Derived work | Upstream skill |
|---|---|
| `agent-skills/ecomono-judgment` | `judgment-day` |
| `agent-skills/ecomono-pr` | `branch-pr` |
| `agent-skills/ecomono-docs` | `cognitive-doc-design` |

The `gentle-ai` binary itself is not vendored — it is fetched from upstream
releases at install time (`nix/gentle-ai.nix`, `install.sh`) and remains upstream's
work under its own licence.

### MIT License

```
Copyright (c) 2025 Gentleman Programming

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

### Apache License 2.0

The three skills above declare `Apache-2.0` in their own frontmatter, so they are
carried under those terms. Full text: <https://www.apache.org/licenses/LICENSE-2.0>

As required by section 4(b), note that these files have been changed from their
original form. Copyright (c) 2025 Gentleman Programming.

## Ported process skills

`agent-skills/ecomono-brainstorm`, `ecomono-plan`, `ecomono-tdd` and
`ecomono-debug` replace four skills from the `superpowers` Claude Code plugin. They
were **written from scratch** against this repo's rules rather than copied — no
upstream text was reused — so no attribution is owed. Recorded here only because
the plugin was retired in their favour and the lineage of the idea is worth naming.

## cave-compress

`opencode/plugins/cave-compress.ts` and `claude/hooks/ecomono-compress.js` port the
pure compression functions from `@juliusbrussee/ecomono-code`, MIT licensed,
© Julius Brussee. The per-file attribution is in each header.
