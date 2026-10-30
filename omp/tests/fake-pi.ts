// fake-pi: a stand-in for omp's extension runner, so the extension is tested with no real omp and no LLM.
//
// Every test file imports this module FIRST. Module evaluation follows import order, so the isolation block
// below runs before any extension or storage code loads.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolation. opencode/plugins/storage/db.ts reads ECOMONO_DATA_DIR and ECOMONO_LEGACY_DB at
// import and would otherwise ATTACH and back up the real ~/.engram/engram.db; logStats and the hook runner read
// XDG_CACHE_HOME and XDG_STATE_HOME on every call and would otherwise write under the real home. The legacy DB
// path is deliberately never created. Bun's os.homedir() ignores a runtime HOME change, so expectations built from
// it need no swap; a test changes process.env.HOME only for code that reads it per call (the skills check of
// session_start).
export const ISOLATED = mkdtempSync(join(tmpdir(), "ecomono-omp-test-"))
process.env.XDG_CACHE_HOME = join(ISOLATED, "cache")
process.env.XDG_STATE_HOME = join(ISOLATED, "state")
process.env.ECOMONO_DATA_DIR = join(ISOLATED, "data")
process.env.ECOMONO_LEGACY_DB = join(ISOLATED, "no-such-engram.db")
// Ambient toggles of the shell running the suite: the compressor and its stats line read them per call, and a value
// of "off" would fail the compression cases for a reason that has nothing to do with the code under test.
delete process.env.ECOMONO_COMPRESS
delete process.env.ECOMONO_COMPRESS_STATS

// The temp tree is removed on a clean exit. A failing run keeps it, and so does ECOMONO_KEEP_TMP=1, so the evidence
// (DBs, state logs, stub hooks) stays on disk.
process.on("exit", (code) => {
  if (code !== 0 || process.env.ECOMONO_KEEP_TMP) return
  try {
    rmSync(ISOLATED, { recursive: true, force: true })
  } catch {}
})

// Helpers every test file needs and that import nothing from the extension, so they live here and not in each file.
// One scratch tree and one counter serve the whole run.
const SCRATCH = mkdtempSync(join(ISOLATED, "dirs-"))
let dirSeq = 0
/** A new empty directory under ISOLATED, named after `label`. */
export const dir = (label: string): string => {
  const d = join(SCRATCH, `${label}-${++dirSeq}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** A short pause for fire-and-forget work (a never-awaited exec) to settle. */
export const tick = () => new Promise((r) => setTimeout(r, 20))

/** Runs fn with env keys set (undefined deletes), then restores them. */
export const withEnv = async <T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]))
  const apply = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
  apply(patch)
  try {
    return await fn()
  } finally {
    apply(saved)
  }
}

// The only events the extension may subscribe to. omp ignores unknown names silently, which would turn a typo
// into a gate that never runs; the fake throws instead.
const EVENTS = [
  "tool_call",
  "tool_result",
  "session_start",
  "before_agent_start",
  "session.compacting",
  "before_subagent_spawn",
  "session_shutdown",
] as const

type Handler = (event: any, ctx: any) => any
type Level = "warn" | "info" | "error" | "debug"

export interface Calls {
  /** Every pi.on registration, in order. */
  on: Array<[string, Handler]>
  /** Every pi.exec call as [command, args, options]. */
  exec: Array<[string, string[], any]>
  /** pi.logger lines per level (the optional context argument is appended as JSON). */
  warn: string[]
  info: string[]
  error: string[]
  debug: string[]
  /** Handler failures omp reports through emitError instead of failing the event: event name and message. */
  failures: Array<{ event: string; error: string }>
}

export interface PiOpts {
  /** pi.exec implementation; default resolves a successful empty result. */
  exec?: (command: string, args: string[], options?: any) => Promise<any> | any
}

const line = (msg: unknown, context?: unknown) => {
  if (context === undefined) return String(msg)
  try {
    return `${msg} ${JSON.stringify(context)}`
  } catch {
    return `${msg} [unserializable context]`
  }
}

// The omp version the extension is tested on, read from its line in index.ts as omp/tests/smoke.sh reads it. Parsed,
// not imported: a static import of the extension would evaluate it before the isolation block above.
const tested = /^const OMP_TESTED = "([^"]+)"/m.exec(readFileSync(new URL("../extensions/ecomono/index.ts", import.meta.url), "utf8"))
if (!tested) throw new Error("fake-pi: no OMP_TESTED line in omp/extensions/ecomono/index.ts")
export const OMP_TESTED = tested[1]

export function makePi(opts: PiOpts = {}) {
  const handlers = new Map<string, Handler[]>()
  const calls: Calls = { on: [], exec: [], warn: [], info: [], error: [], debug: [], failures: [] }

  const logger = Object.fromEntries(
    (["warn", "info", "error", "debug"] as Level[]).map((level) => [
      level,
      (msg: unknown, context?: unknown) => void calls[level].push(line(msg, context)),
    ]),
  ) as Record<Level, (msg: unknown, context?: unknown) => void>

  const pi: any = {
    on(name: string, handler: Handler) {
      if (!(EVENTS as readonly string[]).includes(name)) throw new Error(`fake-pi: unknown event "${name}"`)
      calls.on.push([name, handler])
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
    },
    exec(command: string, args: string[], options?: any) {
      calls.exec.push([command, args, options])
      const out = opts.exec ? opts.exec(command, args, options) : { stdout: "", stderr: "", code: 0, killed: false }
      return Promise.resolve(out)
    },
    logger,
    // omp's injected SDK exports, of which the extension reads VERSION. A test replaces it to stand in for another omp.
    pi: { VERSION: OMP_TESTED },
  }

  // Runs one handler the way omp does: a throw or rejection never escapes; the caller decides what it means.
  const run = async (name: string, handler: Handler, event: any, ctx: any): Promise<{ ok: true; value: any } | { ok: false; error: string }> => {
    try {
      return { ok: true, value: await handler(event, ctx) }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      calls.failures.push({ event: name, error })
      return { ok: false, error }
    }
  }

  /**
   * Dispatch an event with the semantics spike 4 recorded for omp 18.13.3 (docs/DESIGN.md, omp target > Spike
   * results, row 4):
   *  - tool_call: handlers run sequentially; the first {block: true} wins (firstBlockWins); a throw or
   *    rejection becomes a block (throwBlocks). Spike 4 recorded the reason "Extension <path> failed: <message>", so
   *    that is modelled, with the fake's name in place of the path. Other results: the last one wins.
   *  - tool_result: handlers chain, each seeing the previous content, details and isError; a throw is recorded
   *    in calls.failures and skipped. Returns {content, details, isError} when any handler changed something.
   *  - before_subagent_spawn: a block short-circuits; otherwise the last {model, note} wins.
   *  - any other event: every handler runs; the last non-undefined result is returned (a throw is recorded
   *    and skipped).
   * Not modelled: omp's 30 s per-handler budget; tests shorten the extension's own timeouts instead.
   */
  const fire = async (name: string, event: any, ctx: any): Promise<any> => {
    const list = handlers.get(name) ?? []
    const current = { type: name, ...event }

    if (name === "tool_call") {
      let result: any
      for (const handler of list) {
        const r = await run(name, handler, current, ctx)
        if (!r.ok) return { block: true, reason: `Extension fake-pi failed: ${r.error}` }
        if (!r.value) continue
        if (r.value.block) return r.value
        result = r.value
      }
      return result
    }

    if (name === "tool_result") {
      let modified = false
      for (const handler of list) {
        const r = await run(name, handler, current, ctx)
        if (!r.ok || !r.value) continue
        for (const key of ["content", "details", "isError"] as const) {
          if (r.value[key] !== undefined) {
            current[key] = r.value[key]
            modified = true
          }
        }
      }
      return modified ? { content: current.content, details: current.details, isError: current.isError } : undefined
    }

    if (name === "before_subagent_spawn") {
      let chosen: any
      for (const handler of list) {
        const r = await run(name, handler, current, ctx)
        if (!r.ok || !r.value) continue
        if (r.value.block) return r.value
        if (r.value.model !== undefined) chosen = { model: r.value.model, note: r.value.note }
      }
      return chosen
    }

    let last: any
    for (const handler of list) {
      const r = await run(name, handler, current, ctx)
      if (r.ok && r.value !== undefined) last = r.value
    }
    return last
  }

  return { pi, fire, calls }
}

/**
 * A fake ExtensionContext. `over` is shallow-merged on top. What the ui and timer stubs were called with is in
 * ctx.recorded; none of them ever fires on its own. ctx.recorded.confirmResult is what ui.confirm resolves to:
 * false by default, which is what a headless omp does (spike 4).
 */
export function makeCtx(over: Record<string, any> = {}) {
  const recorded = {
    confirm: [] as any[][],
    notify: [] as any[][],
    setWidget: [] as any[][],
    setInterval: [] as any[][],
    confirmResult: false as boolean,
  }
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    model: { provider: "fakellm", id: "fake-1" },
    agent: { kind: "main", id: "Main", name: "main" },
    ui: {
      confirm: (...args: any[]) => (recorded.confirm.push(args), Promise.resolve(recorded.confirmResult)),
      notify: (...args: any[]) => void recorded.notify.push(args),
      setWidget: (...args: any[]) => void recorded.setWidget.push(args),
    },
    sessionManager: { getSessionId: () => "sess-1" },
    setInterval: (...args: any[]) => (recorded.setInterval.push(args), recorded.setInterval.length),
    recorded,
  }
  return Object.assign(ctx, over)
}
