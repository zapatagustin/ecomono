/**
 * Plugin adapter test — run: bun run test_plugin.ts
 * Sets the v2 OpenCode plugin up against the shared fake ctx (../tests/fake-ctx.ts)
 * and drives its tools and hooks the way the host does, verifying the registry
 * is wired and every tool call round-trips through storage.
 * Lives under storage/ for the same reason mcp-server.ts does: OpenCode
 * auto-loads every .ts directly in plugins/, and a test that runs its
 * assertions on every editor start is not a plugin.
 */
import { mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"
import { fakeCtx, fire } from "../tests/fake-ctx"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-plugin-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

// Not a git checkout, so the location's project key is its basename.
const loc = join(mkdtempSync(join(tmpdir(), "ecomono-plugin-loc-")), "memloc")
mkdirSync(loc)

const mod = await import("../memory")
const plugin: any = mod.default
const { getDb } = await import("./db")
const Prompts = await import("./prompts")
const Sess = await import("./sessions")

// v2 module contract: one default {id, setup}, no named exports.
assert.deepEqual(Object.keys(mod), ["default"], `only a default export, got ${Object.keys(mod).join(",")}`)
assert(typeof plugin === "object" && plugin.id === "ecomono-memory" && typeof plugin.setup === "function", "default is {id: ecomono-memory, setup}")

const { ctx, hooks, tools, assertAwaited } = fakeCtx({ directory: loc })
const cleanup = await plugin.setup(ctx)
assertAwaited()
assert(typeof cleanup === "function", "setup returns a cleanup function")

// Exactly these registrations; no compaction hook (the context hook covers the
// first request after a compaction).
assert.deepEqual(Object.keys(hooks).sort(), ["session.context", "session.prompt"], `hooks: ${Object.keys(hooks).join(",")}`)

// all 19 registry tools, direct (not behind Code Mode's execute)
assert(tools.size === 19, `19 tools, got ${tools.size}`)
for (const [name, t] of tools) {
  assert(typeof t.execute === "function" && t.description && t.input, `${name} well-formed`)
  assert(t.options?.codemode === false, `${name} has codemode: false`)
  // What the host sends the model: ~standard.jsonSchema wins over the host's own zod converter.
  const js = t.input["~standard"].jsonSchema.input({ target: "draft-2020-12" })
  assert(js.type === "object" && js.properties && typeof js.properties === "object", `${name} input is an object schema`)
}
const saveSchema = tools.get("mem_save").input["~standard"].jsonSchema.input({ target: "draft-2020-12" })
assert(typeof saveSchema.properties.title.description === "string", "argument descriptions survive the conversion")

// Host path: ~standard.validate on the raw arguments, then execute(value, toolContext).
const toolCtx = { sessionID: "s-tool", agent: "build", messageID: "m", id: "call", signal: new AbortController().signal, progress: async () => {} }
async function call(name: string, raw: any) {
  const t = tools.get(name)
  const v = await t.input["~standard"].validate(raw)
  assert(!v.issues, `${name} input valid: ${JSON.stringify(v.issues)}`)
  const r = await t.execute(v.value, toolCtx)
  assert(typeof r?.content === "string" && !("output" in r), `${name} returns {content: string} and no output`)
  return r.content as string
}
const projectOf = (id: number) => (getDb().query("SELECT project_id FROM observations WHERE id = ?").get(id) as any)?.project_id

// mem_save round-trips to storage, under the location's project
const saved = JSON.parse(await call("mem_save", { title: "adapter works", content: "wired" }))
assert(saved.id > 0, "mem_save round-trips to storage")
assert(projectOf(saved.id) === "memloc", `saved under the location project, got ${projectOf(saved.id)}`)

// mem_search finds it (project auto-injected from the location)
const hits = JSON.parse(await call("mem_search", { query: "adapter wired" }))
assert(hits.match_mode === "all" && hits.results.length === 1 && hits.results[0].id === saved.id, "mem_search via execute finds saved obs")

// a handler throwing (blank-title admission guard) must not reject the execute()
// call — same catch-and-report shape as the MCP adapter's tool wrapper.
const err = await call("mem_save", { title: "", content: "no title" })
assert(err.startsWith("error: ") && err.includes("observation title is required"), "execute catches handler throw and reports it")

// Defaults come from the location, never process.cwd() (the service's $HOME under
// v2). From another cwd, a fallback to process.cwd() would pick "elsewhere".
const prevCwd = process.cwd()
const elsewhere = join(mkdtempSync(join(tmpdir(), "ecomono-plugin-cwd-")), "elsewhere")
mkdirSync(elsewhere)
process.chdir(elsewhere)
assert(JSON.parse(await call("mem_current_project", {})).project === "memloc", "mem_current_project defaults to the location")
const a = JSON.parse(await call("mem_save", { title: "delete me a", content: "x" })).id
const b = JSON.parse(await call("mem_save", { title: "delete me b", content: "x" })).id
assert(JSON.parse(await call("mem_delete", { id: a })).deleted === true, "mem_delete without expected_project guards on the location")
assert(JSON.parse(await call("mem_delete", { id: b, expected_project: "" })).deleted === true, "mem_delete with expected_project \"\" guards on the location")
const u = JSON.parse(await call("mem_save", { title: "update me", content: "x" })).id
assert(JSON.parse(await call("mem_update", { id: u, title: "updated" })).updated === true, "mem_update without expected_project guards on the location")
const blank = JSON.parse(await call("mem_save", { title: "blank project", content: "x", project: "" })).id
assert(projectOf(blank) === "memloc", `project "" lands under the location project, got ${projectOf(blank)}`)
process.chdir(prevCwd)

// system prompt injection, only where mem_save is offered
const sys = await fire(hooks, "session.context", { system: [], tools: { mem_save: {} } })
assert(sys.system.length === 1 && sys.system[0].type === "text" && sys.system[0].text.includes("ecomono-memory — Persistent Memory Protocol"), "context hook pushes one protocol SystemPart")
assert((await fire(hooks, "session.context", { system: [], tools: {} })).system.length === 0, "no protocol when mem_save is not offered")
// malformed (no system array): must not throw, a throw fails the model request
await fire(hooks, "session.context", { tools: { mem_save: {} } })

// prompt capture creates the session + stores the prompt text
await fire(hooks, "session.prompt", { sessionID: "sess-x", messageID: "m1", prompt: { text: "  port engram please " }, delivery: "steer" })
const got = Prompts.getPrompts("sess-x")
assert(got.length === 1 && got[0].content === "port engram please", "prompt hook captured the prompt")
assert(Sess.getSession("sess-x")?.project_id === "memloc", "prompt hook created the session row")

// a subagent child's delegation text is not a user prompt
await fire(hooks, "session.prompt", { sessionID: "child-1", messageID: "m2", prompt: { text: "delegated work" }, delivery: "steer" })
assert(Prompts.getPrompts("child-1").length === 0 && !Sess.getSession("child-1"), "child session stores nothing")

// a failing session lookup or a malformed event must not reject the hook (it would fail admission)
const failing = fakeCtx({ directory: loc, getSession: () => Promise.reject(new Error("lookup down")) })
const cleanupFailing = await plugin.setup(failing.ctx)
await fire(failing.hooks, "session.prompt", { sessionID: "sess-y", messageID: "m3", prompt: { text: "lost" }, delivery: "steer" })
await fire(hooks, "session.prompt", {})
assert(Prompts.getPrompts("sess-y").length === 0, "failed lookup stores nothing")

// Every tool, driven with its schema's minimal required arguments, still
// answers {content: string} (handler errors included). Last: it mutates the store.
const dummy = (p: any) => p?.enum ? p.enum[0] : p?.type === "number" || p?.type === "integer" ? 1 : p?.type === "boolean" ? false : p?.type === "array" ? [] : "x"
for (const [name, t] of tools) {
  const js = t.input["~standard"].jsonSchema.input({ target: "draft-2020-12" })
  await call(name, Object.fromEntries((js.required ?? []).map((k: string) => [k, dummy(js.properties[k])])))
}

// Two setups above, one module evaluation: the shape every location gets when the
// plugin is loaded through a symlink (the deployed layout). They share db.ts's one
// handle, so a location's cleanup leaves it to the others; the last one closes it,
// and the next getDb() opens a fresh one.
const open = getDb()
await cleanup()
assert(getDb() === open, "one location's cleanup keeps the handle the other location still uses")
await cleanupFailing()
assert.throws(() => open.query("SELECT 1").get(), "the last cleanup closed the handle")
assert(getDb() !== open, "getDb() reopens after cleanup")

console.log("✓ plugin: v2 adapter wired, 19 direct tools, prompt + context hooks functional")
