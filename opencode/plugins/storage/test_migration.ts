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
old.run("CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, sync_id TEXT, session_id TEXT, content TEXT, project TEXT, created_at TEXT)")
old.run("INSERT INTO sessions (id, project, started_at) VALUES ('s1','proj-a','2026-01-01'), ('s2','proj-b','2026-01-02')")
old.run("INSERT INTO observations (id, type, title, content, project, scope, pinned, created_at, updated_at, deleted_at) VALUES (1,'decision','keep','body one','proj-a','project',1,'t','t',NULL), (2,'bugfix','fixed','body two','proj-b','project',0,'t','t',NULL), (3,'note','gone','tombstoned','proj-a','project',0,'t','t','2026-02-01')")
old.run("INSERT INTO user_prompts (id, session_id, content, created_at) VALUES (1,'s1','prompt in known session','t'), (2,'ghost-session','prompt orphaned','t')")
old.close()

process.env.ECOMONO_DATA_DIR = join(tmp, "data")
process.env.ECOMONO_LEGACY_DB = legacy

const { getDb } = await import("./db")
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

console.log("✓ migration: all assertions passed")
