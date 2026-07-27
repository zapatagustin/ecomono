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

export function sessionSummary(sessionId: string, content: string) {
  const db = getDb()
  db.run("UPDATE sessions SET summary = ? WHERE id = ?", [content, sessionId])
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

export function context(project: string, limit?: number): { context: string } {
  const db = getDb()
  const lim = limit || 10
  const rows = db.query(
    "SELECT title, content, type, created_at FROM observations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(project, lim) as any[]

  if (!rows.length) return { context: "" }

  const parts = rows.map((r: any) =>
    `## ${r.title} (${r.type}, ${r.created_at})\n${r.content}`
  )
  return { context: parts.join("\n\n") }
}
