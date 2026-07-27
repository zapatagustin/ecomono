/**
 * ecomono-memory — OpenCode plugin adapter
 *
 * Native bun:sqlite persistent memory (no external Go binary). This file is the
 * OpenCode adapter: it wraps the shared mem_* tool registry (storage/tools.ts)
 * in OpenCode's Plugin API, injects the memory protocol into the system prompt,
 * and captures user prompts. The same registry backs the Claude Code MCP server
 * (mcp-server.ts), so both hosts share one storage + one tool surface.
 */

import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { getDb } from "./storage/db"
import { registry } from "./storage/tools"
import { MEMORY_INSTRUCTIONS } from "./storage/protocol"
import * as Sess from "./storage/sessions"
import * as Prompts from "./storage/prompts"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractProjectName(directory: string): string {
  try {
    const r = Bun.spawnSync(["git", "-C", directory, "remote", "get-url", "origin"])
    if (r.exitCode === 0) {
      const name = r.stdout?.toString().trim().replace(/\.git$/, "").split(/[/:]/).pop()
      if (name) return name
    }
  } catch {}
  try {
    const r = Bun.spawnSync(["git", "-C", directory, "rev-parse", "--show-toplevel"])
    if (r.exitCode === 0) {
      const root = r.stdout?.toString().trim()
      if (root) return root.split("/").pop() ?? "unknown"
    }
  } catch {}
  return directory.split("/").pop() ?? "unknown"
}

function textFromParts(parts: any[]): string {
  return (parts || [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const MemoryPlugin: Plugin = async (input) => {
  const project = extractProjectName(input.directory || process.cwd())

  // Memory must never take down the editing session. A store we cannot open
  // (corrupt file, full disk, bad permissions) degrades to no memory at all:
  // no tools and no protocol injection, since telling the agent to call mem_save
  // when the tools are absent is worse than staying quiet about it.
  try {
    getDb() // initialize schema + run one-time legacy migration
  } catch (e) {
    console.error("[ecomono-memory] storage unavailable, memory disabled:", (e as Error).message)
    return {}
  }

  // Build OpenCode tool definitions from the shared registry. Inject the
  // detected project for tools that accept one but weren't given it.
  const tool: Record<string, ToolDefinition> = {}
  for (const t of registry) {
    const takesProject = "project" in t.args
    tool[t.name] = {
      description: t.description,
      args: t.args,
      execute: async (args: any) => {
        if (takesProject && args.project == null) args.project = project
        const result = await t.handler(args)
        return typeof result === "string" ? result : JSON.stringify(result)
      },
    }
  }

  return {
    tool,

    // Record each user prompt (and lazily ensure the session row exists).
    "chat.message": async (inp, out) => {
      try {
        Sess.ensureSession(inp.sessionID, project)
        const text = textFromParts(out.parts)
        if (text) Prompts.savePrompt(inp.sessionID, text)
      } catch (e) {
        console.error("[ecomono-memory] prompt capture failed:", (e as Error).message)
      }
    },

    // Teach the agent the memory protocol.
    "experimental.chat.system.transform": async (_inp, out) => {
      out.system.push(MEMORY_INSTRUCTIONS)
    },

    // Survive compaction: remind the agent the protocol still applies.
    "experimental.session.compacting": async (_inp, out) => {
      out.context.push(MEMORY_INSTRUCTIONS)
    },
  }
}

export default MemoryPlugin
