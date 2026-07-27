/**
 * Unopenable-store test — run: bun run test_degraded.ts
 * A broken store must be reported, not thrown: mem_doctor answers ok:false so
 * the agent learns memory is down instead of seeing an opaque tool-call error.
 * Needs its own process because getDb() caches the handle for the module's life.
 */
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

// A regular file where a directory is expected: mkdirSync inside it fails ENOTDIR.
const blocker = join(mkdtempSync(join(tmpdir(), "ecomono-degraded-")), "not-a-dir")
writeFileSync(blocker, "")
process.env.ECOMONO_DATA_DIR = join(blocker, "nested")
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const { registryByName } = await import("./tools")

const doc = registryByName["mem_doctor"].handler({}) as any
assert(doc.ok === false, `mem_doctor reports unhealthy (got ok=${doc.ok})`)
assert(doc.integrity === "unreadable", `integrity flagged (got ${doc.integrity})`)
assert(typeof doc.error === "string" && doc.error.length > 0, "error message surfaced")
assert(doc.db_path.endsWith("memory.db"), "db_path still reported")

// The plugin must not swallow the diagnostic along with everything else: a
// health check the agent cannot reach when the store is broken reports nothing.
const { default: MemoryPlugin } = await import("../memory")
const hooks: any = await MemoryPlugin({ directory: tmpdir() } as any)
assert(Object.keys(hooks.tool ?? {}).length === 1, `degraded plugin exposes exactly one tool, got ${Object.keys(hooks.tool ?? {}).join(",") || "none"}`)
assert(hooks.tool?.mem_doctor, "degraded plugin still exposes mem_doctor")
const viaPlugin = JSON.parse(await hooks.tool.mem_doctor.execute({}))
assert(viaPlugin.ok === false && viaPlugin.integrity === "unreadable", "mem_doctor reachable through the degraded plugin")
// No protocol injection: instructing the agent to save when saving is impossible.
assert(!hooks["experimental.chat.system.transform"], "degraded plugin injects no protocol")

console.log("✓ degraded: unopenable store reported via mem_doctor (registry + plugin), not thrown")
