import { getDb } from "./db"

export function savePrompt(sessionId: string, content: string) {
  // Admission boundary: content is a prompt row's only payload (unlike an
  // observation, which still has a title), so blank/whitespace-only content
  // is never meaningful. The automatic chat.message capture (memory.ts)
  // already only calls this with trimmed non-empty text; this guards the
  // agent-invokable mem_save_prompt path, which has no such filter.
  if (!content || !content.trim()) throw new Error("prompt content is required")
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
