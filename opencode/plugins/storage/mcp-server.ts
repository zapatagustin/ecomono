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

getDb() // initialize schema + one-time legacy migration

// `instructions` reaches Claude Code on initialize — this is how the memory
// protocol gets injected on the Claude Code side (the opencode side injects it
// via the plugin's system-prompt hook).
const server = new McpServer({ name: "ecomono-memory", version: "1.0.0" }, { instructions: MEMORY_INSTRUCTIONS })

for (const t of registry) {
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
