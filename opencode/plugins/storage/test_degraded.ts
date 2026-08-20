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

// The MCP host (mcp-server.ts/.js) must degrade the same way: still start, still
// answer initialize/tools over stdio, but with only mem_doctor and no protocol
// instructions. Same broken ECOMONO_DATA_DIR/ECOMONO_LEGACY_DB from above,
// inherited by the subprocess via ...process.env. Own process per entrypoint:
// getDb() caches its handle for the module's life, same reason as this file.
async function driveMcp(entry: string) {
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, entry)], {
    cwd: tmpdir(),
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
  })

  const writer = proc.stdin
  const send = async (msg: any) => {
    writer.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"))
    await writer.flush()
  }

  const pending = new Map<number, (v: any) => void>()
  ;(async () => {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of proc.stdout as any) {
      buf += decoder.decode(chunk)
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id) }
        } catch {}
      }
    }
  })()

  const rpc = (id: number, method: string, params?: any): Promise<any> =>
    new Promise((resolve) => {
      pending.set(id, resolve)
      send({ jsonrpc: "2.0", id, method, params })
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: "timeout" }) } }, 5000)
    })

  const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } })
  assert(init.result?.serverInfo?.name === "ecomono-memory", `${entry}: degraded server still answers initialize`)
  assert(init.result?.instructions === undefined, `${entry}: degraded server injects no protocol instructions`)
  await send({ jsonrpc: "2.0", method: "notifications/initialized" })

  const list = await rpc(2, "tools/list", {})
  const names = (list.result?.tools ?? []).map((t: any) => t.name)
  assert(names.length === 1 && names[0] === "mem_doctor", `${entry}: degraded tools/list exposes only mem_doctor, got ${names.join(",") || "none"}`)

  const doctor = await rpc(3, "tools/call", { name: "mem_doctor", arguments: {} })
  const doctorObj = JSON.parse(doctor.result.content[0].text)
  assert(doctorObj.ok === false && doctorObj.integrity === "unreadable", `${entry}: mem_doctor over degraded MCP reports the failure`)

  proc.kill()
}

for (const entry of ["mcp-server.ts", "mcp-server.js"]) await driveMcp(entry)

console.log("✓ degraded: unopenable store reported via mem_doctor over MCP stdio too, not thrown")
