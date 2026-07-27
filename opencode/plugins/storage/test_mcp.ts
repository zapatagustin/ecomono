/**
 * MCP server integration test — run: bun run test_mcp.ts
 * Drives a real JSON-RPC handshake over stdio against BOTH entrypoints:
 * initialize -> tools/list -> tools/call (save, then search finds it).
 *
 * mcp-server.js is the one that matters: it is the committed bundle Claude Code
 * actually runs, and it is vendored into nixos-config too, so a bug there ships
 * even when the sources are fine. check-bundle.sh keeps the two in sync; this
 * exercises them both so neither is taken on faith.
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

async function drive(entry: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "ecomono-mcp-"))

  // process.execPath, not "bun": bun is often installed outside PATH (~/.bun/bin).
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, entry)], {
    cwd: dataDir,
    env: { ...process.env, ECOMONO_DATA_DIR: dataDir, ECOMONO_LEGACY_DB: join(tmpdir(), "no-legacy.db") },
    stdin: "pipe",
    stdout: "pipe",
  })

  const writer = proc.stdin
  const send = async (msg: any) => {
    writer.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"))
    await writer.flush()
  }

  // Read newline-delimited JSON-RPC responses, resolving by id.
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
  assert(init.result?.serverInfo?.name === "ecomono-memory", `${entry}: initialize returns server info`)
  assert(init.result?.instructions?.includes("ecomono-memory — Persistent Memory Protocol"), `${entry}: initialize carries memory protocol instructions`)
  await send({ jsonrpc: "2.0", method: "notifications/initialized" })

  const list = await rpc(2, "tools/list", {})
  const names = (list.result?.tools ?? []).map((t: any) => t.name)
  assert(names.length === 19, `${entry}: tools/list returns 19 tools, got ${names.length}`)
  assert(names.includes("mem_save") && names.includes("mem_search"), `${entry}: core tools present`)

  const saved = await rpc(3, "tools/call", { name: "mem_save", arguments: { title: "mcp handshake works", content: "over stdio", project: "t" } })
  const savedObj = JSON.parse(saved.result.content[0].text)
  assert(savedObj.id > 0, `${entry}: mem_save via MCP returns id`)

  const search = await rpc(4, "tools/call", { name: "mem_search", arguments: { query: "handshake stdio", project: "t" } })
  const hits = JSON.parse(search.result.content[0].text)
  assert(hits.length === 1 && hits[0].id === savedObj.id, `${entry}: mem_search via MCP finds saved obs`)

  proc.kill()
}

for (const entry of ["mcp-server.ts", "mcp-server.js"]) await drive(entry)

console.log("✓ mcp: initialize + tools/list(19) + save/search over stdio, source and bundle")
