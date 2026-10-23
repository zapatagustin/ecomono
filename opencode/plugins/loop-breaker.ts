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
 * tool error, which is the only channel `execute.before` has.
 *
 * "In a row" is literal: only the LAST call of each session is remembered. Any
 * other call in between (a different tool, different arguments) forgets it, so
 * an idempotent probe interleaved with real work (`git status` between an edit
 * and a commit, a `sleep` between log checks) is never counted. A call that
 * returns different output also resets the counter, so polling a status whose
 * output changes (progress %, new log lines) is not a loop either; only
 * back-to-back no-op repetition is cut. A call that fails (`status: "error"`)
 * neither counts nor resets: the before hook already dropped the slot if the
 * call differed.
 *
 * A rejection is lifted in two ways. (1) The next call that differs from the
 * rejected one, even if that call then fails: the block is dropped in the
 * before hook, not on a successful result. (2) A new user message in the
 * session (the `session` `prompt` hook): the model was told to stop and ask the
 * user, the user fixed the environment and said "retry", so the identical call
 * is no longer a blind repeat. The hook fires at admission, so a message sent
 * with `delivery: "queue"` lifts the block before the model reads it; minor.
 * Either way the count starts again from 1. Retrying the rejected call
 * immediately, with neither, is still rejected, and the rejection text says
 * what lifts it.
 *
 * Only `tool` `execute.before` may block, and only by throwing; a throw from
 * any other hook is a host defect that fails the call, so `execute.after` is
 * wrapped. The output is visible only in `execute.after`, so state is carried
 * from the after hook to the next before hook, keyed by sessionID.
 *
 * Code Mode: MCP and other `codemode !== false` tools run inside one `execute`
 * call, and each inner call fires before/after with the outer call's sessionID
 * and id. Inner calls are skipped; the outer `execute` is guarded like any
 * other tool (key = its script, digest = its result). A polling loop INSIDE a
 * script is therefore not detected.
 *
 * v2 loads only the default export `{ id, setup }`, and runs `setup` once per
 * opened directory; state lives in its closure. LIMIT is exported for the test.
 */
import { createHash } from "node:crypto"

/** Identical results tolerated before the next identical call is rejected. */
export const LIMIT = 3

type Last = { key: string; digest: string; repeats: number }

const digest = (s: string) => createHash("sha1").update(s).digest("hex")

// ecomono: JSON.stringify without key sorting. A verbatim repeat serialises
// identically; semantically-equal calls with reordered keys are not the
// failure mode this guards against.
// ecomono: before keys on the advertised tool name and the input as this hook
// sees it, after on the resolved name and the final input. They differ if a
// `session` `context` hook renames a tool, or a later `execute.before` hook
// rewrites `event.tool`/`event.input` (OC/core/src/tool.ts:271-280); nothing
// does either today. If one does, key on the values seen in after, or map them
// back before keying.
const keyOf = (tool: string, args: unknown) => digest(`${tool}\u0000${JSON.stringify(args ?? null)}`)

// shell embeds a per-call saved-output path in its truncation notice (OC/core/src/shell.ts:244-248);
// without stripping it, identical large outputs never hash the same.
const TRUNC = /\n\n\[showing lines \d+-\d+ of \d+; full output saved to [^\]\n]*\]/g
const contentDigest = (c: any) => digest(JSON.stringify(Array.isArray(c)
  ? c.map((p: any) => p?.type === "text" ? { ...p, text: String(p.text).replace(TRUNC, "") } : p) : c ?? null))

export default {
  id: "loop-breaker",
  async setup(ctx: any) {
    // One slot per session: the last call only. Hashing the key keeps a large
    // argument (a whole file passed to `write`) out of memory.
    const last = new Map<string, Last>()
    const inner = new Set<string>()                    // ecomono: in-flight Code Mode `execute` ids, FIFO cap 500
    const k = (e: any) => `${e.sessionID}\0${e.id}`

    await ctx.tool.hook("execute.before", (e: any) => {
      if (e.tool !== "execute" && inner.has(k(e))) return       // inner call of a Code Mode script (G7)
      const prev = last.get(e.sessionID)
      if (prev && prev.key !== keyOf(e.tool, e.input)) last.delete(e.sessionID)
      else if (prev && prev.repeats >= LIMIT)
        throw new Error(
          `loop-breaker: \`${e.tool}\` was called ${prev.repeats} times with identical arguments ` +
            `and returned the identical result every time. Repeating it is rejected until you make a ` +
            `different call or the user sends a new message. Change approach, or stop and ask the user.`,
        )
      // After the throw: a rejected call never reaches execute.after, so it would never leave the set.
      if (e.tool === "execute") { inner.add(k(e)); if (inner.size > 500) inner.delete(inner.values().next().value!) }
    })

    await ctx.tool.hook("execute.after", (e: any) => {
      try {
        if (e.tool === "execute") inner.delete(k(e)); else if (inner.has(k(e))) return
        if (e.status !== "completed") return               // v1 after never saw failures
        const key = keyOf(e.tool, e.input)
        const d = contentDigest(e.result?.content)
        const prev = last.get(e.sessionID)
        last.set(
          e.sessionID,
          prev && prev.key === key && prev.digest === d ? { ...prev, repeats: prev.repeats + 1 } : { key, digest: d, repeats: 1 },
        )
      } catch {}
    })

    // A new user message is new information (the user may have fixed whatever
    // made the call fail), so the identical call gets a fresh count.
    await ctx.session.hook("prompt", (e: any) => { last.delete(e?.sessionID) })
  },
}
