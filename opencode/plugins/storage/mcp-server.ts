#!/usr/bin/env bun
/**
 * ecomono-memory MCP server (stdio) — the Claude Code adapter.
 *
 * Exposes the shared mem_* tool registry over the Model Context Protocol so
 * Claude Code registers it with:  claude mcp add ecomono-memory -- bun <path-to-this>
 * The server name is what Claude Code prefixes tools with, so renaming it
 * changes every tool name the agent sees (mcp__ecomono-memory__mem_save).
 * Backed by the same bun:sqlite storage the opencode plugin uses, so both hosts
 * read and write one memory store. Lives under storage/ (a subdir) so OpenCode
 * does not auto-load it as a plugin.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registry } from "./tools"
import { getDb } from "./db"
import { MEMORY_INSTRUCTIONS } from "./protocol"

// Storage must never take down the MCP server itself. A store we cannot open
// (corrupt file, full disk, bad permissions, or a busy_timeout expiry during a
// migration window) degrades to mem_doctor and nothing else — same shape as
// the opencode adapter (../memory.ts): no protocol injection, since telling
// the agent to call mem_save when saving is impossible is worse than staying
// quiet, but the one tool whose job is to report that memory is down has to
// survive the failure it reports on.
let dbOk = true
try {
  getDb() // initialize schema + one-time legacy migration
} catch (e) {
  dbOk = false
  console.error("[ecomono-memory] storage unavailable, memory disabled:", (e as Error).message)
}

// `instructions` reaches Claude Code on initialize — this is how the memory
// protocol gets injected on the Claude Code side (the opencode side injects it
// via the plugin's system-prompt hook). Suppressed when degraded, matching
// the opencode adapter's "no protocol injection" behavior.
const server = new McpServer(
  { name: "ecomono-memory", version: "1.0.0" },
  { instructions: dbOk ? MEMORY_INSTRUCTIONS : undefined },
)

const tools = dbOk ? registry : registry.filter((t) => t.name === "mem_doctor")
for (const t of tools) {
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.args },
    async (args: any) => {
      try {
        const result = await t.handler(args)
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] }
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true }
      }
    },
  )
}

await server.connect(new StdioServerTransport())
