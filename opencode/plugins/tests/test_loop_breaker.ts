// Plain bun script, node:assert, non-zero exit on failure (see run-tests.sh).
import assert from "node:assert/strict"
import plugin, { LIMIT } from "../loop-breaker"
import { fakeCtx, fire, type Hooks } from "./fake-ctx"

// v2 module shape: the loader reads only the default export.
assert.equal(plugin.id, "loop-breaker")
assert.equal(typeof plugin.setup, "function")

let n = 0
// v2 execute.before event; execute.after is the same plus status and result/error.
const ev = (sessionID: string, tool: string, input: unknown, id = `c${++n}`) =>
  ({ tool, sessionID, agent: "build", messageID: "m", id, input })
const text = (t: string) => [{ type: "text", text: t }]

const call = async (hooks: Hooks, sessionID: string, tool: string, args: unknown, output: string | unknown[]) => {
  const e = ev(sessionID, tool, args)
  await fire(hooks, "tool.execute.before", e)
  await fire(hooks, "tool.execute.after", {
    ...e,
    status: "completed",
    result: { content: typeof output === "string" ? text(output) : output },
  })
}

// The tool ran and failed: execute.after fires with status "error".
const failed = async (hooks: Hooks, sessionID: string, tool: string, args: unknown) => {
  const e = ev(sessionID, tool, args)
  await fire(hooks, "tool.execute.before", e)
  await fire(hooks, "tool.execute.after", { ...e, status: "error", error: { message: "exit 1" } })
}

const userMessage = (hooks: Hooks, sessionID: string) =>
  fire(hooks, "session.prompt", { sessionID, messageID: "u", prompt: { text: "retry" }, delivery: "steer" })

const rejected = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (e) {
    return (e as Error).message
  }
  return undefined
}

const args = { command: "curl -sL https://example.invalid" }
const other = (n: number | string) => ({ command: `other ${n}` })

// Fresh plugin instance per scenario: state lives in the setup closure.
// Exactly these three hooks, once each, every registration awaited (C2), and no
// cleanup returned.
const fresh = async () => {
  const { ctx, hooks, assertAwaited } = fakeCtx()
  assert.equal(await plugin.setup(ctx), undefined)
  assertAwaited()
  assert.deepEqual(
    Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length])),
    { "tool.execute.before": 1, "tool.execute.after": 1, "session.prompt": 1 },
  )
  return hooks
}

// The fake's own guards, which every plugin suite leans on: a misspelled hook name
// or domain throws instead of registering nothing, and a registration setup never
// awaited fails assertAwaited, whether it is dropped bare or still subscribed.
{
  const { ctx, hooks, assertAwaited } = fakeCtx()
  assert.throws(() => ctx.tool.hook("execute.befor", () => {}), { message: "unknown hook tool.execute.befor" })
  assert.throws(() => ctx.tool.hook("tool.execute.before", () => {}), { message: "unknown hook tool.tool.execute.before" })
  assert.throws(() => ctx.sesion.hook("prompt", () => {}), { message: "unknown hook sesion.prompt" })
  assert.deepEqual(hooks, {})
  assertAwaited()
  await (async () => { await ctx.session.hook("prompt", () => {}) })()
  assertAwaited()
  void ctx.session.hook("prompt", () => {})
  assert.throws(assertAwaited, { message: /^setup resolved with 1 hook\/transform registration/ })
}
{
  const { ctx, assertAwaited } = fakeCtx()
  await (async () => { void Promise.all([ctx.session.hook("prompt", () => {})]) })()
  assert.throws(assertAwaited, { message: /^setup resolved with 1 hook\/transform registration/ })
}

const identical = async (hooks: Hooks, sid: string, n: number, a: unknown = args, out = "(no output)") => {
  for (let i = 0; i < n; i++) await call(hooks, sid, "shell", a, out)
}

// LIMIT identical results pass; the next identical call is rejected.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  const msg = await rejected(() => call(hooks, "s1", "shell", args, "(no output)"))
  assert.ok(msg?.startsWith("loop-breaker: `shell` was called 3 times"), `expected rejection, got: ${msg}`)

  // Immediate identical retry after the rejection is still rejected: the
  // model must change approach, not retry.
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))

  // A different call lifts the block; the rejected call then starts a fresh count.
  assert.equal(await rejected(() => call(hooks, "s1", "shell", other("a"), "a")), undefined)
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
}

// The rejection says what lifts it, so the model is not told a retry is futile
// when it is not.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  const msg = await rejected(() => call(hooks, "s1", "shell", args, "(no output)"))
  assert.ok(msg?.includes("different call"), `message must name a different call: ${msg}`)
  assert.ok(msg?.includes("new message"), `message must name a new user message: ${msg}`)
}

// A new user message in the same session lifts the block, and the identical call
// then counts from 1 again: LIMIT more pass, the next is rejected.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  await userMessage(hooks, "s1")
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
}

// A user message in a DIFFERENT session does not lift s1's block.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  await userMessage(hooks, "s2")
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  await userMessage(hooks, "s1")
  assert.equal(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")), undefined)
}

// A different call lifts the block even when it fails: after fires with
// status "error", or not at all when a later before hook rejects the call.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  await failed(hooks, "s1", "shell", other("fails"))
  assert.equal(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")), undefined)

  await identical(hooks, "s1", LIMIT - 1)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  await fire(hooks, "tool.execute.before", ev("s1", "shell", other("rejected elsewhere")))
  assert.equal(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")), undefined)
}

// (a) An identical call that errors neither counts nor resets the slot:
// LIMIT-1 completed, one error, one more completed passes, the next is rejected.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT - 1)
  await failed(hooks, "s1", "shell", args)
  assert.equal(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")), undefined)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
}

// (b) Malformed events never throw (a throw outside execute.before is a host
// defect that fails the call), and the plugin keeps working afterwards.
{
  const hooks = await fresh()
  for (const bad of [
    undefined,
    null,
    {},
    { status: "completed" },
    { tool: "shell", sessionID: "s1", status: "completed", result: undefined },
    { tool: "shell", sessionID: "s1", status: "completed", result: { content: "not an array" } },
    { tool: "shell", sessionID: "s1", status: "completed", result: { content: [{ type: "json", value: 1n }] } },
  ]) {
    assert.equal(await rejected(() => fire(hooks, "tool.execute.after", bad)), undefined, `after threw on ${String(bad)}`)
  }
  for (const bad of [undefined, null, {}]) {
    assert.equal(await rejected(() => fire(hooks, "session.prompt", bad)), undefined)
  }
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
}

// (c) A file part hashes stably (equal value, fresh objects), and a different
// file is a different result.
{
  const read = { path: "shot.png" }
  const file = (data = "iVBORw0KGgo=") => [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png" }]
  const hooks = await fresh()
  for (let i = 0; i < LIMIT; i++) await call(hooks, "s1", "read", read, file())
  assert.ok(await rejected(() => call(hooks, "s1", "read", read, file())))

  const h2 = await fresh()
  for (let i = 0; i < LIMIT; i++) await call(h2, "s1", "read", read, file(String(i)))
  assert.equal(await rejected(() => call(h2, "s1", "read", read, file(String(LIMIT)))), undefined)
}

// (d) shell's truncation notice names a fresh saved-output file per call; the
// same output with a different notice is still the same result.
{
  const hooks = await fresh()
  const logs = { command: "journalctl -u x --no-pager" }
  const out = (i: number) =>
    `tail line\n\n[showing lines 2001-4000 of 4000; full output saved to /home/u/.local/share/opencode/tool-output/sh_${i}.out]`
  for (let i = 0; i < LIMIT; i++) await call(hooks, "s1", "shell", logs, out(i))
  assert.ok(await rejected(() => call(hooks, "s1", "shell", logs, out(LIMIT))))
}

// (e) Code Mode: inner calls carry the outer `execute` call's sessionID and id.
// They are skipped (more than LIMIT identical inner calls in one script never
// trip), and identical `execute` scripts with identical output block the 4th.
{
  const hooks = await fresh()
  const script = { code: "for (let i = 0; i < 4; i++) await context7.q({ q: 'same' })" }
  const run = async (id: string) => {
    const outer = ev("s1", "execute", script, id)
    await fire(hooks, "tool.execute.before", outer)
    for (let i = 0; i <= LIMIT; i++) {
      const e = ev("s1", "context7_q", { q: "same" }, id)
      await fire(hooks, "tool.execute.before", e)
      await fire(hooks, "tool.execute.after", { ...e, status: "completed", result: { content: text("same") } })
    }
    await fire(hooks, "tool.execute.after", { ...outer, status: "completed", result: { content: text("done") } })
  }
  for (let i = 0; i < LIMIT; i++) await run(`X${i}`)
  const msg = await rejected(() => run(`X${LIMIT}`))
  assert.ok(msg?.startsWith("loop-breaker: `execute` was called 3 times"), `expected execute rejection, got: ${msg}`)
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
  await call(hooks, "s1", "shell", other("b"), "b")
  assert.equal(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")), undefined)

  const h2 = await fresh()
  for (let i = 0; i < 10; i++) {
    await identical(h2, "s1", LIMIT - 1)
    await call(h2, "s1", "shell", other("b"), "b")
  }
}

// Idempotent probes interleaved with real work never trip: `git status` that
// prints nothing between an edit and a commit, a silent `tsc` after each edit.
{
  const hooks = await fresh()
  const probe = { command: "git status --short" }
  for (let i = 0; i < LIMIT * 4; i++) {
    assert.equal(await rejected(() => call(hooks, "s1", "shell", probe, "")), undefined)
    await call(hooks, "s1", "edit", { path: "f", n: i }, "ok")
    assert.equal(await rejected(() => call(hooks, "s1", "shell", { command: `git commit -m ${i}` }, "ok")), undefined)
  }
}

// Polling: a changing output resets the counter, so it never trips.
{
  const hooks = await fresh()
  const poll = { command: "transmission-remote -l" }
  for (let i = 0; i < LIMIT * 3; i++) {
    assert.equal(await rejected(() => call(hooks, "s3", "shell", poll, `done ${i}%`)), undefined)
  }
}

// Reset on output: LIMIT-1 identical, then the same call with a new output,
// then LIMIT-1 identical again passes.
{
  const hooks = await fresh()
  await identical(hooks, "s4", LIMIT - 1, args, "x")
  await call(hooks, "s4", "shell", args, "y")
  for (let i = 0; i < LIMIT - 1; i++) {
    assert.equal(await rejected(() => call(hooks, "s4", "shell", args, "x")), undefined)
  }
}

// Sessions are isolated, in both directions.
{
  const hooks = await fresh()
  await identical(hooks, "s1", LIMIT)
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
  assert.equal(await rejected(() => call(hooks, "s2", "shell", args, "(no output)")), undefined)
  // s2 traffic must not lift s1's block.
  assert.ok(await rejected(() => call(hooks, "s1", "shell", args, "(no output)")))
}

console.log("test_loop_breaker: ok")
