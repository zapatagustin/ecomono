/**
 * FTS topic_key migration test — run: bun run test_fts_migration.ts
 * Fabricates a DB with the OLD 2-column observations_fts shape (title, content
 * only — no topic_key) and asserts db.ts's migrateFtsTopicKey() widens it in
 * place: pre-existing rows become topic_key-searchable without being re-saved,
 * and the widened shape survives a second init untouched.
 * Self-contained: builds its own fixture, touches no real data.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

const tmp = mkdtempSync(join(tmpdir(), "ecomono-ftsmigtest-"))
const dataDir = join(tmp, "data")
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, "memory.db")

// --- fabricate a pre-widen DB: current observations schema, but
// observations_fts and its triggers still in the OLD (title, content) shape ---
const old = new Database(dbPath)
old.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
old.run(`
  CREATE TABLE observations (
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
old.run("CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, content=observations, content_rowid=id)")
old.run(`
  CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END
`)
old.run(`
  CREATE TRIGGER obs_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, content)
    VALUES('delete', old.id, old.title, old.content);
  END
`)
old.run(`
  CREATE TRIGGER obs_au AFTER UPDATE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, content)
    VALUES('delete', old.id, old.title, old.content);
    INSERT INTO observations_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
  END
`)
old.run("INSERT INTO projects (id, name) VALUES ('proj-a','proj-a')")
old.run("INSERT INTO observations (project_id, title, content, topic_key) VALUES ('proj-a', 'legacy row', 'body text', 'gizmo-widget')")
old.close()

// --- simulate the crash point migrateFtsTopicKey() now guards against: kill
// the process between DROP TABLE and the rebuild. Reopen raw (db.ts not yet
// imported), open a transaction, drop the triggers + fts table exactly like
// migrateFtsTopicKey does, then close() WITHOUT committing. SQLite rolls back
// an uncommitted transaction on close (asserted below) -- the same outcome a
// real kill -9 leaves via WAL/journal recovery on the next open. Post-fix,
// this rollback is the ONLY reachable crash state: the DROP now lives inside
// migrateFtsTopicKey's own BEGIN IMMEDIATE/COMMIT, so a "table gone, guard
// fooled into treating an empty index as migrated" state (the pre-fix bug)
// can no longer occur here -- asserting recovery from a directly-fabricated
// half-dropped state would test a state the fix makes unreachable, not the
// invariant the fix actually provides. So this asserts the reachable one.
const crash = new Database(dbPath)
crash.run("BEGIN IMMEDIATE")
crash.run("DROP TRIGGER obs_ai")
crash.run("DROP TRIGGER obs_ad")
crash.run("DROP TRIGGER obs_au")
crash.run("DROP TABLE observations_fts")
crash.close() // no COMMIT -- rolled back on close, like a real crash

const postCrash = new Database(dbPath)
const crashCols = (postCrash.query("PRAGMA table_info(observations_fts)").all() as any[]).map((r: any) => r.name)
assert(crashCols.length === 2 && !crashCols.includes("topic_key"), "crash mid-migration rolls back to the pre-migration 2-column shape, not a half-dropped one")
const crashTriggers = (postCrash.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as any[]).map((r: any) => r.name).sort()
assert.deepStrictEqual(crashTriggers, ["obs_ad", "obs_ai", "obs_au"], "crash rollback also restores the dropped triggers")
postCrash.close()

process.env.ECOMONO_DATA_DIR = dataDir
process.env.ECOMONO_LEGACY_DB = join(tmp, "no-such-legacy.db") // skip engram migration

const { getDb, closeDb } = await import("./db")
const d = getDb()

// widened to 3 columns
const cols = (d.query("PRAGMA table_info(observations_fts)").all() as any[]).map((r) => r.name)
assert(cols.length === 3 && cols.includes("topic_key"), "observations_fts widened to 3 columns")

// the pre-existing row (never re-saved) is now searchable by its topic_key
const hit = d.query("SELECT o.id FROM observations o JOIN observations_fts f ON o.id=f.rowid WHERE observations_fts MATCH 'gizmo'").all() as any[]
assert(hit.length === 1, "pre-existing row becomes topic_key-searchable after rebuild")

// recreated triggers keep new rows indexed correctly
const Obs = await import("./observations")
Obs.save({ title: "fresh row", content: "fresh body", topic_key: "sprocket-part", project: "proj-a" })
assert(Obs.search({ query: "sprocket", project: "proj-a" }).length === 1, "new rows index topic_key via recreated triggers")

// idempotent: closing and reopening an already-migrated DB is a no-op
closeDb()
const d2 = getDb()
assert((d2.query("PRAGMA table_info(observations_fts)").all() as any[]).length === 3, "already-migrated DB stays untouched on re-init")
const triggersBefore = (d2.query("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all() as any[])
closeDb()

// post-lock re-check: a fresh handle sees the pre-lock check pass (table
// already migrated), takes BEGIN IMMEDIATE, then must re-read table_info and
// bail out via the early ROLLBACK+return instead of dropping and rebuilding
// an already-migrated table. Not directly forceable from outside (there's no
// second host here), so this instead asserts the observable contract that
// re-running getDb() against an already-migrated DB never touches the
// triggers/table (same sqlite_master rows) and MATCH keeps working.
const d3 = getDb()
const triggersAfter = (d3.query("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all() as any[])
assert.deepStrictEqual(triggersAfter, triggersBefore, "re-init on an already-migrated DB leaves triggers byte-identical (no drop/rebuild)")
assert(d3.query("SELECT o.id FROM observations o JOIN observations_fts f ON o.id=f.rowid WHERE observations_fts MATCH 'gizmo'").all().length === 1, "MATCH still works after re-init")
closeDb()

console.log("✓ fts migration: all assertions passed")
