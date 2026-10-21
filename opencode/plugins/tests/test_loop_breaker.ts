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

const userMessage = (hooks: Hooks, sessionID: string) => hooks["chat.message"]!({ sessionID } as any, {} as any)

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

const args = { command: "curl -sL https://example.invalid" }
const other = (n: number | string) => ({ command: `other ${n}` })

// Fresh plugin instance per scenario: state lives in the closure.
const fresh = () => LoopBreaker({} as any)

const identical = async (hooks: Hooks, sid: string, n: number, a: unknown = args, out = "(no output)") => {
  for (let i = 0; i < n; i++) await call(hooks, sid, "bash", a, out)
}

// LIMIT identical results pass; the next identical call is rejected.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  const msg = await rejected(() => call(hooks, "s1", "bash", args, "(no output)"))
  assert.ok(msg?.startsWith("loop-breaker: `bash` was called 3 times"), `expected rejection, got: ${msg}`)

  // Immediate identical retry after the rejection is still rejected: the
  // model must change approach, not retry.
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))

  // A different call lifts the block; the rejected call then starts a fresh count.
  assert.equal(await rejected(() => call(hooks, "s1", "bash", other("a"), "a")), undefined)
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
}

// The rejection says what lifts it, so the model is not told a retry is futile
// when it is not.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  const msg = await rejected(() => call(hooks, "s1", "bash", args, "(no output)"))
  assert.ok(msg?.includes("different call"), `message must name a different call: ${msg}`)
  assert.ok(msg?.includes("new message"), `message must name a new user message: ${msg}`)
}

// A new user message in the same session lifts the block, and the identical call
// then counts from 1 again: LIMIT more pass, the next is rejected.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
  await userMessage(hooks, "s1")
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
}

// A user message in a DIFFERENT session does not lift s1's block.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
  await userMessage(hooks, "s2")
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
  await userMessage(hooks, "s1")
  assert.equal(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")), undefined)
}

// A different call lifts the block even when it fails and never reaches the
// after hook (before runs, the tool throws, after does not).
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s1", callID: "c" } as any, { args: other("fails") })
  assert.equal(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")), undefined)
}

// A different tool with the same arguments is a different call.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.equal(await rejected(() => call(hooks, "s1", "read", args, "(no output)")), undefined)
}

// Consecutive means consecutive: A A A B A passes, and so does A A B A A B A A.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  await call(hooks, "s1", "bash", other("b"), "b")
  assert.equal(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")), undefined)

  const h2 = await fresh()
  for (let i = 0; i < 10; i++) {
    await identical(h2, "s1", LIMIT - 1)
    await call(h2, "s1", "bash", other("b"), "b")
  }
}

// Idempotent probes interleaved with real work never trip: `git status` that
// prints nothing between an edit and a commit, a silent `tsc` after each edit.
{
  const hooks = await fresh()
  const probe = { command: "git status --short" }
  for (let i = 0; i < LIMIT * 4; i++) {
    assert.equal(await rejected(() => call(hooks, "s1", "bash", probe, "")), undefined)
    await call(hooks, "s1", "edit", { path: "f", n: i }, "ok")
    assert.equal(await rejected(() => call(hooks, "s1", "bash", { command: `git commit -m ${i}` }, "ok")), undefined)
  }
}

// Polling: a changing output resets the counter, so it never trips.
{
  const hooks = await fresh()
  const poll = { command: "transmission-remote -l" }
  for (let i = 0; i < LIMIT * 3; i++) {
    assert.equal(await rejected(() => call(hooks, "s3", "bash", poll, `done ${i}%`)), undefined)
  }
}

// Reset on output: LIMIT-1 identical, then the same call with a new output,
// then LIMIT-1 identical again passes.
{
  const hooks = await fresh()
  await identical(hooks, "s4", LIMIT - 1, args, "x")
  await call(hooks, "s4", "bash", args, "y")
  for (let i = 0; i < LIMIT - 1; i++) {
    assert.equal(await rejected(() => call(hooks, "s4", "bash", args, "x")), undefined)
  }
}

// Sessions are isolated, in both directions.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
  assert.equal(await rejected(() => call(hooks, "s2", "bash", args, "(no output)")), undefined)
  // s2 traffic must not lift s1's block.
  assert.ok(await rejected(() => call(hooks, "s1", "bash", args, "(no output)")))
}

console.log("test_loop_breaker: ok")
