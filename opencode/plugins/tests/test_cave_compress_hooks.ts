/**
 * Hook-level tests for ../cave-compress.ts against the v2 plugin API, driven
 * through the shared fake ctx (./fake-ctx.ts), whose hook-name whitelist turns a
 * misspelled hook into a throw instead of a silent no-op. The pure compression
 * helpers are covered by test_cave_compress.ts. Every case runs a fresh setup,
 * since v2 keeps the plugin's state per setup call.
 */

import assert from "node:assert"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { fakeCtx, fire } from "./fake-ctx"

// The stats file path is fixed when the plugin module is evaluated, so point
// it at a temp dir before importing: the real ~/.cache file is never touched.
const cacheDir = mkdtempSync(join(tmpdir(), "cave-hooks-"))
process.env.XDG_CACHE_HOME = cacheDir
delete process.env.ECOMONO_COMPRESS_STATS
delete process.env.ECOMONO_COMPRESS
const { default: plugin } = await import("../cave-compress")

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n")
const textOf = (content: any[]) => content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
const readOut = (path: string, body: string) =>
  `Read file ${path}, lines 1-${body.split("\n").length}\n` + body.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")
const STUB = "[File unchanged since read #"

async function fresh() {
  const f = fakeCtx({ directory: "/repo" })
  assert.strictEqual(await plugin.setup(f.ctx), undefined, "setup returns no cleanup")
  f.assertAwaited()
  let n = 0
  // One tool call: execute.before, then execute.after. `after` overrides the
  // after-event fields (status, result, error). Returns the post-hook content.
  const call = async (tool: string, input: any, content: any, o: { id?: string; sessionID?: string; after?: any } = {}) => {
    const base = { tool, sessionID: o.sessionID ?? "s1", agent: "build", messageID: "m1", id: o.id ?? `c${++n}`, input }
    await fire(f.hooks, "tool.execute.before", { ...base })
    const ev = {
      ...base,
      status: "completed",
      result: { content: typeof content === "string" ? [{ type: "text", text: content }] : content },
      ...o.after,
    }
    await fire(f.hooks, "tool.execute.after", ev)
    return ev.result?.content
  }
  const read = (path: string, body: string, sessionID?: string) => call("read", { path }, readOut(path, body), { sessionID })
  return { ...f, call, read }
}

// ── 1. Contract and registrations ────────────────────────────────────────────

{
  const mod = await import("../cave-compress")
  assert.deepStrictEqual(Object.keys(mod), ["default"], "the default export is the only export")
  assert.strictEqual(plugin.id, "cave-compress")
  assert.strictEqual(typeof plugin.setup, "function")
  const { hooks } = await fresh()
  assert.deepStrictEqual(
    Object.keys(hooks).sort(),
    ["session.compaction", "tool.execute.after", "tool.execute.before"],
    "exactly these hooks are registered",
  )
  for (const key of Object.keys(hooks)) assert.strictEqual(hooks[key].length, 1, `${key} is registered once`)
}

// ── 2. Shell output: structured pass and the bash budget ─────────────────────

{
  const { call } = await fresh()
  const inspect = [
    {
      State: { Status: "running", Pid: 42 },
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Key${i}`, { a: i, b: [1, 2, 3, 4, 5] }])),
    },
  ]
  const json = await call("shell", { command: "docker inspect x" }, JSON.stringify(inspect, null, 2))
  assert.ok(textOf(json).includes("[JSON compressed:"), "shell JSON goes through the structured pass")
  assert.ok(textOf(json).includes('"State"'), "the docker inspect key hint is kept")

  const long = await call("shell", { command: "seq 1 200" }, lines(200))
  assert.ok(textOf(long).includes("(bash budget: 80)"), "shell is aliased to the bash budget")
  assert.ok(textOf(long).split("\n").length < 90)
}

// ── 3. Read deduplication and path normalization ─────────────────────────────

{
  const { read } = await fresh()
  const first = await read("src/a.ts", "const a = 1")
  assert.ok(!textOf(first).startsWith(STUB), "a first read is full")
  const second = await read("src/a.ts", "const a = 1")
  assert.ok(textOf(second).startsWith(`${STUB}1.`), "an identical re-read is a stub")
}
{
  const { read, call } = await fresh()
  await read("src/a.ts", "const a = 1")
  await call("edit", { path: "/repo/src/a.ts", oldString: "1", newString: "1" }, "Edited /repo/src/a.ts")
  const again = await read("src/a.ts", "const a = 1")
  assert.ok(!textOf(again).startsWith(STUB), "an absolute edit invalidates a relative read")
}

// ── 4. Invalidation by edit, patch and failed patch ──────────────────────────

{
  const { read, call } = await fresh()
  await read("e.ts", "x")
  const editOut = [{ type: "text", text: lines(200) }]
  const edited = await call("edit", { path: "e.ts", oldString: "x", newString: "y" }, editOut)
  assert.deepStrictEqual(edited, editOut, "a write tool's own output is never compressed")
  assert.ok(!textOf(await read("e.ts", "x")).startsWith(STUB), "edit invalidates")

  await read("p.ts", "x")
  await call("patch", { patchText: "*** Begin Patch\n*** Update File: p.ts\n@@\n-x\n+x\n*** End Patch" }, "Applied", {
    after: { result: { output: { applied: [{ type: "update", resource: "p.ts", target: "/repo/p.ts" }] }, content: [] } },
  })
  assert.ok(!textOf(await read("p.ts", "x")).startsWith(STUB), "patch invalidates its applied targets")

  const homeFile = join(homedir(), "r.ts")
  await read("q.ts", "x")
  await read(homeFile, "x")
  await call("patch", { patchText: "*** Begin Patch\n*** Add File: q.ts\n+x\n*** Delete File: ~/r.ts\n*** End Patch" }, "", {
    after: { status: "error", result: undefined, error: { message: "Failed to write q.ts" } },
  })
  assert.ok(!textOf(await read("q.ts", "x")).startsWith(STUB), "a failed patch invalidates the files in its text")
  assert.ok(!textOf(await read(homeFile, "x")).startsWith(STUB), "~/ paths resolve against the home directory")
}

// ── 5. Image read keeps its file part and never stubs ────────────────────────

{
  const { call } = await fresh()
  const image = () => [
    { type: "text", text: "Image read successfully" },
    { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "i.png" },
  ]
  await call("read", { path: "i.png" }, image())
  const again = await call("read", { path: "i.png" }, image())
  assert.deepStrictEqual(again, image(), "an image re-read keeps its file part and is not stubbed")
}

// ── 6. Directory read: list budget, no dedupe ────────────────────────────────

{
  const { call } = await fresh()
  const listing = `Read directory src, entries 1-200\n${lines(200, "file")}`
  const first = await call("read", { path: "src" }, listing)
  assert.ok(textOf(first).includes("(list budget: 60)"), "a directory read gets the list budget")
  const second = await call("read", { path: "src" }, listing)
  assert.ok(!textOf(second).startsWith(STUB), "a directory re-read is never stubbed")
}

// ── 7. Code Mode: inner calls skipped, outer execute compressed ──────────────

{
  const { hooks } = await fresh()
  const base = { sessionID: "s1", agent: "build", messageID: "m1", id: "X" }
  const outerAfter = { ...base, tool: "execute", input: { code: "..." }, status: "completed", result: { content: [{ type: "text", text: lines(200) }] } }
  const innerAfter = { ...base, tool: "context7_q", input: {}, status: "completed", result: { content: [{ type: "text", text: lines(200) }] } }
  await fire(hooks, "tool.execute.before", { ...base, tool: "execute", input: { code: "..." } })
  await fire(hooks, "tool.execute.before", { ...base, tool: "context7_q", input: {} })
  await fire(hooks, "tool.execute.after", innerAfter)
  assert.strictEqual(textOf(innerAfter.result.content), lines(200), "an inner Code Mode call is untouched")
  // The same call id in another session is not an inner call.
  const other = { ...innerAfter, sessionID: "s2", result: { content: [{ type: "text", text: lines(200) }] } }
  await fire(hooks, "tool.execute.after", other)
  assert.ok(textOf(other.result.content).includes("budget: 150"), "inner ids are scoped per session")
  await fire(hooks, "tool.execute.after", outerAfter)
  assert.ok(textOf(outerAfter.result.content).includes("(execute budget: 150)"), "the outer execute result is compressed")
  // The outer `after` ends the script: a later call with that id is compressed again.
  const later = { ...innerAfter, result: { content: [{ type: "text", text: lines(200) }] } }
  await fire(hooks, "tool.execute.after", later)
  assert.ok(textOf(later.result.content).includes("budget: 150"), "the outer after clears the inner set")
}

// ── 8. ECOMONO_COMPRESS=off ──────────────────────────────────────────────────

{
  const { call, read, hooks } = await fresh()
  process.env.ECOMONO_COMPRESS = "off"
  try {
    assert.strictEqual(textOf(await call("shell", { command: "seq" }, lines(200))), lines(200), "off: no compression")
    await read("a.ts", "x")
    assert.ok(!textOf(await read("a.ts", "x")).startsWith(STUB), "off: no dedupe")
    const ev = await fire(hooks, "session.compaction", { sessionID: "s1", system: [], messages: [] })
    assert.deepStrictEqual(ev.system, [], "off: no compaction style")
  } finally {
    delete process.env.ECOMONO_COMPRESS
  }
}

// ── 9. Compaction: one style part, and the session's read cache is dropped ───

{
  const { read, hooks } = await fresh()
  await read("a.ts", "x", "s1")
  await read("a.ts", "x", "s2")
  const ev = await fire(hooks, "session.compaction", { sessionID: "s1", system: [], messages: [] })
  assert.strictEqual(ev.system.length, 1)
  assert.strictEqual(ev.system[0].type, "text")
  assert.ok(ev.system[0].text.includes("compressed ecomono style"))
  assert.ok(ev.system[0].text.endsWith("Keep the required section headings unchanged."))
  assert.ok(!textOf(await read("a.ts", "x", "s1")).startsWith(STUB), "compaction clears the session's cache")
  assert.ok(textOf(await read("a.ts", "x", "s2")).startsWith(STUB), "other sessions keep theirs")
}

// ── 10. Malformed events never throw ─────────────────────────────────────────

{
  const { hooks } = await fresh()
  for (const ev of [
    {},
    { tool: "read" },
    { tool: "read", status: "completed" },
    { tool: "read", status: "completed", input: null, result: { content: [{ type: "text", text: "x" }] } },
    { tool: "shell", status: "completed", result: { content: "not an array" } },
    { tool: "shell", status: "completed", result: { content: [null, { type: "text" }] } },
    { tool: "patch", status: "error" },
    { tool: "patch", status: "completed", result: { output: { applied: [null, { target: 7 }] } } },
    { tool: "edit", status: "completed", input: { path: 42 } },
    // These two reach a throwing path, so they pin the try/catch itself.
    null,
    { tool: "shell", status: "completed", input: {}, result: Object.freeze({ content: [{ type: "text", text: lines(200) }] }) },
  ]) {
    await fire(hooks, "tool.execute.before", { ...ev })
    await fire(hooks, "tool.execute.after", ev)
  }
  await fire(hooks, "session.compaction", {})
  await fire(hooks, "session.compaction", null)
}

// ── 12. A skill result passes through whole ──────────────────────────────────

{
  const { call } = await fresh()
  const skill = lines(343, "skill")
  assert.strictEqual(textOf(await call("skill", { id: "x" }, skill)), skill, "skill output is never truncated")
}

// ── 11. Stats are written to the temp cache dir ──────────────────────────────

await new Promise((r) => setTimeout(r, 50))
const stats = readFileSync(join(cacheDir, "ecomono-compress", "stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
assert.ok(stats.some((r) => r.tool === "bash" && r.gross > 0), "a compressed shell result logs a bash stats record")
rmSync(cacheDir, { recursive: true, force: true })

console.log("test_cave_compress_hooks: ok")
