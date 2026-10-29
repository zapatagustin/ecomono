/**
 * ecomono extension for oh-my-pi (omp): the omp counterpart of the Claude hooks and the OpenCode plugins.
 *
 * Today it compresses bash tool results with the same compressor Claude's PostToolUse hook runs and adds the
 * compaction-summary style text. omp loads the DEFAULT export only (the named exports are test seams).
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
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
// SP1 (spikes/results.json): .sp1.route is "static", so cross-tree TypeScript is a static relative import;
// .sp1.cjs is "createRequire", so the CommonJS compressor loads through createRequire below.
import { STYLE } from "../../../opencode/plugins/cave-compress/core.ts"

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

interface Compressor {
  compressBash(text: string, commandHint?: string): string
  logStats(tool: string, before: string, after: string): void
}

export function ecomono(o: { repo: string }) {
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
