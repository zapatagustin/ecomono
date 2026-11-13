// memory.ts adapter: argument injection and prompt capture. Plain bun script, node:assert,
// non-zero exit on failure (see run-tests.sh). storage/test_plugin.ts covers the registry
// wiring end to end; this pins the adapter's own rules, which that file only touches in passing.
import { mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "node:assert/strict"
import { fakeCtx, fire } from "./fake-ctx"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-memplugin-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

// Not a git checkout, so the location's project key is its basename.
const loc = join(mkdtempSync(join(tmpdir(), "ecomono-memplugin-loc-")), "memloc")
mkdirSync(loc)
const LOC = "memloc"

const { default: plugin }: any = await import("../memory")
const { getDb } = await import("../storage/db")
const { getPrompts } = await import("../storage/prompts")
const { ctx, hooks, tools, assertAwaited } = fakeCtx({ directory: loc })
const cleanup = await plugin.setup(ctx)
assertAwaited()

const toolCtx = { sessionID: "s", agent: "build", messageID: "m", id: "c", signal: new AbortController().signal, progress: async () => {} }
// Fresh args object per call: the adapter mutates what it is handed.
const call = async (name: string, args: any) => JSON.parse((await tools.get(name).execute({ ...args }, toolCtx)).content)
const save = async (title: string, project?: string) => (await call("mem_save", { title, content: "x", ...(project ? { project } : {}) })).id as number
const projectOf = (id: number) => (getDb().query("SELECT project_id FROM observations WHERE id = ?").get(id) as any)?.project_id

// --- expected_project: injected for the four guarded tools, never over the caller's value ---
const guarded: [string, (id: number, extra: any) => Promise<any>, string][] = [
  ["mem_update", (id, e) => call("mem_update", { id, title: "renamed", ...e }), "updated"],
  ["mem_delete", (id, e) => call("mem_delete", { id, ...e }), "deleted"],
  ["mem_pin", (id, e) => call("mem_pin", { id, ...e }), "pinned"],
  ["mem_unpin", (id, e) => call("mem_unpin", { id, ...e }), "unpinned"],
]
for (const [name, run, key] of guarded) {
  // process.cwd() is not the location, so a tool left without the injected value would
  // guard on the wrong project and fail here.
  assert.equal((await run(await save(`${name} injected`), {}))[key], true, `${name}: expected_project injected from the location`)
  const kept = await save(`${name} kept`)
  const wrong = await run(kept, { expected_project: "elsewhere" })
  assert.equal(wrong[key], false, `${name}: a caller's expected_project is not overridden`)
  assert.equal(wrong.row_project, LOC, `${name}: the mismatch is against the caller's value`)
  assert.equal((await run(kept, { expected_project: "*" }))[key], true, `${name}: "*" passes through`)
}

// --- project: injected only when the caller passed none ---
assert.equal(projectOf(await save("no project")), LOC, "mem_save without project lands in the location")
assert.equal(projectOf(await save("explicit project", "explicit")), "explicit", "an explicit project is kept")
const other = await save("due elsewhere", "other-proj")
getDb().run("UPDATE observations SET review_after = datetime('now','-1 day') WHERE id = ?", [other])
const own = await save("due here")
getDb().run("UPDATE observations SET review_after = datetime('now','-1 day') WHERE id = ?", [own])
const scoped = await call("mem_review", { action: "list" })
assert(scoped.some((r: any) => r.id === own) && !scoped.some((r: any) => r.id === other), "mem_review list without project is the location's")
const star = await call("mem_review", { action: "list", project: "*" })
assert(star.some((r: any) => r.id === own) && star.some((r: any) => r.id === other), '"*" reaches the handler untouched and spans projects')

// --- prompt capture strips <private> before storing ---
const fireText = (sessionID: string, text: string) => fire(hooks, "session.prompt", { sessionID, prompt: { text } })
await fireText("sess-1", "deploy with <private>token-123</private> please")
const stored = getPrompts("sess-1") as any[]
assert.equal(stored.length, 1)
assert.equal(stored[0].content, "deploy with  please", "private block stripped before the prompt row is written")
assert(!stored[0].content.includes("token-123"))
await fireText("sess-2", "<private>only secret</private>")
assert.equal(getPrompts("sess-2").length, 0, "a fully private prompt stores nothing")

await cleanup()
console.log("✓ memory.ts: expected_project/project injection and private-stripped prompt capture")
