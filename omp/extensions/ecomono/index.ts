/**
 * ecomono extension for oh-my-pi (omp): the omp counterpart of the Claude hooks and the OpenCode plugins.
 *
 * Today it gates bash and github delivery through Claude's own hook scripts (secret access, diff size, review
 * receipt) plus the `rm -rf` literals of Claude's deny list, compresses bash tool results with the same
 * compressor Claude's PostToolUse hook runs and adds the compaction-summary style text. omp loads the DEFAULT
 * export only (the named exports are test seams).
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
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
// SP1 (spikes/results.json): .sp1.route is "static", so cross-tree TypeScript is a static relative import;
// .sp1.cjs is "createRequire", so the CommonJS compressor loads through createRequire below.
import { STYLE } from "../../../opencode/plugins/cave-compress/core.ts"
import { type HookDecision, runHook } from "../../../opencode/plugins/hook-runner/core.ts"

export const REPO = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..")

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
      safe(async (event: any) => {
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
  }
}

export default ecomono({ repo: REPO })
