// Plain bun script, node:assert, non-zero exit on failure (see run-tests.sh).
import assert from "node:assert/strict"
import { LoopBreaker } from "../loop-breaker"

// Mirrors LIMIT in loop-breaker.ts. Not exported from there on purpose:
// opencode calls every export of a plugin file as a plugin.
const LIMIT = 3

type Hooks = Awaited<ReturnType<typeof LoopBreaker>>

const call = async (hooks: Hooks, sessionID: string, tool: string, args: unknown, output: string) => {
  await hooks["tool.execute.before"]!({ tool, sessionID, callID: "c" } as any, { args })
  await hooks["tool.execute.after"]!({ tool, sessionID, callID: "c", args } as any, {
    title: "",
    output,
    metadata: {},
  })
}

const rejected = async (fn: () => Promise<void>) => {
  try {
    await fn()
  } catch (e) {
    return (e as Error).message
  }
  return undefined
}

// Single export: anything else makes opencode skip the whole file.
const mod = await import("../loop-breaker")
assert.deepEqual(Object.keys(mod), ["LoopBreaker"], "loop-breaker.ts must export exactly LoopBreaker")

const hooks = await LoopBreaker({} as any)
const args = { command: "curl -sL https://example.invalid" }

// LIMIT identical results pass; the next identical call is rejected.
for (let i = 0; i < LIMIT; i++) await call(hooks, "s1", "bash", args, "(no output)")
const msg = await rejected(() => call(hooks, "s1", "bash", args, "(no output)"))
assert.ok(msg?.startsWith("loop-breaker: `bash` was called 3 times"), `expected rejection, got: ${msg}`)

// Still rejected afterwards: the model must change approach, not retry.
assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))

// Different arguments in the same session are unaffected.
assert.equal(await rejected(() => call(hooks, "s1", "bash", { command: "ls" }, "a")), undefined)

// Another session is isolated.
assert.equal(await rejected(() => call(hooks, "s2", "bash", args, "(no output)")), undefined)

// Polling: a changing output resets the counter, so it never trips.
const poll = { command: "transmission-remote -l" }
for (let i = 0; i < LIMIT * 3; i++) {
  assert.equal(await rejected(() => call(hooks, "s3", "bash", poll, `done ${i}%`)), undefined)
}

// Reset: LIMIT-1 identical, then one different, then LIMIT-1 identical again passes.
for (let i = 0; i < LIMIT - 1; i++) await call(hooks, "s4", "bash", args, "x")
await call(hooks, "s4", "bash", args, "y")
for (let i = 0; i < LIMIT - 1; i++) {
  assert.equal(await rejected(() => call(hooks, "s4", "bash", args, "x")), undefined)
}

console.log("test_loop_breaker: ok")
