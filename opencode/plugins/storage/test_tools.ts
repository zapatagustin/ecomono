/**
 * Tool-registry test — run: bun run test_tools.ts
 * Exercises the shared mem_* handlers directly (no opencode / no MCP runtime).
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-tools-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const { registryByName } = await import("./tools")
const call = (name: string, args: any = {}) => registryByName[name].handler(args)

// every tool has a name, description, args shape, handler
const { registry } = await import("./tools")
for (const t of registry) {
  assert(t.name.startsWith("mem_"), `tool named ${t.name}`)
  assert(t.description.length > 5, `${t.name} has description`)
  assert(typeof t.handler === "function", `${t.name} has handler`)
  assert(t.args && typeof t.args === "object", `${t.name} has args shape`)
}

const saved = call("mem_save", { title: "Ported engram to bun", content: "native sqlite", type: "architecture", project: "ecomono" }) as any
assert(saved.id > 0, "mem_save returns id")

const found = call("mem_search", { query: "engram bun", project: "ecomono" }) as any[]
assert(found.length === 1 && found[0].id === saved.id, "mem_search finds it")

const got = call("mem_get_observation", { id: saved.id }) as any
assert(got.title === "Ported engram to bun", "mem_get_observation")

assert((call("mem_update", { id: saved.id, content: "native bun:sqlite storage" }) as any).updated, "mem_update")
assert((call("mem_search", { query: "storage", project: "ecomono" }) as any[]).length === 1, "update reindexed")

assert((call("mem_pin", { id: saved.id }) as any).pinned, "mem_pin")
assert((call("mem_unpin", { id: saved.id }) as any).unpinned, "mem_unpin")

assert((call("mem_timeline", { project: "ecomono" }) as any).observations.length === 1, "mem_timeline")
assert((call("mem_stats", { project: "ecomono" }) as any).observations === 1, "mem_stats")
assert((call("mem_suggest_topic_key", { title: "Auth Model!" }) as any).topic_key === "auth-model", "mem_suggest_topic_key")

const doc = call("mem_doctor") as any
assert(doc.ok && doc.db_path.endsWith("memory.db") && doc.observations >= 1, "mem_doctor")

assert((call("mem_delete", { id: saved.id }) as any).deleted, "mem_delete")
assert(call("mem_get_observation", { id: saved.id }) === null, "deleted gone")

console.log(`✓ tools: ${registry.length} tools, all assertions passed`)
