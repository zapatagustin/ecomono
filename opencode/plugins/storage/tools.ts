/**
 * Shared mem_* tool registry — the single definition of the memory tool surface.
 *
 * Both adapters wrap this: the opencode plugin (memory.ts) and the stdio MCP
 * server for Claude Code (mcp-server.ts). Each entry pairs a Zod arg shape
 * (accepted by both opencode's tool() and the MCP SDK's server.tool()) with a
 * pure handler over the storage layer. Adapters JSON-stringify the return.
 */
import { z } from "zod"
import * as Obs from "./observations"
import * as Sess from "./sessions"
import * as Prompts from "./prompts"
import * as Conflicts from "./conflicts"
import { dbPath, getDb } from "./db"

export interface MemTool {
  name: string
  description: string
  args: z.ZodRawShape
  handler: (args: any) => unknown
}

// Resolve an explicit project or fall back to the cwd's git project.
const proj = (p?: string) => p || Obs.currentProject().project

export const registry: MemTool[] = [
  {
    name: "mem_save",
    description: "Save an important observation to persistent memory. Call PROACTIVELY after decisions, bug fixes, discoveries, conventions. May return judgment_required + candidates — then call mem_judge per candidate.",
    args: {
      title: z.string().describe("Short, searchable title (verb + what)"),
      content: z.string().optional().describe("Structured body: What / Why / Where / Learned"),
      type: z.enum(["decision", "architecture", "bugfix", "pattern", "config", "discovery", "learning", "manual"]).optional(),
      project: z.string().optional(),
      scope: z.enum(["project", "personal"]).optional(),
      topic_key: z.string().optional().describe("Stable key to upsert an evolving topic"),
    },
    handler: (a) => Conflicts.saveWithJudgment({ title: a.title, content: a.content, type: a.type, project: proj(a.project), scope: a.scope, topic_key: a.topic_key }),
  },
  {
    name: "mem_search",
    description: "Full-text search (FTS5) over saved observations.",
    args: {
      query: z.string().describe("Search terms"),
      project: z.string().optional(),
      type: z.string().optional(),
      scope: z.string().optional(),
      limit: z.number().optional(),
      all_projects: z.boolean().optional().describe("Search across every project"),
      match_mode: z.enum(["all", "any"]).optional().describe("AND (default) vs OR term matching"),
    },
    handler: (a) => Obs.search({ query: a.query, project: a.all_projects ? undefined : proj(a.project), type: a.type, scope: a.scope, limit: a.limit, all_projects: a.all_projects, match_mode: a.match_mode }),
  },
  {
    name: "mem_get_observation",
    description: "Fetch the full untruncated content of one observation by id.",
    args: { id: z.number() },
    handler: (a) => Obs.getObservation(a.id),
  },
  {
    name: "mem_update",
    description: "Update fields of an existing observation by id.",
    args: {
      id: z.number(),
      title: z.string().optional(),
      content: z.string().optional(),
      type: z.string().optional(),
      topic_key: z.string().optional(),
      review_after: z.string().optional(),
    },
    handler: (a) => {
      const { id, ...fields } = a
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      return { updated: Obs.update(id, clean) }
    },
  },
  {
    name: "mem_delete",
    description: "Delete an observation by id.",
    args: { id: z.number() },
    handler: (a) => ({ deleted: Obs.del(a.id) }),
  },
  {
    name: "mem_suggest_topic_key",
    description: "Suggest a stable slug topic_key from a title.",
    args: { title: z.string() },
    handler: (a) => ({ topic_key: Obs.suggestTopicKey(a.title) }),
  },
  {
    name: "mem_stats",
    description: "Counts of observations and sessions (optionally scoped to a project).",
    args: { project: z.string().optional() },
    handler: (a) => Obs.stats(a.project),
  },
  {
    name: "mem_context",
    description: "Recent observations for a project as a formatted context block.",
    args: { project: z.string().optional(), limit: z.number().optional() },
    handler: (a) => Sess.context(proj(a.project), a.limit),
  },
  {
    name: "mem_timeline",
    description: "Chronological list of recent observations (id, title, type, date).",
    args: { project: z.string().optional(), limit: z.number().optional() },
    handler: (a) => ({ observations: Obs.timeline(a.project ? proj(a.project) : undefined, a.limit) }),
  },
  {
    name: "mem_pin",
    description: "Pin an observation so it stays surfaced.",
    args: { id: z.number() },
    handler: (a) => ({ pinned: Obs.pin(a.id) }),
  },
  {
    name: "mem_unpin",
    description: "Unpin an observation.",
    args: { id: z.number() },
    handler: (a) => ({ unpinned: Obs.unpin(a.id) }),
  },
  {
    name: "mem_review",
    description: "List observations due for review, or mark one reviewed.",
    args: {
      action: z.enum(["list", "mark_reviewed"]),
      id: z.number().optional(),
      limit: z.number().optional(),
      project: z.string().optional(),
    },
    handler: (a) => Obs.review(a.action, a.id, a.limit, a.project),
  },
  {
    name: "mem_current_project",
    description: "Detect the current project name and path from the working directory.",
    args: { cwd: z.string().optional() },
    handler: (a) => Obs.currentProject(a.cwd),
  },
  {
    name: "mem_session_summary",
    description: "Store an end-of-session summary for a session id.",
    args: { session_id: z.string(), content: z.string() },
    handler: (a) => { Sess.sessionSummary(a.session_id, a.content); return { ok: true } },
  },
  {
    name: "mem_save_prompt",
    description: "Record a user prompt under a session id.",
    args: { session_id: z.string(), content: z.string() },
    handler: (a) => { Prompts.savePrompt(a.session_id, a.content); return { ok: true } },
  },
  {
    name: "mem_doctor",
    description: "Health check: SQLite integrity probe, DB path, and store counts.",
    args: {},
    // A real probe, not a hardcoded ok. quick_check catches corruption, and the
    // catch turns an unreadable file or full disk into a reportable answer
    // rather than a tool-call error the agent can only guess at.
    handler: () => {
      try {
        const row = getDb().query("PRAGMA quick_check").get() as { quick_check?: string } | null
        const integrity = row?.quick_check ?? "unknown"
        return { ok: integrity === "ok", integrity, db_path: dbPath(), ...Obs.stats() }
      } catch (e) {
        return { ok: false, integrity: "unreadable", error: (e as Error).message, db_path: dbPath() }
      }
    },
  },
  {
    name: "mem_judge",
    description: "Resolve a save-time conflict candidate: record the relation between the new observation and the candidate. 'supersedes' also retires the candidate.",
    args: {
      judgment_id: z.string().describe("From a mem_save candidates[] entry"),
      relation: z.enum(["supersedes", "conflicts_with", "related", "compatible", "scoped", "not_conflict"]),
      note: z.string().optional(),
    },
    handler: (a) => Conflicts.judge(a.judgment_id, a.relation, a.note),
  },
  {
    name: "mem_compare",
    description: "Compare two observations: term-overlap similarity, shared terms, and any recorded relations.",
    args: { id_a: z.number(), id_b: z.number() },
    handler: (a) => Conflicts.compare(a.id_a, a.id_b),
  },
  {
    name: "mem_merge_projects",
    description: "Reassign all observations and sessions from one project into another.",
    args: { from: z.string(), into: z.string() },
    handler: (a) => Conflicts.mergeProjects(a.from, a.into),
  },
]

export const registryByName: Record<string, MemTool> = Object.fromEntries(registry.map((t) => [t.name, t]))
