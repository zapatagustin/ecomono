/**
 * Plugin adapter test — run: bun run test_plugin.ts
 * Instantiates the OpenCode plugin with a fake input and drives its hooks,
 * verifying the registry is wired and tool.execute round-trips through storage.
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-plugin-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const { default: EngramPlugin } = await import("./engram")

const hooks: any = await EngramPlugin({ directory: process.env.ECOMONO_DATA_DIR } as any)

// all 16 registry tools registered with the correct ToolDefinition shape
assert(Object.keys(hooks.tool).length === 19, `19 tools, got ${Object.keys(hooks.tool).length}`)
for (const [name, def] of Object.entries<any>(hooks.tool)) {
  assert(typeof def.execute === "function" && def.args && def.description, `${name} well-formed`)
}

// mem_save via execute returns a JSON string with an id; project injected
const savedRaw = await hooks.tool.mem_save.execute({ title: "adapter works", content: "wired" })
assert(typeof savedRaw === "string", "execute returns string (ToolResult)")
const saved = JSON.parse(savedRaw)
assert(saved.id > 0, "mem_save round-trips to storage")

// mem_search finds it (project auto-injected from plugin's detected project)
const hits = JSON.parse(await hooks.tool.mem_search.execute({ query: "adapter wired" }))
assert(hits.length === 1 && hits[0].id === saved.id, "mem_search via execute finds saved obs")

// system prompt injection
const out: any = { system: [] }
await hooks["experimental.chat.system.transform"]({} as any, out)
assert(out.system.length === 1 && out.system[0].includes("Engram Persistent Memory"), "system.transform injects protocol")

// compaction carries the protocol forward
const cout: any = { context: [] }
await hooks["experimental.session.compacting"]({ sessionID: "s1" } as any, cout)
assert(cout.context.length === 1, "compacting pushes context")

// prompt capture creates the session + stores the prompt text
await hooks["chat.message"]({ sessionID: "sess-x" } as any, { message: {}, parts: [{ type: "text", text: "port engram please" }] } as any)
const Prompts = await import("./storage/prompts")
const got = Prompts.getPrompts("sess-x")
assert(got.length === 1 && got[0].content.includes("port engram"), "chat.message captured prompt")

console.log("✓ plugin: adapter wired, 19 tools, hooks functional")
