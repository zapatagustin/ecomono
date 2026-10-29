/**
 * ecomono extension for oh-my-pi (omp): the omp counterpart of the Claude hooks and the OpenCode plugins.
 *
 * Today it gates bash and github delivery through Claude's own hook scripts (secret access, diff size, review
 * receipt) plus the `rm -rf` literals of Claude's deny list, denies the path tools on the read-deny globs of
 * opencode/opencode.json (and withholds a read that resolved to such a file), runs judge-standards-gate on every
 * task item, compresses bash tool results with the same compressor Claude's PostToolUse hook runs and adds the
 * compaction-summary style text. It also maps the agents' haiku/sonnet/opus tiers to omp's @smol/@task/@slow
 * roles, blocks the ecomono-memory tools an agent's own `tools:` line does not list, and refreshes the skill
 * registry from the main session. omp loads the DEFAULT export only (the named exports are test seams).
 *
 * Error contract (non-negotiable): omp fails a `tool_call` CLOSED on a throw, a rejection or after 30 s, while
 * ecomono's gates fail OPEN. Every handler body therefore runs inside safe(): it catches everything, logs with
 * pi.logger.warn and returns undefined. No raw timers (ctx.setInterval only), no floating promises without a
 * .catch, no console.error (it draws over the TUI).
 *
 * Shared code is imported by path from the repo tree: the extension is linked into omp's extensions directory,
 * and REPO is resolved behind that link's realpath, so Claude's hook script and the OpenCode core files are
 * reused in place, never copied.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
// SP1 (spikes/results.json): .sp1.route is "static", so cross-tree TypeScript is a static relative import;
// .sp1.cjs is "createRequire", so the CommonJS compressor loads through createRequire below.
import { STYLE } from "../../../opencode/plugins/cave-compress/core.ts"
import { type HookDecision, runHook } from "../../../opencode/plugins/hook-runner/core.ts"

export const REPO = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..")

// The agents' frontmatter `model:` tier -> the omp role that stands for it. The consumer binds each role to a real
// model with omp's own modelRoles; ecomono ships no model ids (design.md 5.7).
export const TIER_ROLE = { haiku: "@smol", sonnet: "@task", opus: "@slow" } as const

// What omp does with each script claude/settings.template.json registers. omp/tests/test_contract.ts keeps this
// table total: a hook added to the template without a line here fails the suite (the omp analogue of
// check-hook-install-drift.sh). Keys are script basenames under claude/hooks.
export const CLAUDE_HOOKS: Record<string, string> = {
  "secret-access-gate.sh": "tool_call bash, plus the path tools through the opencode.json deny globs",
  "check-diff-size.sh": "tool_call bash and github (pr_create, pr_push)",
  "review-receipt-gate.sh": "tool_call bash and github (pr_create, pr_push)",
  "judge-standards-gate.sh": "tool_call task, one run per item",
  "ecomono-skill-registry.js": "session_start and before_agent_start, main session, pi.exec node",
  "ecomono-compress.js": "tool_result bash, loaded with createRequire",
  "agent-model-gate.sh": "replaced: before_subagent_spawn tiers",
  "workflow-model-gate.sh": "replaced: before_subagent_spawn tiers, eval spawns take the inheritance rule",
  "heavy-skill-gate.sh": "not needed: gated skills ship only inside Claude Code",
  "statusline.sh": "not needed: native status line",
}

// omp names an MCP tool `mcp__<server>_<tool>` with the server's `-` turned into `_`; Claude's agent files name the
// same tool `mcp__ecomono-memory__<tool>`.
const MEMORY_TOOL = "mcp__ecomono_memory_"
const MEMORY_TOOL_CLAUDE = "mcp__ecomono-memory__"

// omp appends model-facing notices after the body: wall time, raw-output artifact, temp-shell notice,
// spill/truncation, timeout, exit code (omp: tools/bash.ts:705,722-739; exec/bash-executor.ts:855-873;
// pi-tui: tools/bash.ts:201-207, tools/output-meta.ts:205-252). Known prefixes only: a body that ends in a
// one-line JSON array must not be mistaken for a notice. An unknown future notice stays in the body,
// where the tail budget keeps it: degrades, never drops.
const OMP_NOTICE = /^(?:\[(?:raw output: artifact:\/\/|Showing |Some lines truncated |\d+ (?:matches|results) limit|Command timed out).*\]|Wall time: [\d.]+ seconds|Command exited with code -?\d+|Ran in a temporary shell while .*)$/

/** Split a bash result into [body, tail]: tail is the trailing run of blank lines and notice lines, verbatim. */
function peel(text: string): [string, string] {
  const lines = text.split("\n")
  let end = lines.length
  while (end > 0 && (lines[end - 1].trim() === "" || OMP_NOTICE.test(lines[end - 1].trimEnd()))) end--
  const body = lines.slice(0, end).join("\n")
  return [body, text.slice(body.length)]
}

// ecomono: mirrors omp's normalizePathLikeInput + expandPath + resolveToCwd
// (tools/path-utils.ts:75-133,332-344,541-543,577-578), which extensions cannot import. Ceiling: a new omp path
// shorthand is not mirrored until test_paths.ts gains its case; the smoke pins the omp version. Every step can
// only widen what the deny check sees.
function ompPath(cwd: string, raw: string): string | undefined {
  let p = raw.trim()
  if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
  if (/^[@:](?=[/~.])/.test(p)) p = p.slice(1)
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p)
    } catch {}
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return undefined // skill://, artifact://, xd://, local://, http(s)://
  if (p.startsWith("~")) p = join(homedir(), p.slice(1)) // ~, ~/x and ~x, as expandTilde
  if (/^\/+$/.test(p)) return cwd
  return resolve(cwd, p)
}

// ---- path deny helpers (design.md 5.4 steps 1-4) -------------------------------------------------------------
// Every helper below only ever ADDS a spelling to test. Over-matching is the safe direction: a spelling omp would
// not read costs at most a false block on a path that already looks like a secret; a spelling omp does read and
// the gate missed is a leak, with no valve to release it.

/** Path tools the deny globs apply to; edit's hashline headers reach `path`/`paths` through omp's event normalizer. */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "find", "ast_grep", "ast_edit"])

/** A string, or the strings of an array; anything else is ignored. */
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []

/**
 * The raw value plus the parts omp may split it into, plus each part with `\` as `/`.
 * - read fans a missing `a;b` list out into separate reads, and splits a `;` list that mixes URLs and paths
 *   before URL detection, so `skill://x;.env` reads `.env` (omp: tools/read.ts:1762-1767,2039-2045). The parts run
 *   through the tool's own execute, so no per-part tool_call fires.
 * - grep reads `path` or `paths`, each a string or an array, and splits a root on /[;,\s]+/
 *   (omp: tools/grep.ts:568-571; tools/search-approval-targets.ts:23). The split here is that superset.
 * - Search roots turn every `\` into `/` (normalizePathSeparators, omp: tools/path-utils.ts:571-575), so grep
 *   `~\.ssh` searches `~/.ssh`; the backslash form is kept as well, since read does not rewrite it.
 * - grep, glob and ast_grep decode a string that trims to a JSON string array (`'[".env"]'`) into its entries
 *   before resolving (omp: tools/grep.ts:677, glob.ts:212, ast-grep.ts:217, via pi-tui render/render-utils.ts
 *   toPathList). Each entry is added next to the raw value, whatever the tool: a decode omp would not do only
 *   costs a false block.
 */
function pathParts(value: string): string[] {
  const parts = new Set<string>()
  const listed = [value]
  const trimmed = value.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const decoded: unknown = JSON.parse(trimmed)
      if (Array.isArray(decoded)) for (const entry of decoded) if (typeof entry === "string") listed.push(entry)
    } catch {} // not JSON: a literal path
  }
  for (const text of listed) {
    parts.add(text)
    for (const part of text.split(/[;,\s]+/)) if (part) parts.add(part)
  }
  for (const part of [...parts]) if (part.includes("\\")) parts.add(part.replaceAll("\\", "/"))
  return [...parts]
}

/**
 * The local path a part reads. ompPath covers `file://` (omp: tools/read.ts:1756-1758), quotes, `@`/`:` prefixes
 * and `~`; internal URLs (skill://, artifact://, xd://, http(s)://) resolve to undefined and are skipped.
 * `ssh://` is not skipped: it reads, searches and writes files on whatever host OpenSSH resolves, `localhost`
 * included, at the decoded URL pathname (omp: internal-urls/ssh-protocol.ts:76-106). That pathname is matched as
 * text, never resolved against cwd and whatever the host, so a remote `.env` or `~/.ssh/*` is denied like a local
 * one. It lives here and not in ompPath, which the bash cwd handling shares.
 */
function resolvePart(cwd: string, part: string): string | undefined {
  let bare = part.trim()
  if (bare.length > 1 && bare.startsWith('"') && bare.endsWith('"')) bare = bare.slice(1, -1)
  if (!/^ssh:\/\//i.test(bare)) return ompPath(cwd, part)
  try {
    const pathname = new URL(bare).pathname
    try {
      return decodeURIComponent(pathname)
    } catch {
      return pathname
    }
  } catch {
    return undefined
  }
}

/**
 * The path as given, with its `?query` cut and with the read selector cut. Read peels `:1-50`, `:raw` and the
 * compound `:1-50:raw` / `:raw:1-50` down to the path (pi-tui: tools/read.ts:147-184, splitPathAndSel), so the cut
 * is at the FIRST `:` of the last segment: a cut at the last `:` would leave `.env:1-5` or `.env:raw`, which no
 * glob matches. A direct read sets no details target for the post-check either, so this is the only place that
 * catches it.
 */
function candidates(path: string): string[] {
  const cutSelector = (s: string) => {
    const i = s.indexOf(":", s.lastIndexOf("/") + 1)
    return i < 0 ? s : s.slice(0, i)
  }
  const q = path.indexOf("?")
  const out = new Set<string>()
  for (const base of q < 0 ? [path] : [path, path.slice(0, q)]) {
    out.add(base)
    out.add(cutSelector(base))
  }
  return [...out]
}

interface Compressor {
  compressBash(text: string, commandHint?: string): string
  logStats(tool: string, before: string, after: string): void
}

// hooksDir and timeoutMs are test seams: the extension has no env knob for either. 20 s keeps the slowest gate
// inside omp's 30 s per-handler budget, past which omp fails the call closed.
export function ecomono(o: { repo: string; hooksDir?: string; timeoutMs?: number }) {
  const hooksDir = o.hooksDir ?? join(o.repo, "claude/hooks")
  const timeoutMs = o.timeoutMs ?? 20_000
  return (pi: ExtensionAPI): void => {
    const safe =
      <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) =>
      async (...args: A): Promise<R | undefined> => {
        try {
          return await fn(...args)
        } catch (e) {
          pi.logger.warn(`ecomono: handler failed: ${e instanceof Error ? e.message : String(e)}`)
          return undefined
        }
      }

    // Fail-open reporting, for the hook runner (which also appends the state log) and for faults found here.
    // Synchronous on purpose: runHook shields a report that throws but not one that returns a rejected promise.
    // Notify once per session, and only where there is a UI to notify.
    let notified = false
    const failOpen = (ctx: any, line: string): void => {
      pi.logger.warn(line)
      if (notified || !ctx?.hasUI) return
      notified = true
      try {
        ctx.ui.notify("ecomono gate failed open: see ~/.local/state/ecomono/", "warning")
      } catch (e) {
        pi.logger.warn(`ecomono: notify failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // The `Bash(<literal>)` entries of Claude's deny list, whitespace-normalised, parsed on first use and
    // cached. Derived from the template rather than copied, so the two hosts cannot drift. A template that
    // cannot be read or parsed warns once and leaves the list empty.
    const normalize = (s: string) => s.trim().replace(/\s+/g, " ")
    let denyLiterals: string[] | undefined
    const literals = (): string[] => {
      if (denyLiterals === undefined) {
        denyLiterals = []
        try {
          const deny = JSON.parse(readFileSync(join(o.repo, "claude/settings.template.json"), "utf8"))?.permissions?.deny
          for (const entry of Array.isArray(deny) ? deny : []) {
            const m = typeof entry === "string" ? /^Bash\((.*)\)$/s.exec(entry) : null
            if (m) denyLiterals.push(normalize(m[1]))
          }
        } catch (e) {
          pi.logger.warn(
            `ecomono: bash deny literals disabled, cannot read claude/settings.template.json from ${o.repo}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
        }
      }
      return denyLiterals
    }

    // The keys of opencode/opencode.json permission.read whose value is "deny", each compiled once and cached.
    // Derived from the file rather than copied, so the three hosts cannot drift. A file that cannot be read or
    // parsed warns once and leaves the list empty: the gate then denies nothing.
    let denyGlobs: { glob: string; matcher: { match(path: string): boolean } }[] | undefined
    const globs = () => {
      if (denyGlobs === undefined) {
        denyGlobs = []
        try {
          const read = JSON.parse(readFileSync(join(o.repo, "opencode/opencode.json"), "utf8"))?.permission?.read
          for (const [glob, value] of Object.entries(typeof read === "object" && read !== null ? read : {})) {
            if (value === "deny") denyGlobs.push({ glob, matcher: new Bun.Glob(glob) })
          }
        } catch (e) {
          denyGlobs = []
          pi.logger.warn(
            `ecomono: path deny disabled, cannot read opencode/opencode.json from ${o.repo}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
        }
      }
      return denyGlobs
    }

    // Path deny, design.md 5.4 steps 2-5 on already-collected values: the first value whose parts, resolved
    // against ctx.cwd, hit a deny glob. A glob without "/" matches the basename of the candidate; the others match
    // the candidate without its leading "/". Each candidate is also tested with "/x" appended, because
    // `**/.ssh/**` does not match the directory itself (F4), only what is below it. Shared by the tool_call path
    // gate and the read post-check, so a target omp resolved gets the same verdict as one the model typed.
    const deny = (ctx: any, values: string[]): { value: string; glob: string } | undefined => {
      const list = globs()
      if (list.length === 0) return undefined
      for (const value of values) {
        for (const part of pathParts(value)) {
          const path = resolvePart(ctx.cwd, part)
          if (path === undefined) continue
          for (const candidate of candidates(path)) {
            for (const probe of [candidate, `${candidate}/x`]) {
              const name = basename(probe)
              const hit = list.find(({ glob, matcher }) =>
                glob.includes("/") ? matcher.match(probe.replace(/^\//, "")) : matcher.match(name),
              )
              if (hit) return { value, glob: hit.glob }
            }
          }
        }
      }
      return undefined
    }

    // The ecomono-memory tools an agent's own claude/agents/<name>.md may call, from its frontmatter `tools:` line:
    // the `mcp__ecomono-memory__<tool>` entries, prefix stripped. Cached per name; null means "no restriction" (no
    // such file, which covers omp's bundled agents, /tan clones and the advisor, or a file with no `tools:` line,
    // which Claude reads as "inherits every tool"). The name is matched before it joins a path, so nothing outside
    // claude/agents is ever read.
    const memoryTools = new Map<string, Set<string> | null>()
    const memoryAllowed = (name: string): Set<string> | null => {
      const cached = memoryTools.get(name)
      if (cached !== undefined) return cached
      let allowed: Set<string> | null = null
      if (/^[a-z0-9-]+$/.test(name)) {
        try {
          const lines = readFileSync(join(o.repo, "claude/agents", `${name}.md`), "utf8").split(/\r?\n/)
          const open = lines.findIndex((l) => l.trim() === "---")
          const close = open < 0 ? -1 : lines.findIndex((l, i) => i > open && l.trim() === "---")
          const tools = close < 0 ? undefined : lines.slice(open + 1, close).find((l) => l.startsWith("tools:"))
          if (tools !== undefined) {
            allowed = new Set(
              tools
                .slice("tools:".length)
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.startsWith(MEMORY_TOOL_CLAUDE))
                .map((t) => t.slice(MEMORY_TOOL_CLAUDE.length)),
            )
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            pi.logger.warn(
              `ecomono: memory guard disabled for ${name}, cannot read claude/agents/${name}.md from ${o.repo}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            )
          }
        }
      }
      memoryTools.set(name, allowed)
      return allowed
    }

    // Skill registry refresh, same generator, flags and timeout as OpenCode's skill-registry.ts. Fire and forget: the
    // generator exits 0 under --quiet and a failure must never hold a prompt, so the promise is never awaited and
    // never rejects. Main session only: a subagent shares the parent's project and would only repeat the work.
    // ecomono: runs are not deduplicated, so a prompt during a slow refresh starts a second one. Add an in-flight
    // guard if overlapping runs ever cause harm.
    const refresh = (ctx: any): void => {
      if (ctx?.agent?.kind !== "main") return
      pi.exec("node", [join(o.repo, "claude/hooks/ecomono-skill-registry.js"), "--quiet", "--cwd", ctx.cwd], {
        cwd: ctx.cwd,
        timeout: 30_000,
      }).catch(() => {})
    }

    const gate = (name: string, payload: unknown, cwd: string, ctx: any) =>
      runHook({
        name,
        script: join(hooksDir, `${name}.sh`),
        payload,
        cwd,
        timeoutMs,
        report: (line) => failOpen(ctx, line),
      })

    // Merges the gates' answers: any deny blocks; otherwise the asks go to the user, or, with nobody to ask,
    // block, except that a headless ask from check-diff-size alone is dropped. It is a nudge, and omp's headless
    // mode includes subagents, which Claude would prompt interactively.
    const decide = async (ctx: any, results: { name: string; r: HookDecision | undefined }[]) => {
      const reasons = (kind: "deny" | "ask") =>
        results.filter(({ r }) => r?.decision === kind).map(({ r }) => r!.reason)
      const denied = reasons("deny")
      if (denied.length > 0) return { block: true, reason: denied.join("\n\n") }
      const asked = reasons("ask")
      if (asked.length === 0) return undefined
      const reason = asked.join("\n\n")
      if (ctx.hasUI) return (await ctx.ui.confirm("ecomono", reason)) ? undefined : { block: true, reason }
      if (results.every(({ name, r }) => r?.decision !== "ask" || name === "check-diff-size")) return undefined
      return { block: true, reason }
    }

    const runGates = async (names: string[], command: string, cwd: string, ctx: any) =>
      decide(
        ctx,
        await Promise.all(
          names.map(async (name) => ({ name, r: await gate(name, { tool_input: { command } }, cwd, ctx) })),
        ),
      )

    pi.on(
      "tool_call",
      safe(async (event: any, ctx: any) => {
        const input = event?.input
        if (typeof input !== "object" || input === null) return undefined

        if (event.toolName === "bash") {
          if (typeof input.command !== "string") return undefined
          const command: string = input.command
          const denied = literals()
          if (denied.length > 0) {
            for (const segment of command.split(/\|\||&&|[;|&\n]/).map(normalize)) {
              if (denied.includes(segment)) {
                return {
                  block: true,
                  reason: `Blocked: "${segment}" is on the deny list in claude/settings.template.json, which this omp extension enforces for bash.`,
                }
              }
            }
          }
          const raw = typeof input.cwd === "string" ? input.cwd : ""
          const cwd = raw ? ompPath(ctx.cwd, raw) : ctx.cwd
          if (cwd === undefined) {
            failOpen(ctx, `[bash gates] failing open: the bash cwd ${raw} is not a directory path — this call was NOT checked`)
            return undefined
          }
          return runGates(["secret-access-gate", "check-diff-size", "review-receipt-gate"], command, cwd, ctx)
        }

        if (event.toolName === "github" && (input.op === "pr_create" || input.op === "pr_push")) {
          const command = input.op === "pr_create" ? "gh pr create" : "git push"
          return runGates(["check-diff-size", "review-receipt-gate"], command, ctx.cwd, ctx)
        }

        // Hard deny, no valve (neither host's read deny has one): the globs are opencode.json's own, the ones
        // OpenCode enforces natively on its read tool.
        // ecomono: the gate checks the roots a call names, never the walk beneath them. grep, glob, find and
        // ast_grep over a parent directory, or over a root with glob characters, can still surface a denied file
        // (design.md 5.4 ceiling list, F14e). Upgrade path: omp's tools.restrictedFolders, or filtering the result
        // in tool_result, once a leak is observed.
        if (PATH_TOOLS.has(event.toolName)) {
          const values = [...strings(input.path), ...strings(input.paths)]
          const hit = deny(ctx, values)
          if (!hit) return undefined
          return {
            block: true,
            reason: `Blocked: ${event.toolName} "${hit.value}" is denied by "${hit.glob}" in opencode/opencode.json (permission.read), which this omp extension enforces for path tools.`,
          }
        }

        // Every item with an agent goes through the judge gate; the script alone knows which agents are judges,
        // so there is no list of judge names here. The prompt is rebuilt from the two fields omp hands the child as
        // text: the batch `context` (its subagent system prompt, omp: task/executor.ts:3971,4781) and the item's
        // `task` (the initial prompt, executor.ts:2532). `solutionSpace` is left out on purpose: omp feeds it only
        // to the auto-thinking classifier (session/agent-session-types.ts:457), so a heading that sits only there
        // never reaches the judge. omp drops `context` when task.batch is off, but then it rejects a call that
        // carries one (task/index.ts:229-241), so no judge launches without it.
        // ecomono: an eval `agent()` spawn of a judge skips this gate. before_subagent_spawn carries no prompt
        // (omp: extensibility/extensions/types.ts:1101-1113, F19), so there is nothing to hand the script. Upgrade
        // path: when such a spawn is observed, run the script with an empty prompt from before_subagent_spawn.
        if (event.toolName === "task") {
          const items: unknown[] = Array.isArray(input.tasks) ? input.tasks : [input]
          const name = "judge-standards-gate"
          const results = await Promise.all(
            items.flatMap((item: any) => {
              if (typeof item?.agent !== "string") return []
              const prompt = [input.context, item.task].filter((s) => typeof s === "string" && s).join("\n")
              // omp trims the agent name before the lookup (task/index.ts spawnParamsFor), and the script matches
              // it exactly, so a padded judge name would otherwise slip past.
              const payload = { tool_input: { subagent_type: item.agent.trim(), prompt } }
              return [gate(name, payload, ctx.cwd, ctx).then((r) => ({ name, r }))]
            }),
          )
          return decide(ctx, results)
        }

        // Memory write guard: Claude restricts a subagent to the memory tools its own `tools:` line lists, and omp
        // mounts every MCP tool on every agent, so the same line is enforced here. The tool arrives under its own
        // name even when the model reaches it through `write xd://mcp__ecomono_memory_<tool>`: omp fires a second
        // tool_call for the inner call (spikes/results.json .sp2.innerToolCall is true), so this one branch
        // covers both routes.
        if (typeof event.toolName === "string" && event.toolName.startsWith(MEMORY_TOOL)) {
          const agent = ctx?.agent
          if (agent?.kind !== "sub" || typeof agent.name !== "string") return undefined
          const allowed = memoryAllowed(agent.name)
          if (allowed === null || allowed.has(event.toolName.slice(MEMORY_TOOL.length))) return undefined
          return {
            block: true,
            reason: `${agent.name} has no memory write access (claude/agents/${agent.name}.md tools:); report it to the parent instead`,
          }
        }
        return undefined
      }),
    )

    // Loaded on first use and cached, also when loading fails: one warning per session, then pass-through.
    // Claude's hook is CommonJS and guards its CLI behind require.main, so loading it runs nothing.
    let compressor: Compressor | null | undefined
    const loadCompressor = (): Compressor | undefined => {
      if (compressor === undefined) {
        try {
          const m = createRequire(import.meta.url)(join(o.repo, "claude/hooks/ecomono-compress.js"))
          if (typeof m?.compressBash !== "function" || typeof m?.logStats !== "function") {
            throw new Error("it does not export compressBash and logStats")
          }
          compressor = m
        } catch (e) {
          compressor = null
          pi.logger.warn(
            `ecomono: bash compression disabled, cannot load claude/hooks/ecomono-compress.js from ${o.repo}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
        }
      }
      return compressor ?? undefined
    }

    // shellMinimizer: coexist, not disabled. omp's minimizer runs inside the bash executor, before tool_result,
    // and only for commands it has a filter for; it keeps the raw bytes as an artifact. compressBash then sees
    // already-minimized text, usually short enough to pass through unchanged (no stats line). ecomono ships no
    // config.yml, so it does not turn an omp default off. Consequences: stats.jsonl under-counts savings on
    // minimized commands, and the "[raw output: artifact://N]" notice is peeled and re-appended like any other.
    pi.on(
      "tool_result",
      safe(async (event: any, ctx: any) => {
        // Read post-check (design.md 5.4, F15): omp resolves some reads to a file the model never named, and
        // reports where in `details`. A suffix match (`read prod` -> `secrets/prod`, omp: tools/read.ts:2046-2059,
        // details.suffixResolution.to) and the parts of a delimited list (details.displayReadTargets) never fire
        // their own tool_call, so the path gate cannot see them. The targets go through the same deny check and a
        // match withholds the content. A result is never rewritten otherwise: hashline anchors feed `edit`.
        // ecomono: two ceilings. (1) `details` stays as omp produced it, so the TUI still renders the file to the
        // user; upgrade path: replace `details` too once omp documents which fields the session persists.
        // (2) An oversized read result is saved to artifact://N before tool_result fires (omp: tools/output-meta.ts
        // spill; design.md F24), and `read artifact://N` is an internal URL the path gate skips, so it can still
        // return the file; N is no longer shown to the model. Upgrade path: when such a read is observed, record N
        // from the replaced content's artifact link and deny `read artifact://N`.
        if (event?.toolName === "read") {
          const d = event.details
          const listed = Array.isArray(d?.displayReadTargets) ? d.displayReadTargets : []
          const targets = [d?.suffixResolution?.to, ...listed].filter((t): t is string => typeof t === "string")
          const hit = deny(ctx, targets)
          if (!hit) return undefined
          return {
            content: [
              {
                type: "text",
                text: `ecomono: read resolved to ${hit.value}, which ${hit.glob} in opencode/opencode.json denies; content withheld.`,
              },
            ],
            isError: true,
          }
        }
        if (event?.toolName !== "bash") return undefined
        // Eval-bridged results go back to a script, which must see them whole.
        if (/^(?:js|prelude)-/.test(String(event.toolCallId))) return undefined
        // Read per call, so a test or a user can flip it mid-session.
        if (process.env.ECOMONO_COMPRESS === "off") return undefined
        if (!Array.isArray(event.content) || typeof event.input !== "object" || event.input === null) return undefined

        const texts: string[] = []
        const rest: unknown[] = []
        for (const part of event.content) {
          if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
          else rest.push(part)
        }
        if (texts.length === 0) return undefined

        const c = loadCompressor()
        if (!c) return undefined

        const [body, tail] = peel(texts.join("\n"))
        const command = typeof event.input.command === "string" ? event.input.command : undefined
        // isError results are compressed too: a failing build's log is exactly the output worth trimming.
        const out = c.compressBash(body, command)
        if (out === body) return undefined
        c.logStats("omp.bash", body, out)
        // Image (and any other non-text) parts go after the text, in their original order.
        return { content: [{ type: "text", text: out + tail }, ...rest] }
      }),
    )

    // LLM summaries only: omp's snapcompact and shake modes ignore it.
    pi.on(
      "session.compacting",
      safe(() => (process.env.ECOMONO_COMPRESS === "off" ? undefined : { context: [STYLE] })),
    )

    // Tier routing. A bare tier word (the agents' frontmatter `model:`) becomes its role: a bare `sonnet` would
    // otherwise fuzzy-match whatever authenticated model comes first, so `[tier, @role]` cannot steer it. Silent
    // inheritance (no role, and the one pattern is exactly the main model) goes to @task instead of the main
    // model. Same rule for a task spawn and an eval agent(). Anything else is left alone: a role, and an explicit
    // model or task.agentModelOverrides entry that names a model other than the main one.
    // spikes/results.json .sp3.fallback is unset: the handler's `model` replacement was observed to take effect.
    // ecomono: ceiling. An override or explicit selector that is exactly the main model's `provider/id` reaches this
    // event as [mainModel] with modelRole undefined, identical to silent inheritance (the event carries no selection
    // source and extensions get no settings access), so it is rerouted to @task. Workaround: bind the override
    // through a role alias such as `@slow`, which sets modelRole. Upgrade path: use the selection source if omp adds
    // it to BeforeSubagentSpawnEvent.
    pi.on(
      "before_subagent_spawn",
      safe((event: any, ctx: any) => {
        const patterns = event?.patterns
        if (!Array.isArray(patterns) || patterns.length !== 1 || typeof patterns[0] !== "string") return undefined
        const pattern: string = patterns[0]
        const tier = pattern.toLowerCase()
        if (Object.hasOwn(TIER_ROLE, tier)) {
          const role = TIER_ROLE[tier as keyof typeof TIER_ROLE]
          return { model: role, note: `ecomono: ${tier} tier -> ${role}` }
        }
        if (!event.modelRole && ctx?.model && pattern === `${ctx.model.provider}/${ctx.model.id}`) {
          return { model: "@task", note: "ecomono: no model tier; routed to @task instead of the main model" }
        }
        return undefined
      }),
    )

    // Once per session, main agent only: a subagent's factory has its own closure and would repeat it.
    let skillsWarned = false
    pi.on(
      "session_start",
      safe((_event: any, ctx: any) => {
        if (ctx?.agent?.kind !== "main") return undefined
        refresh(ctx)
        if (skillsWarned) return undefined
        // The remaining prose dependency: the ecomono-sdd-* commands and agents read ~/.claude/skills by path, and
        // omp reads skills only from ~/.agents/skills, so a missing tree is a silent half-working install.
        const shared = join(process.env.HOME || homedir(), ".claude/skills/ecomono-sdd-shared")
        if (existsSync(shared)) return undefined
        skillsWarned = true
        const text = `ecomono: ${shared} is missing; the ecomono-sdd-* commands and agents read ~/.claude/skills, so run install.sh (or switch the home-manager config) to link it`
        if (ctx.hasUI) {
          try {
            ctx.ui.notify(text, "warning")
          } catch (e) {
            pi.logger.warn(`ecomono: notify failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        } else pi.logger.warn(text)
        return undefined
      }),
    )

    // Every prompt, so a skill added mid-session is in the registry by the next one. A revive replays no prompt.
    pi.on(
      "before_agent_start",
      safe((event: any, ctx: any) => {
        if (event?.reason === "prompt") refresh(ctx)
        return undefined
      }),
    )
  }
}

export default ecomono({ repo: REPO })
