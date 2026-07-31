/**
 * Conflict resolution — parity with engram's judgment flow.
 *
 * On save we look for observations the new one might duplicate, contradict, or
 * extend, and return a `judgment_required` envelope with candidates. The agent
 * then calls mem_judge per candidate to record the relation (and supersede the
 * old one when the new replaces it). Without embeddings we approximate semantic
 * similarity with three signals: exact normalized-hash match, same topic_key,
 * and bm25-ranked FTS overlap.
 * ecomono: lexical only. bm25 buys precision for free — its IDF term makes a
 * match on rare vocabulary outrank one on words the whole corpus shares — but
 * no lexical signal catches a paraphrase that reuses none of the words. Upgrade
 * path is an embedding column + cosine ranking, and only if recall proves short:
 * that is a local model as a new dependency for a store of a few hundred rows.
 */
import { getDb } from "./db"
import * as Obs from "./observations"

// A bm25 score at or above this carries less than roughly one discriminating
// term's worth of weight — the row matched, but only on vocabulary the corpus
// shares. Treating that as a candidate is the false positive an unranked OR
// produced; the floor is what removes it.
const FTS_MIN_SCORE = -1

export type Relation = "supersedes" | "conflicts_with" | "related" | "compatible" | "scoped" | "not_conflict"
const RELATIONS: Relation[] = ["supersedes", "conflicts_with", "related", "compatible", "scoped", "not_conflict"]

export interface Candidate {
  observation_id: number
  judgment_id: string
  title: string
  suggested_relation: Relation
  confidence: number
}

export interface SaveResult {
  id: number
  sync_id: string
  judgment_required: boolean
  candidates: Candidate[]
}

function findCandidates(newId: number, project: string, title: string, content: string, topicKey: string | undefined, hash: string): Omit<Candidate, "judgment_id">[] {
  const db = getDb()
  const best = new Map<number, Omit<Candidate, "judgment_id">>()
  const consider = (id: number, t: string, relation: Relation, confidence: number) => {
    if (id === newId) return
    const prev = best.get(id)
    if (!prev || confidence > prev.confidence) best.set(id, { observation_id: id, title: t, suggested_relation: relation, confidence })
  }

  // 1. exact duplicate (same normalized content)
  for (const r of db.query("SELECT id, title FROM observations WHERE project_id=? AND normalized_hash=? AND state='active' AND id!=?").all(project, hash, newId) as any[]) {
    consider(r.id, r.title, "supersedes", 0.98)
  }
  // 2. same evolving topic
  if (topicKey) {
    for (const r of db.query("SELECT id, title FROM observations WHERE project_id=? AND topic_key=? AND state='active' AND id!=?").all(project, topicKey, newId) as any[]) {
      consider(r.id, r.title, "supersedes", 0.85)
    }
  }
  // 3. FTS overlap on title + content terms, ranked by bm25.
  //
  // The match stays an OR: an AND across a dozen terms would only ever hit a
  // near-verbatim copy, which signal 1 already covers. bm25 is what makes the
  // OR usable — it scores by inverse document frequency, so a row matching only
  // words the whole store shares ("project", "files", "should") lands near 0
  // while a row matching rare vocabulary lands far below it. Ordering by that
  // score picks the five strongest rows instead of five arbitrary ones, and the
  // floor drops rows whose only overlap was common vocabulary. Scores are
  // negative, more negative meaning a better match.
  const words = [...new Set(`${title} ${content}`.toLowerCase().split(/\s+/).filter((w) => w.length > 3))]
  const terms = words.slice(0, 12).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
  if (terms) {
    try {
      const rows = db.query(
        "SELECT o.id, o.title, bm25(observations_fts) AS score FROM observations o JOIN observations_fts ON o.id=observations_fts.rowid" +
        " WHERE observations_fts MATCH ? AND o.project_id=? AND o.state='active' AND o.id!=? ORDER BY score LIMIT 5"
      ).all(terms, project, newId) as any[]
      for (const r of rows) {
        if (r.score > FTS_MIN_SCORE) continue
        consider(r.id, r.title, "related", 0.5)
      }
    } catch { /* malformed FTS query — ignore */ }
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence)
}

export function saveWithJudgment(opts: Parameters<typeof Obs.save>[0]): SaveResult | null {
  const base = Obs.save(opts)
  if (!base) return null
  const db = getDb()
  const project = opts.project || Obs.currentProject().project
  const hash = Obs.normalizedHash(opts.title, opts.content || "")
  const raw = findCandidates(base.id, project, opts.title, opts.content || "", opts.topic_key, hash)

  const candidates: Candidate[] = raw.map((c) => {
    const judgment_id = `jud-${base.id}-${c.observation_id}`
    db.run(
      "INSERT OR REPLACE INTO judgments (id, new_id, candidate_id, project_id, suggested_relation, confidence) VALUES (?, ?, ?, ?, ?, ?)",
      [judgment_id, base.id, c.observation_id, project, c.suggested_relation, c.confidence]
    )
    return { ...c, judgment_id }
  })
  return { ...base, judgment_required: candidates.length > 0, candidates }
}

export function judge(judgmentId: string, relation: Relation, note?: string): { resolved: boolean; relation?: Relation; error?: string } {
  if (!RELATIONS.includes(relation)) return { resolved: false, error: `unknown relation '${relation}'` }
  const db = getDb()
  const j = db.query("SELECT * FROM judgments WHERE id=?").get(judgmentId) as any
  if (!j) return { resolved: false, error: "judgment not found" }
  if (j.resolved) return { resolved: true, relation }

  if (relation === "supersedes") {
    // the new observation replaces the candidate
    db.run("UPDATE observations SET state='superseded', superseded_by=? WHERE id=?", [j.new_id, j.candidate_id])
    recordRelation(j.new_id, j.candidate_id, "supersedes", note)
  } else if (relation !== "not_conflict") {
    recordRelation(j.new_id, j.candidate_id, relation, note)
  }
  db.run("UPDATE judgments SET resolved=1 WHERE id=?", [judgmentId])
  return { resolved: true, relation }
}

function recordRelation(fromId: number, toId: number, relation: Relation, note?: string) {
  getDb().run("INSERT OR IGNORE INTO memory_relations (from_id, to_id, relation, note) VALUES (?, ?, ?, ?)", [fromId, toId, relation, note || null])
}

export function relationsOf(id: number): any[] {
  return getDb().query("SELECT from_id, to_id, relation, note, created_at FROM memory_relations WHERE from_id=? OR to_id=? ORDER BY created_at DESC").all(id, id) as any[]
}

export function compare(idA: number, idB: number): any {
  const a = Obs.getObservation(idA)
  const b = Obs.getObservation(idB)
  if (!a || !b) return { error: "one or both observations not found" }
  const words = (s: string) => new Set(`${s}`.toLowerCase().split(/\s+/).filter((w) => w.length > 3))
  const wa = words(a.title + " " + a.content)
  const wb = words(b.title + " " + b.content)
  const shared = [...wa].filter((w) => wb.has(w))
  const union = new Set([...wa, ...wb])
  const similarity = union.size ? shared.length / union.size : 0
  return {
    a: { id: a.id, title: a.title, type: a.type, content: a.content },
    b: { id: b.id, title: b.title, type: b.type, content: b.content },
    similarity: Number(similarity.toFixed(3)),
    shared_terms: shared.slice(0, 20),
    relations: getDb().query("SELECT from_id, to_id, relation FROM memory_relations WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)").all(idA, idB, idB, idA),
  }
}

export function mergeProjects(from: string, into: string): { moved_observations: number; moved_sessions: number } {
  const db = getDb()
  db.run("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)", [into, into])
  const obs = db.run("UPDATE observations SET project_id=? WHERE project_id=?", [into, from])
  const sess = db.run("UPDATE sessions SET project_id=? WHERE project_id=?", [into, from])
  db.run("DELETE FROM projects WHERE id=? AND NOT EXISTS (SELECT 1 FROM observations WHERE project_id=?) AND NOT EXISTS (SELECT 1 FROM sessions WHERE project_id=?)", [from, from, from])
  return { moved_observations: Number(obs.changes), moved_sessions: Number(sess.changes) }
}
