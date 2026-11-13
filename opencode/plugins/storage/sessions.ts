import { getDb } from "./db"

export function sessionStart(id: string, project: string) {
  const db = getDb()
  db.run("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)", [project, project])
  db.run("INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)", [id, project])
}

export function sessionEnd(id: string, summary?: string) {
  const db = getDb()
  db.run("UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?", [summary || null, id])
}

export function ensureSession(id: string, project?: string) {
  const db = getDb()
  const existing = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any
  if (!existing && project) {
    db.run("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)", [project, project])
    db.run("INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)", [id, project])
  }
}

export function getSession(id: string): any {
  const db = getDb()
  return db.query("SELECT * FROM sessions WHERE id = ?").get(id)
}

const CTX_BODY_CHARS = 300

export function context(project: string, limit?: number): { context: string } {
  const db = getDb()
  const lim = limit || 10
  // Active rows only; pinned first, then newest.
  const rows = db.query(
    "SELECT id, title, content, type, created_at FROM observations WHERE project_id = ? AND state = 'active' ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?"
  ).all(project, lim) as any[]
  // The newest summary is fetched outside the LIMIT: n or more pinned rows must
  // not push the handoff out. It takes the last slot, so the block stays <= lim.
  const summary = db.query(
    "SELECT id, title, content, type, created_at FROM observations WHERE project_id = ? AND state = 'active' AND type = 'session_summary' ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(project) as any
  if (summary && !rows.some((r) => r.id === summary.id)) {
    if (rows.length >= lim) rows.pop()
    rows.push(summary)
  }

  if (!rows.length) return { context: "" }

  // ecomono: the newest session_summary stays whole — the next session's handoff
  // depends on it. Ceiling: one long summary can dominate the block. Upgrade
  // path: cap it at a larger limit.
  const newestSummary = summary ? summary.id : -1
  const parts = rows.map((r: any) => {
    const cps = [...String(r.content)]
    const body = r.id === newestSummary || cps.length <= CTX_BODY_CHARS
      ? r.content
      : `${cps.slice(0, CTX_BODY_CHARS).join("")}… [truncated, full text: mem_get_observation id=${r.id}]`
    return `## #${r.id} ${r.title} (${r.type}, ${r.created_at})\n${body}`
  })
  return { context: parts.join("\n\n") }
}
