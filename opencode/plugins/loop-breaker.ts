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
 * output LIMIT times IN A ROW within a session, the next identical call is
 * rejected before it runs. The rejection text goes back to the model as the
 * tool error, which is the only channel `tool.execute.before` has.
 *
 * "In a row" is literal: only the LAST call of each session is remembered. Any
 * other call in between (a different tool, different arguments) forgets it, so
 * an idempotent probe interleaved with real work (`git status` between an edit
 * and a commit, a `sleep` between log checks) is never counted. A call that
 * returns different output also resets the counter, so polling a status whose
 * output changes (progress %, new log lines) is not a loop either; only
 * back-to-back no-op repetition is cut.
 *
 * A rejection is lifted in two ways. (1) The next call that differs from the
 * rejected one, even if that call then fails and never reaches
 * `tool.execute.after`: the block is dropped in the before hook, not on a
 * successful result. (2) A new user message in the session (`chat.message`):
 * the model was told to stop and ask the user, the user fixed the environment
 * and said "retry", so the identical call is no longer a blind repeat. Either
 * way the count starts again from 1. Retrying the rejected call immediately,
 * with neither, is still rejected, and the rejection text says what lifts it.
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

type Last = { key: string; digest: string; repeats: number }

const digest = (s: string) => createHash("sha1").update(s).digest("hex")

// ecomono: JSON.stringify without key sorting. A verbatim repeat serialises
// identically; semantically-equal calls with reordered keys are not the
// failure mode this guards against.
const keyOf = (tool: string, args: unknown) => digest(`${tool}\u0000${JSON.stringify(args ?? null)}`)

export const LoopBreaker: Plugin = async () => {
  // One slot per session: the last call only. Hashing the key keeps a large
  // argument (a whole file passed to `write`) out of memory.
  const last = new Map<string, Last>()

  return {
    "tool.execute.before": async (input, output) => {
      const prev = last.get(input.sessionID)
      if (!prev) return
      if (prev.key !== keyOf(input.tool, output.args)) {
        last.delete(input.sessionID)
        return
      }
      if (prev.repeats < LIMIT) return
      throw new Error(
        `loop-breaker: \`${input.tool}\` was called ${prev.repeats} times with identical arguments ` +
          `and returned the identical result every time. Repeating it is rejected until you make a ` +
          `different call or the user sends a new message. Change approach, or stop and ask the user.`,
      )
    },

    // A new user message is new information (the user may have fixed whatever
    // made the call fail), so the identical call gets a fresh count.
    "chat.message": async (input) => {
      last.delete(input.sessionID)
    },

    "tool.execute.after": async (input, output) => {
      const key = keyOf(input.tool, input.args)
      const d = digest(output.output ?? "")
      const prev = last.get(input.sessionID)
      last.set(
        input.sessionID,
        prev && prev.key === key && prev.digest === d ? { ...prev, repeats: prev.repeats + 1 } : { key, digest: d, repeats: 1 },
      )
    },
  }
}
