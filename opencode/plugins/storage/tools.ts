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

// --- session inactivity nudge (engram #178) ---------------------------------
// Catches "agent forgot to mem_save": if mem_search/mem_context get called a
// lot without a save in between, nudge once. All in-memory — this server
// lives only as long as the session, so nothing here needs to survive a
// restart. `clock` is a seam so tests can simulate elapsed time without real
// sleeps; production always uses Date.now().
let clock: () => number = () => Date.now()
export function __setClock(fn: () => number) { clock = fn }
// Test-only: put the counters back to a fresh-process state so nudge tests
// don't inherit call counts run up by earlier assertions in the same file.
export function __resetNudgeStateForTest() {
  totalCalls = 0; totalSaves = 0; callsAtLastSave = 0; lastNudgeAt = 0; lastSaveAt = clock()
}

// ecomono: these counters are per-server-process, not per-session — handlers
// here don't receive a session id per call, so there is nothing to key on.
// On the MCP stdio path (Claude Code) one process is one session, so that's
// equivalent to per-session. In opencode, concurrent sessions sharing one
// server process share these counters too — an accepted ceiling. Upgrade
// path: thread a session id through the adapters (memory.ts, mcp-server.ts)
// down to instrument()/callsVsSaves() and key a counter map on it.
let totalCalls = 0
let totalSaves = 0
let lastSaveAt = clock()
let callsAtLastSave = 0
let lastNudgeAt = 0

const NUDGE_IDLE_MS = 10 * 60 * 1000
const NUDGE_MIN_CALLS = 10
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000

function maybeNudge(): string | undefined {
  const now = clock()
  const callsSinceSave = totalCalls - callsAtLastSave
  if (callsSinceSave < NUDGE_MIN_CALLS || now - lastSaveAt < NUDGE_IDLE_MS) return undefined
  if (now - lastNudgeAt < NUDGE_COOLDOWN_MS) return undefined
  lastNudgeAt = now
  const minutes = Math.floor((now - lastSaveAt) / 60000)
  return `${callsSinceSave} tool calls and ${minutes}m since last mem_save — save discoveries before they die with the context`
}

// Ratio for mem_session_summary — how much work happened per save this process.
// totalCalls was already incremented (by instrument(), below) for this very
// mem_session_summary call before the handler runs, so it would otherwise
// count the summarizing call against itself. Exclude it.
function callsVsSaves(): string { return `${totalSaves}/${Math.max(totalCalls - 1, 0)}` }

// Wraps every registered handler to track the counters above, uniformly for
// both adapters (opencode plugin, MCP server) and for tests that call
// registryByName[...].handler directly.
function instrument(name: string, handler: (args: any) => unknown): (args: any) => unknown {
  return (args: any) => {
    totalCalls++
    const result = handler(args)
    if (name === "mem_save") {
      totalSaves++
      lastSaveAt = clock()
      callsAtLastSave = totalCalls
    } else if (name === "mem_search" || name === "mem_context") {
      const nudge = maybeNudge()
      if (nudge && result && typeof result === "object" && !Array.isArray(result)) {
        return { ...result, nudge }
      }
    }
    return result
  }
}

const rawRegistry: MemTool[] = [
  {
    name: "mem_save",
    description: "Save an important observation to persistent memory. Call PROACTIVELY after decisions, bug fixes, discoveries, conventions. May return judgment_required + candidates — then call mem_judge per candidate.",
    args: {
      title: z.string().describe("Short, searchable title (verb + what)"),
      content: z.string().optional().describe("Structured body: What / Why / Where / Learned"),
      type: z.enum(["decision", "architecture", "bugfix", "pattern", "config", "discovery", "learning", "manual"]).optional(),
      project: z.string().optional(),
      scope: z.enum(["project", "personal"]).optional(),
      topic_key: z.string().optional().describe("Stable key marking an evolving topic. Does not replace the old version on its own: if judgment_required comes back, resolve every candidate via mem_judge using that candidate's own suggested_relation. The supersedes one retires the old version; skip it and both stay active"),
    },
    handler: (a) => Conflicts.saveWithJudgment({ title: a.title, content: a.content, type: a.type, project: proj(a.project), scope: a.scope, topic_key: a.topic_key }),
  },
  {
    name: "mem_search",
    description: "Full-text search (FTS5) over saved observations, ranked by weighted relevance (title beats body). Always returns { results, match_mode }. match_mode defaults to 'all' (every term required); 'any' matches on any term. When match_mode is left unset and 'all' finds nothing for a multi-term query, automatically retries as 'any' and reports match_mode: \"any (fallback)\".",
    args: {
      query: z.string().describe("Search terms"),
      project: z.string().optional(),
      type: z.string().optional(),
      scope: z.string().optional(),
      limit: z.number().optional(),
      all_projects: z.boolean().optional().describe("Search across every project"),
      match_mode: z.enum(["all", "any"]).optional().describe("For multi-term queries: 'all' (default) ANDs terms, 'any' ORs them. Leave unset to get the zero-result auto-fallback to 'any'"),
    },
    handler: (a) => {
      const base = { query: a.query, project: a.all_projects ? undefined : proj(a.project), type: a.type, scope: a.scope, limit: a.limit, all_projects: a.all_projects }
      const results = Obs.search({ ...base, match_mode: a.match_mode })
      // Only an implicit (unset) match_mode falls back — an explicit 'all' means
      // the caller wants AND semantics even on zero rows. Single-term queries have
      // no AND/OR distinction, so there is nothing to retry differently.
      const termCount = Obs.splitTerms(a.query).length
      if (a.match_mode === undefined && results.length === 0 && termCount > 1) {
        const retried = Obs.search({ ...base, match_mode: "any" })
        if (retried.length > 0) return { results: retried, match_mode: "any (fallback)" }
      }
      // Uniform envelope: bare-array vs wrapped was bimodal before this fix.
      return { results, match_mode: a.match_mode === "any" ? "any" : "all" }
    },
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
      type: z.enum(["decision", "architecture", "bugfix", "pattern", "config", "discovery", "learning", "manual"]).optional(),
      topic_key: z.string().optional(),
      // nullable so a caller can express "clear the review debt" — Zod's plain
      // z.string().optional() can only omit the key or send a string, never
      // null, so the clear path was unreachable from this tool boundary.
      review_after: z.string().nullable().optional().describe("null (or empty string) clears the review debt; a datetime string re-schedules it; omitted on a type change lets the new type's TTL re-stamp"),
    },
    handler: (a) => {
      const { id, ...fields } = a
      // "" is a natural clear attempt too, but stored as-is it sorts before
      // datetime('now') and reads as immediately past-due. Normalize to null
      // (real clear) instead of storing the empty string.
      if (fields.review_after === "") fields.review_after = null
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
    description: "Counts of observations, sessions, and needs_review (past-due review_after) — defaults to the current project, pass project to scope elsewhere.",
    args: { project: z.string().optional() },
    handler: (a) => Obs.stats(proj(a.project)),
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
    // Only "list" ever reads project — proj() spawns two synchronous git
    // subprocesses, wasted work for mark_reviewed which never uses it.
    handler: (a) => Obs.review(a.action, a.id, a.limit, a.action === "list" ? proj(a.project) : a.project),
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
    handler: (a) => {
      Sess.sessionSummary(a.session_id, `${a.content}\n\ncalls_vs_saves: ${callsVsSaves()}`)
      return { ok: true }
    },
  },
  {
    name: "mem_save_prompt",
    description: "Record a user prompt under a session id.",
    args: { session_id: z.string(), content: z.string() },
    handler: (a) => { Prompts.savePrompt(a.session_id, a.content); return { ok: true } },
  },
  {
    name: "mem_doctor",
    description: "Health check: SQLite integrity probe, DB path, and store counts (observations, sessions, needs_review) — always global across all projects, deliberately not scoped to one.",
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

export const registry: MemTool[] = rawRegistry.map((t) => ({ ...t, handler: instrument(t.name, t.handler) }))

export const registryByName: Record<string, MemTool> = Object.fromEntries(registry.map((t) => [t.name, t]))
