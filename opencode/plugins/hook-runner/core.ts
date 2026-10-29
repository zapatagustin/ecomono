/**
 * hook-runner core
 *
 * The one client for the Claude hook protocol outside Claude Code: run a hook script
 * with the `{"tool_input":{...}}` payload on stdin, read the one JSON object it prints,
 * and turn it into a decision. Shared by the OpenCode receipt gate
 * (`opencode/plugins/review-receipt-gate.ts`) and the omp extension, so the protocol
 * parsing, the fail-open convention and the EPIPE guard exist once.
 *
 * Host values are parameters: the script path, the working directory, the timeout, the
 * env to strip, where a fail-open line is reported and the last-resort refusal text.
 * Host semantics are not here — what a decision does (OpenCode throws, omp returns a
 * block) and how a workdir is resolved stay with each host. This module imports
 * nothing but node built-ins, so it loads in every host that can load TypeScript.
 *
 * Moved from `review-receipt-gate.ts` rather than rewritten, so its comments describe
 * the OpenCode plugin's experience where they were measured there.
 */

import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type HookDecision = { decision: "deny" | "ask"; reason: string }

type Opts = {
  /** Log tag and state-log file: `${XDG_STATE_HOME:-~/.local/state}/ecomono/<name>.log`. */
  name: string
  /** Absolute path. ENOENT / EACCES / non-zero exit / timeout / maxBuffer all fail open. */
  script: string
  /** JSON.stringify'd to stdin: exactly what Claude Code sends. */
  payload: unknown
  cwd: string
  timeoutMs: number
  /** Env keys removed from `process.env` before the script runs. */
  stripEnv?: string[]
  /** Where a fail-open line goes besides the state log. Default: `console.error`. */
  report?: (line: string) => void
  /** Last link of the reason chain. Default: `${name} refused this call.` */
  defaultReason?: string
}

// The script prints one small JSON object. Sized well past that so an ordinary run never
// gets near the limit. Exceeding it does NOT truncate-and-continue: Node and Bun both
// kill the child and deliver ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The captured bytes DO
// reach the callback's `stdout` argument — measured: exactly `maxBuffer` of them on
// Node 24 and Bun 1.3.13; Bun 1.4.2 delivers at least that many and often more, up to
// 176 KiB over in the runs measured. The branch below deliberately does not read them:
// a truncated JSON object is not a decision, so this is a fail-open like any other.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/**
 * Say that the gate did not run. Every caller treats "" as allow, and without this line
 * an allow because the gate passed and an allow because the gate broke are the same
 * observation. stderr is kept for `--print-logs`, but under the managed service nothing
 * reads it, so the line is also appended to a state file. A failure to write that file
 * is swallowed, because an allow must stay an allow. Thrown from the hook body it would
 * refuse; thrown from the execFile callback it would skip `settle` and leave the shell
 * call pending forever, since opencode only logs an uncaught exception.
 *
 * stderr is the default `report`; a host with its own log channel passes that instead.
 * `report` is swallowed for the same reason as the file write, and is tried first so a
 * throwing one cannot cost the line that survives.
 */
function failedOpen(o: Opts, why: string) {
  const line = `[${o.name}] failing open: ${why} — this call was NOT checked`
  try {
    ;(o.report ?? console.error)(line)
  } catch {}
  try {
    // `||`, not `??`: an empty XDG_STATE_HOME means unset, as `${XDG_STATE_HOME:-...}` does.
    const dir = join(process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), ".local", "state"), "ecomono")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${o.name}.log`), `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/**
 * Run the gate and return its stdout, or "" for every failure mode. Never rejects:
 * every caller of this treats "no output" as allow, and an exception here would turn a
 * broken environment into a blocked push.
 */
function runGate(o: Opts): Promise<string> {
  const { script, cwd, timeoutMs } = o
  // The process env minus `stripEnv` (OpenCode strips the exported release valve — see
  // review-receipt-gate.ts). Filtered rather than set to `undefined`, which a child env
  // can receive as the literal string "undefined".
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !o.stripEnv?.includes(k)))
  return new Promise((settle) => {
    let child
    // Set when the payload could not be serialized: the child is then killed on purpose,
    // and the callback must not report that kill as a timeout.
    let abandoned = false
    try {
      // ecomono: a timeout kills the direct child, not its process group, so a `git diff` the
      // script spawned outlives it as an orphan. Bounded — one per timed-out call, and it
      // exits when the diff finishes — and closing it means dropping `execFile` for a detached
      // `spawn` with manual group signalling, which is more machinery than this runner is.
      // Upgrade path if slow-repo retries ever pile up: `spawn` with `detached: true` and
      // `process.kill(-pid)`.
      child = execFile(
        script,
        [],
        { cwd, env, timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES },
        (err: any, stdout) => {
          if (!err) return settle(stdout)
          if (abandoned) return
          // Ordered most specific first, which is the only reason `maxBuffer` comes
          // before `killed`. There is no collision to disambiguate: measured on Node 24
          // and Bun 1.3.13 and 1.4.2, an overrun sets `code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
          // with `killed: undefined`, so `killed` is true only for a real timeout. An
          // earlier version of this comment claimed the two collided — one judge
          // asserted it, another measured it, and the measurement won. Named separately
          // because they are different operator problems: a repository too slow for the
          // budget, versus the script breaking its own small-JSON contract.
          if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            failedOpen(o, `the gate printed more than ${MAX_STDOUT_BYTES} bytes and was killed`)
          else if (err.killed) failedOpen(o, `the gate did not finish within ${timeoutMs}ms`)
          // execFile also returns ENOENT when `cwd` itself does not exist, not only when
          // the script is missing — the message covers both rather than asserting one.
          else if (err.code === "ENOENT") failedOpen(o, `no gate script at ${script}, or no such cwd (${cwd})`)
          else failedOpen(o, `the gate exited with ${err.code ?? err.signal ?? "an error"}`)
          settle("")
        },
      )
    } catch (err: any) {
      // execFile itself throwing is a synchronous argument or spawn error. Untested:
      // it is reached only by an invalid `script` or `cwd` argument (an empty string or
      // a NUL byte), for example an OpenCode `workdir` containing a NUL byte, which the
      // caller passes through as `cwd`. Kept rather than deleted because
      // without it the throw would propagate out of the hook and refuse a call the gate
      // never judged — fail-closed, on an environment fault.
      failedOpen(o, `the gate could not be spawned (${err?.message ?? err})`)
      settle("")
      return
    }
    // A script may exit before reading stdin: review-receipt-gate.sh does on its
    // early-allow paths — the release valve and a missing `jq`. (Its empty-command check
    // is NOT one of them: that runs after `cat | jq` has already drained stdin, and the
    // OpenCode plugin filters empty commands before getting here anyway.) Writing into a
    // pipe whose only reader is gone raises EPIPE on the stream, and an unhandled 'error'
    // event on a stream takes down the PROCESS, not the tool call: opencode dies on an
    // ordinary allowed command.
    //
    // Guarded by opencode/plugins/tests/test_review_receipt_gate_epipe.ts — see that file for the
    // current measurement rather than a copy of it here. It is threadbare on purpose: the
    // fault only surfaces while the event loop is still cold, and enough work before the
    // spawn hides it. Measured, so as not to overstate it: a bare extra statement or one
    // more import did not move the rate; a `node:assert` import together with
    // `mkdtempSync`/`rmSync` took it to zero. Read that file's header before touching it.
    // `JSON.stringify` of the payload is therefore after the spawn, not before it.
    child.stdin?.on("error", () => {})
    try {
      child.stdin?.end(JSON.stringify(o.payload))
    } catch (err: any) {
      // A payload JSON cannot serialize (a BigInt, a cycle) throws here, after the
      // spawn. Kill the child so it is not left waiting on a stdin that never closes
      // until the timeout, and settle so the promise cannot reject out of its executor.
      abandoned = true
      child.kill()
      failedOpen(o, `the payload could not be serialized (${err?.message ?? err})`)
      settle("")
    }
  })
}

/** What the script printed, as a decision. `undefined` is allow, fail-open paths included. */
function decide(o: Opts, stdout: string): HookDecision | undefined {
  if (stdout.trim() === "") return // allow: the script prints nothing to permit

  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    failedOpen(o, "the gate printed something that is not JSON")
    return
  }

  const decision = parsed?.hookSpecificOutput?.permissionDecision
  if (decision === undefined) {
    // JSON, but not the contract. Distinct from a recognised allow-shaped decision
    // below, which is the script deliberately permitting.
    failedOpen(o, "the gate printed JSON with no permissionDecision")
    return
  }
  if (decision !== "deny" && decision !== "ask") return

  // A link counts only when it is a string. Converting anything else can throw (an object
  // whose `toString` is not callable), and a throw here, with a deny or ask already in
  // hand, would reach runHook's `.catch` and come back as a fail-open allow. The plugin's
  // old `new Error(reason)` refused in that case too, so this changes only the refusal
  // text (the next link, not "5" or "[object Object]") and keeps the result a string.
  const text = (v: unknown) => (typeof v === "string" ? v : "")
  const reason =
    text(parsed?.hookSpecificOutput?.permissionDecisionReason) ||
    text(parsed?.systemMessage) ||
    o.defaultReason ||
    `${o.name} refused this call.`
  return { decision, reason }
}

/**
 * Run a hook script and translate what it printed. Never rejects. `undefined` is allow,
 * including every fail-open path; a returned decision is the script refusing (`deny`) or
 * asking (`ask`), and what to do with it is the host's call. Not `async`, so the spawn
 * happens in the caller's own tick, as it did when this lived in the plugin.
 */
export function runHook(o: Opts): Promise<HookDecision | undefined> {
  return runGate(o)
    .then((stdout) => decide(o, stdout))
    .catch((err: any) => {
      // Only for the unexpected. `decide` converts nothing once it holds a deny or ask,
      // so this can turn an unanswered gate into a fail-open but never a refusal into an
      // allow.
      failedOpen(o, `the gate output could not be handled (${err?.message ?? err})`)
      return undefined
    })
}
