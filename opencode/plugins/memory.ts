/**
 * ecomono-memory — OpenCode plugin adapter (v2 plugin API)
 *
 * Native bun:sqlite persistent memory (no external Go binary). This file is the
 * OpenCode adapter: it wraps the shared mem_* tool registry (storage/tools.ts)
 * in OpenCode's plugin API, injects the memory protocol into the system prompt,
 * and captures user prompts. The same registry backs the Claude Code MCP server
 * (mcp-server.ts), so both hosts share one storage + one tool surface.
 *
 * v2 runs one instance per opened location, each with its own setup(), inside
 * the long-lived opencode service. Module state is not per location: loaded
 * through a symlink (the deployed layout), this file and storage/ are evaluated
 * once per service, so every location shares db.ts's one handle. process.cwd()
 * there is the service's $HOME, and process.env (ECOMONO_DATA_DIR,
 * ECOMONO_LEGACY_DB) is frozen when the service spawns: a per-run override needs
 * `opencode --standalone`, otherwise `opencode service restart` from a login shell.
 */

import { z } from "zod"
import { getDb, closeDb } from "./storage/db"
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

// The host converts zod with ITS OWN zod copy, whose metadata registry lacks this
// copy's .describe() entries, so every argument description would be silently
// dropped. Hand it a StandardJSONSchemaV1 instead: the host tries
// `~standard.jsonSchema` first (core/src/tool/runtime.ts standardJsonSchema), and
// this copy's converter keeps the descriptions. Validation stays zod's own validate.
function toInput(shape: Record<string, any>) {
  const s = z.object(shape)
  const conv = (io: "input" | "output") => (o: { target: any }) => z.toJSONSchema(s, { target: o.target, io })
  return { "~standard": { ...s["~standard"], jsonSchema: { input: conv("input"), output: conv("output") } } }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

// Setups alive on this module evaluation, all sharing db.ts's handle. The host
// re-evaluates a plugin per location only when its entrypoint is a real path:
// it deletes require.cache[<entrypoint path>] (plugin/src/source.bun.ts), but
// Bun keys modules by realpath, so a symlinked entrypoint
// (~/.config/opencode/plugins/memory.ts -> nix store) keeps one evaluation for
// every location in the service.
let instances = 0

export default {
  id: "ecomono-memory",
  async setup(ctx: any) {
    const dir: string = ctx.location.directory
    const project = Obs.currentProject(dir).project // swallows its own errors

    // Memory must never take down the editing session. A store we cannot open
    // (corrupt file, full disk, bad permissions) degrades to mem_doctor and
    // nothing else: no protocol injection, since telling the agent to call
    // mem_save when saving is impossible is worse than staying quiet — but the
    // one tool whose job is to report that memory is down has to survive the
    // failure it reports on, or the only trace is a stderr line nobody sees.
    let healthy = true
    try {
      getDb() // initialize schema + run one-time legacy migration
    } catch (e) {
      console.error("[ecomono-memory] storage unavailable, memory disabled:", (e as Error).message)
      healthy = false
    }
    // mem_doctor's own handler catches the same failure and answers ok:false.
    const tools = healthy ? registry : registry.filter((t) => t.name === "mem_doctor")

    // codemode: false keeps them direct tools; otherwise v2 lists them only
    // inside the Code Mode `execute` tool's catalog.
    await ctx.tool.transform((editor: any) => {
      for (const t of tools) {
        const takesProject = "project" in t.args
        editor.add({
          name: t.name,
          description: t.description,
          input: toInput(t.args),
          options: { codemode: false },
          execute: async (args: any) => {
            // Default to the location's project. Falsy, not == null: tools.ts
            // treats "" as missing too, and its fallback is process.cwd() — the
            // service's $HOME, not the repo.
            if (takesProject && !args.project) args.project = project
            if (t.name === "mem_update" || t.name === "mem_delete") args.expected_project ||= project
            if (t.name === "mem_current_project") args.cwd ||= dir
            try {
              const result = await t.handler(args)
              return { content: typeof result === "string" ? result : JSON.stringify(result) }
            } catch (e) {
              // Same catch-and-report shape as the MCP adapter (mcp-server.ts):
              // a handler throwing (e.g. mem_save's blank-title admission guard)
              // answers with the message instead of failing the tool call.
              return { content: `error: ${(e as Error).message}` }
            }
          },
        })
      }
    })

    if (healthy) {
      // Record each user prompt (and lazily ensure the session row exists).
      //
      // Child sessions are skipped. v1's chat.message never fired on them; v2's
      // prompt hook does, because the subagent tool submits its delegation text
      // through session.prompt — stored here, it would read as if the user had
      // typed it. The hook runs at admission, so a prompt that admission then
      // rejects still leaves its row.
      await ctx.session.hook("prompt", async (ev: any) => {
        try {
          const session = await ctx.session.get({ sessionID: ev.sessionID })
          if (session?.parentID) return
          Sess.ensureSession(ev.sessionID, project)
          const text = (ev.prompt?.text ?? "").trim()
          if (text) Prompts.savePrompt(ev.sessionID, text)
        } catch (e) {
          console.error("[ecomono-memory] prompt capture failed:", (e as Error).message)
        }
      })

      // Teach the agent the memory protocol, on every primary request — the
      // first one after a compaction included, which is why there is no
      // compaction hook: v2 has no slot to append to the summarizer's prompt.
      // Only where mem_save is offered: an agent or session that denies the mem
      // tools gets no instructions to call them.
      await ctx.session.hook("context", (ev: any) => {
        try {
          if (ev.tools && "mem_save" in ev.tools) ev.system.push({ type: "text", text: MEMORY_INSTRUCTIONS })
        } catch {} // a throw here fails the model request
      })
    }

    // Release the handle on unload (reload, location eviction), but only with
    // the last location using it: closing it under the others would fail their
    // in-flight statements. Degraded instances count too: mem_doctor may have
    // opened one since.
    // ecomono: a mem_* call still in flight at the last unload reopens a handle
    // nothing closes until another location comes and goes. Ceiling: one leaked
    // handle per such race. Upgrade path: count in-flight calls and close after
    // the last one settles.
    instances++
    return () => {
      if (--instances === 0) closeDb()
    }
  },
}
