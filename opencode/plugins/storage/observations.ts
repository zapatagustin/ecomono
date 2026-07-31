import { getDb } from "./db"
import { createHash } from "crypto"

// Stable hash of normalized title+content — used to detect exact duplicates.
export function normalizedHash(title: string, content: string): string {
  const norm = `${title}\n${content}`.toLowerCase().replace(/\s+/g, " ").trim()
  return createHash("sha256").update(norm).digest("hex")
}

interface Observation {
  id?: number
  project_id: string
  title: string
  type: string
  scope: string
  content: string
  topic_key?: string
  state?: string
  pinned?: number
  review_after?: string
  created_at?: string
  updated_at?: string
}

export function save(opts: {
  title: string
  type?: string
  content?: string
  project?: string
  scope?: string
  topic_key?: string
}): { id: number; sync_id: string } | null {
  const db = getDb()
  const project = opts.project || detectProject()
  const title = opts.title
  const type = opts.type || "manual"
  const scope = opts.scope || "project"
  const content = opts.content || ""

  db.run("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)", [project, project])
  const hash = normalizedHash(title, content)
  const result = db.run(
    "INSERT INTO observations (project_id, title, type, scope, content, topic_key, normalized_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [project, title, type, scope, content, opts.topic_key || null, hash]
  )
  return { id: Number(result.lastInsertRowid), sync_id: "obs-" + result.lastInsertRowid }
}

export function search(opts: {
  query: string
  project?: string
  type?: string
  scope?: string
  limit?: number
  all_projects?: boolean
  match_mode?: string
}): { id: number; title: string; content: string; type: string; created_at: string; project: string }[] {
  const db = getDb()
  const limit = opts.limit || 10
  const mode = opts.match_mode === "any" ? "OR" : "AND"
  const terms = opts.query.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`).join(` ${mode} `)
  if (!terms) return []

  let sql = "SELECT o.id, o.title, o.content, o.type, o.created_at, o.project_id as project FROM observations o INNER JOIN observations_fts fts ON o.id = fts.rowid WHERE observations_fts MATCH ? AND o.state = 'active'"
  const params: any[] = [terms]

  if (opts.project && !opts.all_projects) {
    sql += " AND o.project_id = ?"
    params.push(opts.project)
  }
  if (opts.type) {
    sql += " AND o.type = ?"
    params.push(opts.type)
  }
  if (opts.scope) {
    sql += " AND o.scope = ?"
    params.push(opts.scope)
  }
  sql += " ORDER BY o.created_at DESC LIMIT ?"
  params.push(limit)

  return db.query(sql).all(...params) as any[]
}

export function getObservation(id: number): Observation | null {
  const db = getDb()
  const row = db.query("SELECT * FROM observations WHERE id = ?").get(id) as any
  return row || null
}

// Columns update() may write. Identity (id, project_id) and automatic
// timestamps (created_at, updated_at) are excluded on purpose; pinned has its
// own pin()/unpin() functions. Defense in depth: today the only caller is
// mem_update's Zod-shaped args, which already strip unknown keys.
const UPDATABLE_COLUMNS = new Set(["title", "type", "scope", "content", "topic_key", "state", "review_after"])

export function update(id: number, fields: Partial<Observation>): boolean {
  const db = getDb()
  const sets: string[] = []
  const params: any[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (!UPDATABLE_COLUMNS.has(k)) continue
    sets.push(`${k} = ?`)
    params.push(v)
  }
  if (!sets.length) return false
  sets.push("updated_at = datetime('now')")
  params.push(id)
  db.run(`UPDATE observations SET ${sets.join(", ")} WHERE id = ?`, params)
  return true
}

export function del(id: number): boolean {
  const db = getDb()
  db.run("DELETE FROM observations WHERE id = ?", [id])
  return true
}

export function timeline(project?: string, limit?: number): { id: number; title: string; type: string; created_at: string }[] {
  const db = getDb()
  const lim = limit || 20
  if (project) {
    return db.query("SELECT id, title, type, created_at FROM observations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(project, lim) as any[]
  }
  return db.query("SELECT id, title, type, created_at FROM observations ORDER BY created_at DESC LIMIT ?").all(lim) as any[]
}

export function suggestTopicKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled"
}

export function stats(project?: string): { observations: number; sessions: number } {
  const db = getDb()
  const obs = project
    ? (db.query("SELECT COUNT(*) as c FROM observations WHERE project_id = ?").get(project) as any).c
    : (db.query("SELECT COUNT(*) as c FROM observations").get() as any).c
  const sess = project
    ? (db.query("SELECT COUNT(*) as c FROM sessions WHERE project_id = ?").get(project) as any).c
    : (db.query("SELECT COUNT(*) as c FROM sessions").get() as any).c
  return { observations: obs, sessions: sess }
}

export function pin(id: number): boolean {
  const db = getDb()
  db.run("UPDATE observations SET pinned = 1 WHERE id = ?", [id])
  return true
}

export function unpin(id: number): boolean {
  const db = getDb()
  db.run("UPDATE observations SET pinned = 0 WHERE id = ?", [id])
  return true
}

export function review(action: string, id?: number, limit?: number, project?: string): any {
  const db = getDb()
  if (action === "list") {
    const lim = limit || 10
    if (project) {
      return db.query("SELECT * FROM observations WHERE project_id = ? AND review_after IS NOT NULL AND review_after <= datetime('now') ORDER BY review_after ASC LIMIT ?").all(project, lim)
    }
    return db.query("SELECT * FROM observations WHERE review_after IS NOT NULL AND review_after <= datetime('now') ORDER BY review_after ASC LIMIT ?").all(lim)
  }
  if (action === "mark_reviewed" && id) {
    db.run("UPDATE observations SET review_after = NULL WHERE id = ?", [id])
    return { success: true }
  }
  return []
}

// Remote-first project name: prefer the origin remote's repo name (stable across
// renamed clones/forks), fall back to the git toplevel dirname, then the raw cwd
// basename. This is the single derivation shared by both memory hosts — the
// opencode plugin (memory.ts) calls currentProject() directly instead of
// recomputing it, so a repo saved from either host resolves to the same project key.
function gitRemoteName(cwd: string): string | null {
  try {
    const result = require("child_process").execSync("git remote get-url origin", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const name = result.toString().trim().replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop()
    return name || null
  } catch {
    return null
  }
}

// Both hosts now derive the project key from the git remote. They did not always: the
// Claude side keyed on the checkout's basename, so in any repo whose directory name
// differs from its remote's, everything saved before that change sits under the old key
// and goes invisible the moment this starts returning the new one — no error, just an
// empty search. `projects.id` is the name itself, so there is nothing to repoint but the
// rows. Rename once, and only when it is unambiguous: the new key holds nothing, the old
// key holds something. Anything else is a judgement call the store should not make alone.
const reconciled = new Set<string>()
function reconcileLegacyProjectKey(current: string, legacy: string) {
  if (current === legacy || reconciled.has(current)) return
  reconciled.add(current)
  try {
    const d = getDb()
    const exists = (id: string) => !!d.query("SELECT 1 FROM projects WHERE id=?").get(id)
    if (!exists(legacy) || exists(current)) return
    const moved = (d.query("SELECT COUNT(*) AS n FROM observations WHERE project_id=?").get(legacy) as any)?.n ?? 0
    d.transaction(() => {
      d.run("INSERT INTO projects (id, name) VALUES (?, ?)", [current, current])
      d.run("UPDATE observations SET project_id=? WHERE project_id=?", [current, legacy])
      d.run("UPDATE sessions SET project_id=? WHERE project_id=?", [current, legacy])
      d.run("UPDATE judgments SET project_id=? WHERE project_id=?", [current, legacy])
      d.run("DELETE FROM projects WHERE id=?", [legacy])
    })()
    console.error(`[ecomono-memory] project key "${legacy}" -> "${current}" (git remote); ${moved} observations moved`)
  } catch (e) {
    // A store that cannot be opened is already reported elsewhere; never let the
    // reconciliation itself be the thing that breaks a save.
    console.error(`[ecomono-memory] project key reconciliation skipped: ${(e as Error).message}`)
  }
}

export function currentProject(cwd?: string): { project: string; path: string } {
  const dir = cwd || process.cwd()
  const remoteName = gitRemoteName(dir)
  try {
    const result = require("child_process").execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const root = result.toString().trim()
    const basename = root.split("/").pop() || "unknown"
    if (remoteName) reconcileLegacyProjectKey(remoteName, basename)
    return { project: remoteName || basename, path: root }
  } catch {
    const basename = dir.split("/").pop() || "unknown"
    if (remoteName) reconcileLegacyProjectKey(remoteName, basename)
    return { project: remoteName || basename, path: dir }
  }
}

function detectProject(): string {
  return currentProject().project
}
