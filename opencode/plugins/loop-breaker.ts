/**
 * loop-breaker — reject a tool call the model keeps repeating verbatim.
 *
 * Small local models (measured: Qwen3.6-35B-A3B abliterated via llama-server)
 * do not change strategy when a call fails: one session issued the same
 * `curl` 45 times, each returning "(no output)", at ~6.5 s per round trip.
 * opencode has no built-in guard for this, and a model that ignores an
 * identical result three times will ignore it forty times.
 *
 * Rule: once a given tool + identical arguments has produced the identical
 * output LIMIT times in a row within a session, the next identical call is
 * rejected before it runs. The rejection text goes back to the model as the
 * tool error, which is the only channel `tool.execute.before` has.
 *
 * Polling is not a loop: a status check whose output changes (progress %,
 * new log lines) resets the counter, so only no-op repetition is cut.
 *
 * Only `tool.execute.before` may block, and only by throwing. The output is
 * visible only in `tool.execute.after`, so state is carried from the after
 * hook to the next before hook, keyed by sessionID.
 *
 * opencode calls EVERY export of a plugin file as a plugin and logs
 * "Plugin export is not a function" for anything else, skipping the whole
 * file. Keep exactly one export; the test hardcodes LIMIT for that reason.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"

/** Identical results tolerated before the next identical call is rejected. */
const LIMIT = 3

// ecomono: entries per session are capped by clearing the whole session map
// past this size, not by LRU; a session that legitimately issues more than
// this many distinct calls just loses its history once.
const MAX_ENTRIES_PER_SESSION = 2000

type Entry = { digest: string; repeats: number }

const digest = (s: string) => createHash("sha1").update(s).digest("hex")

// ecomono: JSON.stringify without key sorting. A verbatim repeat serialises
// identically; semantically-equal calls with reordered keys are not the
// failure mode this guards against.
const keyOf = (tool: string, args: unknown) => `${tool}\u0000${JSON.stringify(args ?? null)}`

export const LoopBreaker: Plugin = async () => {
  const sessions = new Map<string, Map<string, Entry>>()

  const bucket = (sessionID: string) => {
    let m = sessions.get(sessionID)
    if (!m) {
      m = new Map()
      sessions.set(sessionID, m)
    }
    if (m.size > MAX_ENTRIES_PER_SESSION) m.clear()
    return m
  }

  return {
    "tool.execute.before": async (input, output) => {
      const entry = bucket(input.sessionID).get(keyOf(input.tool, output.args))
      if (!entry || entry.repeats < LIMIT) return
      throw new Error(
        `loop-breaker: \`${input.tool}\` was called ${entry.repeats} times with identical arguments ` +
          `and returned the identical result every time. Calling it again will not change the outcome. ` +
          `Change approach, or stop and ask the user.`,
      )
    },

    "tool.execute.after": async (input, output) => {
      const m = bucket(input.sessionID)
      const key = keyOf(input.tool, input.args)
      const d = digest(output.output ?? "")
      const prev = m.get(key)
      m.set(key, prev && prev.digest === d ? { digest: d, repeats: prev.repeats + 1 } : { digest: d, repeats: 1 })
    },
  }
}
