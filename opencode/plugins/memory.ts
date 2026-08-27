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
import * as Obs from "./storage/observations"
import * as Sess from "./storage/sessions"
import * as Prompts from "./storage/prompts"

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Project key derivation lives in storage/observations.ts's currentProject() —
// the same function the Claude Code MCP server uses (via tools.ts's proj()) —
// so both hosts resolve one repo to the same project key regardless of which
// one saves the observation.

function textFromParts(parts: any[]): string {
  return (parts || [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const MemoryPlugin: Plugin = async (input) => {
  const project = Obs.currentProject(input.directory || process.cwd()).project

  // Memory must never take down the editing session. A store we cannot open
  // (corrupt file, full disk, bad permissions) degrades to mem_doctor and
  // nothing else: no protocol injection, since telling the agent to call
  // mem_save when saving is impossible is worse than staying quiet — but the
  // one tool whose job is to report that memory is down has to survive the
  // failure it reports on, or the only trace is a stderr line nobody sees.
  try {
    getDb() // initialize schema + run one-time legacy migration
  } catch (e) {
    console.error("[ecomono-memory] storage unavailable, memory disabled:", (e as Error).message)
    const doctor = registry.find((t) => t.name === "mem_doctor")!
    return {
      tool: {
        // Its own handler catches the same failure and answers ok:false.
        mem_doctor: {
          description: doctor.description,
          args: doctor.args,
          execute: async () => JSON.stringify(doctor.handler({})),
        },
      },
    }
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
        try {
          const result = await t.handler(args)
          return typeof result === "string" ? result : JSON.stringify(result)
        } catch (e) {
          // Same catch-and-report shape as the MCP adapter (mcp-server.ts):
          // a handler throwing (e.g. mem_save's blank-title admission guard)
          // must not propagate an uncaught rejection out of the tool call.
          return `error: ${(e as Error).message}`
        }
      },
    }
  }

  return {
    tool,

    // Record each user prompt (and lazily ensure the session row exists).
    //
    // No session-type filter, deliberately. The worry was that a sub-agent's
    // delegation text would be stored as if the user had typed it. It is not:
    // OpenCode does not fire this hook on child sessions. Measured against
    // ~/.local/share/opencode over the capture window — 14 sessions with a
    // parent_id, none with a single row in `prompts`, while 25 root sessions
    // captured. The hook's own type also narrows `output.message` to
    // `UserMessage`, so an assistant turn can never arrive here.
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
