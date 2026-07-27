/**
 * Storage — SQLite database initialization and migration
 *
 * Replaces the engram Go binary with direct bun:sqlite access.
 * Data dir: ~/.ecomono/memory.db  (override with ECOMONO_DATA_DIR).
 */

import { Database } from "bun:sqlite"
import { existsSync, copyFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DATA_DIR = process.env.ECOMONO_DATA_DIR || join(homedir(), ".ecomono")
const DB_PATH = join(DATA_DIR, "memory.db")
// The Go engram stores its DB at ~/.engram/engram.db. Overridable for tests.
const ENGRAM_DB = process.env.ECOMONO_LEGACY_DB || join(homedir(), ".engram", "engram.db")

let db: Database | null = null

export function getDb(): Database {
  if (db) return db
  mkdirSync(DATA_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA foreign_keys=ON")
  initSchema(db)
  migrateFromEngram(db)
  return db
}

function initSchema(d: Database) {
  d.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'manual',
      scope TEXT NOT NULL DEFAULT 'project',
      content TEXT NOT NULL,
      topic_key TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      review_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  d.run("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id)")
  d.run("CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(project_id, topic_key)")
  d.run("CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(project_id, created_at DESC)")
  d.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts
    USING fts5(title, content, content=observations, content_rowid=id)
  `)
  d.run(`
    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END
  `)
  d.run(`
    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content)
      VALUES('delete', old.id, old.title, old.content);
    END
  `)
  d.run(`
    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content)
      VALUES('delete', old.id, old.title, old.content);
      INSERT INTO observations_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      summary TEXT
    )
  `)
  d.run("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, started_at DESC)")
  d.run(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  d.run("CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, created_at DESC)")

  // Conflict-resolution support (parity with engram's judgment flow).
  addColumn(d, "observations", "normalized_hash", "TEXT")
  addColumn(d, "observations", "superseded_by", "INTEGER")
  d.run("CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(project_id, normalized_hash)")
  d.run(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_id, to_id, relation)
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS judgments (
      id TEXT PRIMARY KEY,
      new_id INTEGER NOT NULL,
      candidate_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      suggested_relation TEXT,
      confidence REAL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

// Add a column only if it isn't already present (idempotent migration for DBs
// created before conflict-resolution support existed).
function addColumn(d: Database, table: string, col: string, type: string) {
  const cols = (d.query(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name)
  if (!cols.includes(col)) d.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
}

// One-time import from a legacy Go-engram DB. Engram denormalizes (a `project`
// TEXT column, no projects table; prompts live in `user_prompts`), so this maps
// its schema onto ours rather than copying columns blindly. Idempotent via
// INSERT OR IGNORE on primary keys; best-effort — a failure never blocks init,
// because a broken migration must not cost us the whole memory store.
// ecomono: engram-schema-specific (v1.x). If engram changes its schema a future
// version needs a matching branch; falls through harmlessly (rows skipped).
function migrateFromEngram(d: Database) {
  if (!existsSync(ENGRAM_DB)) return
  // Only engram DBs have this shape; bail quietly on anything else.
  try {
    d.run("ATTACH DATABASE ? AS old", [ENGRAM_DB])
    const hasEngramSchema = (d.query(
      "SELECT COUNT(*) c FROM old.sqlite_master WHERE type='table' AND name IN ('observations','sessions','user_prompts')"
    ).get() as any).c === 3
    if (!hasEngramSchema) { d.run("DETACH DATABASE old"); return }

    const backup = ENGRAM_DB + ".pre-ecomono.bak"
    if (!existsSync(backup)) copyFileSync(ENGRAM_DB, backup)

    const step = (label: string, sql: string) => {
      try { d.run(sql) } catch (e) { console.error(`engram migration: skipped ${label} (${(e as Error).message})`) }
    }
    // projects: derived from the denormalized `project` column everywhere.
    step("projects/obs", "INSERT OR IGNORE INTO projects (id, name) SELECT DISTINCT project, project FROM old.observations WHERE project IS NOT NULL")
    step("projects/sess", "INSERT OR IGNORE INTO projects (id, name) SELECT DISTINCT project, project FROM old.sessions WHERE project IS NOT NULL")
    // sessions: project -> project_id.
    step("sessions", "INSERT OR IGNORE INTO sessions (id, project_id, started_at, ended_at, summary) SELECT id, project, started_at, ended_at, summary FROM old.sessions WHERE project IS NOT NULL")
    // observations: non-deleted only; project -> project_id, defaults filled.
    step("observations", `INSERT OR IGNORE INTO observations (id, project_id, title, type, scope, content, topic_key, pinned, review_after, created_at, updated_at)
      SELECT id, project, title, COALESCE(type,'manual'), COALESCE(scope,'project'), content, topic_key, COALESCE(pinned,0), review_after, created_at, updated_at
      FROM old.observations WHERE deleted_at IS NULL AND project IS NOT NULL AND content IS NOT NULL`)
    // prompts: from user_prompts, only those whose session survived.
    step("prompts", "INSERT OR IGNORE INTO prompts (id, session_id, content, created_at) SELECT id, session_id, content, created_at FROM old.user_prompts WHERE session_id IN (SELECT id FROM sessions)")

    d.run("DETACH DATABASE old")
  } catch (e) {
    console.error(`engram migration: aborted (${(e as Error).message})`)
    try { d.run("DETACH DATABASE old") } catch {}
  }
}

export function dbPath(): string { return DB_PATH }

export function closeDb() {
  if (db) { db.close(); db = null }
}
