import { getDb } from "./db"

export function savePrompt(sessionId: string, content: string) {
  const db = getDb()
  db.run("INSERT INTO prompts (session_id, content) VALUES (?, ?)", [sessionId, content])
}

export function getPrompts(sessionId: string, limit?: number): any[] {
  const db = getDb()
  const lim = limit || 20
  return db.query(
    "SELECT * FROM prompts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(sessionId, lim)
}
