/**
 * Migration test — run: bun run test_migration.ts
 * Fabricates a minimal legacy engram-schema DB and asserts it maps onto our
 * schema correctly. Self-contained: builds its own fixture, touches no real data.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

const tmp = mkdtempSync(join(tmpdir(), "ecomono-migtest-"))
const legacy = join(tmp, "engram.db")

// --- fabricate a legacy engram DB (denormalized `project`, user_prompts) ---
const old = new Database(legacy)
old.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, sync_id TEXT, session_id TEXT, type TEXT, title TEXT, content TEXT, project TEXT, scope TEXT, topic_key TEXT, pinned INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, review_after TEXT, embedding BLOB)")
old.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, directory TEXT, started_at TEXT, ended_at TEXT, summary TEXT)")
// No `content` yet: the first open's prompts step fails (added back below).
old.run("CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, sync_id TEXT, session_id TEXT, project TEXT, created_at TEXT)")
old.run("INSERT INTO sessions (id, project, started_at) VALUES ('s1','proj-a','2026-01-01'), ('s2','proj-b','2026-01-02')")
old.run("INSERT INTO observations (id, type, title, content, project, scope, pinned, created_at, updated_at, deleted_at) VALUES (1,'decision','keep','body one','proj-a','project',1,'t','t',NULL), (2,'bugfix','fixed','body two','proj-b','project',0,'t','t',NULL), (3,'note','gone','tombstoned','proj-a','project',0,'t','t','2026-02-01')")
old.close()

process.env.ECOMONO_DATA_DIR = join(tmp, "data")
process.env.ECOMONO_LEGACY_DB = legacy

const { getDb, closeDb } = await import("./db")

// A partial run writes no done-marker, so the next open retries it.
const partial = getDb()
assert(!partial.query("SELECT 1 FROM meta WHERE key='engram_migrated'").get(), "no done-marker after a failed step")
assert((partial.query("SELECT COUNT(*) c FROM prompts").get() as any).c === 0, "prompts step failed")
closeDb()
const fixed = new Database(legacy)
fixed.run("ALTER TABLE user_prompts ADD COLUMN content TEXT")
fixed.run("INSERT INTO user_prompts (id, session_id, content, created_at) VALUES (1,'s1','prompt in known session','t'), (2,'ghost-session','prompt orphaned','t')")
fixed.close()

const d = getDb()
const c = (sql: string) => (d.query(sql).get() as any).c

// projects derived from the denormalized column (a + b)
assert(c("SELECT COUNT(*) c FROM projects") === 2, "2 projects derived")
// deleted observation (id 3) excluded; 2 remain, project_id mapped
assert(c("SELECT COUNT(*) c FROM observations") === 2, "tombstoned obs excluded")
assert(c("SELECT COUNT(*) c FROM observations WHERE project_id='proj-a'") === 1, "project -> project_id mapped")
assert(c("SELECT COUNT(*) c FROM observations WHERE pinned=1") === 1, "pinned carried over")
// prompts: only the one whose session survived (orphan dropped by FK filter)
assert(c("SELECT COUNT(*) c FROM prompts") === 1, "orphan prompt excluded")
// FTS index populated by the insert triggers during migration
assert(c("SELECT COUNT(*) c FROM observations o JOIN observations_fts f ON o.id=f.rowid WHERE observations_fts MATCH 'body'") === 2, "FTS populated on migrated rows")
// no orphans
assert(c("SELECT COUNT(*) c FROM observations o LEFT JOIN projects p ON o.project_id=p.id WHERE p.id IS NULL") === 0, "no orphan observations")

// Once per store, not once per handle: opencode opens a fresh handle per
// location activation and after every closeDb(). A reopen must not re-run the
// INSERT OR IGNOREs and resurrect an engram-origin row deleted since.
assert(d.query("SELECT 1 FROM meta WHERE key='engram_migrated'").get(), "done-marker written")
d.run("DELETE FROM observations WHERE id = 1")
closeDb()
const reopened = getDb()
assert(reopened !== d, "closeDb() dropped the handle; getDb() opened a fresh one")
assert((reopened.query("SELECT COUNT(*) c FROM observations WHERE id = 1").get() as any).c === 0, "second open after a delete does not resurrect")

console.log("✓ migration: all assertions passed")
