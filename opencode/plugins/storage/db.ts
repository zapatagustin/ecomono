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
  const d = new Database(DB_PATH)
  d.run("PRAGMA journal_mode=WAL")
  d.run("PRAGMA busy_timeout = 5000")
  d.run("PRAGMA foreign_keys=ON")
  initSchema(d)
  migrateFromEngram(d)
  // Cache only a fully initialized handle. Assigning before initSchema would
  // let a throw halfway through (disk fills mid CREATE TABLE) leave a
  // half-built db that every later caller gets back from the `if (db)` above,
  // turning the root cause into confusing "no such table" errors.
  db = d
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
    USING fts5(title, content, topic_key, content=observations, content_rowid=id)
  `)
  migrateFtsTopicKey(d)
  d.run(`
    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, topic_key) VALUES (new.id, new.title, new.content, new.topic_key);
    END
  `)
  d.run(`
    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, topic_key)
      VALUES('delete', old.id, old.title, old.content, old.topic_key);
    END
  `)
  d.run(`
    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, topic_key)
      VALUES('delete', old.id, old.title, old.content, old.topic_key);
      INSERT INTO observations_fts(rowid, title, content, topic_key)
      VALUES (new.id, new.title, new.content, new.topic_key);
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

// Widen observations_fts from (title, content) to (title, content, topic_key)
// so search() and conflicts.ts can weight topic_key in bm25 (engram #526).
// FTS5 virtual tables can't ALTER-add a column, so this drops and recreates
// it — same idempotency pattern as addColumn(): detect the old shape via
// PRAGMA table_info (topic_key absent from the column list) before touching
// anything. A fresh DB's CREATE VIRTUAL TABLE above already made the 3-column
// shape, so table_info reports topic_key present and this is a no-op. The
// triggers are dropped and recreated by name (not IF NOT EXISTS) because
// they're on the observations table, not the fts table, so they'd otherwise
// survive stale — still inserting only (title, content) — even after the
// table itself is widened.
//
// The whole sequence runs inside one explicit transaction: a crash between
// DROP TABLE and the rebuild would otherwise leave the fts table gone, and
// the next startup's `CREATE VIRTUAL TABLE IF NOT EXISTS` (in initSchema)
// would silently recreate an EMPTY 3-column table that this guard then
// treats as already migrated forever. Wrapping in BEGIN/COMMIT with a
// ROLLBACK on failure means a crash mid-migration always leaves the
// pre-migration 2-column shape intact, so this function retries cleanly on
// the next start.
function migrateFtsTopicKey(d: Database) {
  const cols = (d.query("PRAGMA table_info(observations_fts)").all() as any[]).map((r) => r.name)
  if (cols.includes("topic_key")) return
  d.run("BEGIN IMMEDIATE")
  // Re-check post-lock: another host may have passed the pre-lock check above
  // and already committed the migration while we were waiting on BEGIN
  // IMMEDIATE. Without this, we'd re-drop and rebuild an already-migrated
  // table — wasteful, not lossy, but still unnecessary work under the lock.
  const colsLocked = (d.query("PRAGMA table_info(observations_fts)").all() as any[]).map((r) => r.name)
  if (colsLocked.includes("topic_key")) { d.run("ROLLBACK"); return }
  try {
    d.run("DROP TRIGGER IF EXISTS obs_ai")
    d.run("DROP TRIGGER IF EXISTS obs_ad")
    d.run("DROP TRIGGER IF EXISTS obs_au")
    d.run("DROP TABLE IF EXISTS observations_fts")
    d.run(`
      CREATE VIRTUAL TABLE observations_fts
      USING fts5(title, content, topic_key, content=observations, content_rowid=id)
    `)
    // Reindex every existing row into the widened table (external-content
    // FTS5 rebuild command — see https://sqlite.org/fts5.html#the_rebuild_command).
    d.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")
    d.run("COMMIT")
  } catch (e) {
    // SQLite may have already auto-rolled-back the transaction (SQLITE_FULL,
    // IOERR, NOMEM, BUSY, INTERRUPT); calling ROLLBACK on a dead transaction
    // throws "cannot rollback - no transaction is active", which would
    // replace the original error below. Swallow that so `throw e` always
    // surfaces the real cause.
    try { d.run("ROLLBACK") } catch {}
    throw e
  }
}

// One-time import from a legacy Go-engram DB. Engram denormalizes (a `project`
// TEXT column, no projects table; prompts live in `user_prompts`), so this maps
// its schema onto ours rather than copying columns blindly. Idempotent via
// INSERT OR IGNORE on primary keys; best-effort — a failure never blocks init,
// because a broken migration must not cost us the whole memory store.
// ecomono: dead code with an expiry condition, not a ceiling to raise. Engram
// is a retired external product this port replaced, so the schema branch this
// once implied — "a future engram version needs a matching branch" — will never
// be needed. Delete this function, ENGRAM_DB, and test_migration.ts once every
// machine has run it. A machine has, if `~/.engram/engram.db.pre-ecomono.bak`
// exists beside the legacy db, or if `~/.engram/` was never there at all.
// Until then it stays: on an unmigrated machine, deleting it silently strands
// that machine's whole memory history. Cost of keeping it is one existsSync.
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
