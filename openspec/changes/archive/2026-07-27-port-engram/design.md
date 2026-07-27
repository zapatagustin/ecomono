# Design: Port Engram to Native ecomono

## Architecture

### Flow Change

```
ANTES:
  engram.ts plugin → HTTP fetch (port 7437) → engram Go server → SQLite (~/.engram/memory.db)

DESPUÉS:
  engram.ts plugin → bun:sqlite directo → SQLite (~/.ecomono/memory.db)
```

### Module Structure

Engram.ts se reestructura en 3 capas:

```
engram.ts (plugin entry)
  └── storage/             ← NUEVO: capa de persistencia
       ├── db.ts           ← init DB, schema, migrations, WAL mode
       ├── observations.ts ← CRUD observations + FTS5 search
       ├── sessions.ts     ← session lifecycle
       └── prompts.ts      ← prompt capture
  └── mcp-tools.ts         ← NUEVO: wrapper que expone funciones como MCP tools
  └── hooks.ts             ← existente: hooks de OpenCode (session, compact, nudge)
  └── memory-instructions.ts ← existente: instrucciones inyectadas en system prompt
```

### Key Design Decisions

**1. bun:sqlite nativo**
Bun tiene SQLite built-in, zero deps. WAL mode para reads concurrentes.

**2. FTS5 para search**
`CREATE VIRTUAL TABLE observations_fts USING fts5(...)` — misma estrategia que engram Go. Index en title + content.

**3. MCP tool registration**
OpenCode plugin API permite registrar tools directamente. En lugar de HTTP a engram, cada tool es una función async que opera sobre SQLite.

**4. Session ID tracking**
Misma lógica actual: `input.sessionID` de OpenCode hooks. Sin cambios.

**5. Migración one-shot**
En `setup()` del plugin: detectar `~/.engram/memory.db`, copiar tablas, rename a `.bak`.

## Database Schema

```sql
-- ~/.ecomono/memory.db

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
);

CREATE INDEX IF NOT EXISTS idx_observations_project 
  ON observations(project_id);
CREATE INDEX IF NOT EXISTS idx_observations_topic_key 
  ON observations(project_id, topic_key);
CREATE INDEX IF NOT EXISTS idx_observations_created 
  ON observations(project_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts 
  USING fts5(title, content, content=observations, content_rowid=id);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project 
  ON sessions(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompts_session 
  ON prompts(session_id, created_at DESC);
```

## Data Migration

```typescript
async function migrateFromEngram(): Promise<boolean> {
  const engramPath = join(homeDir, '.engram', 'memory.db')
  if (!existsSync(engramPath)) return false
  
  // Backup
  const backupPath = engramPath + '.pre-ecomono.bak'
  if (!existsSync(backupPath)) {
    copyFileSync(engramPath, backupPath)
  }
  
  // Attach and copy
  db.run(`ATTACH DATABASE '${engramPath}' AS old`)
  db.run(`INSERT OR IGNORE INTO projects SELECT * FROM old.projects`)
  db.run(`INSERT OR IGNORE INTO observations SELECT * FROM old.observations`)
  db.run(`INSERT OR IGNORE INTO sessions SELECT * FROM old.sessions`)
  db.run(`INSERT OR IGNORE INTO prompts SELECT * FROM old.prompts`)
  db.run(`DETACH DATABASE old`)
  
  return true
}
```

## Files to Modify

| File | Action |
|------|--------|
| opencode/plugins/engram.ts | Rewrite storage layer, keep hooks/interface |
| install.sh | Remove engram binary fetch + setup |
| nix/engram.nix | Delete file |
| nix/gentle-ai.nix | Keep (separate change) |
| flake.nix | Remove engram package, home.packages, activation |
| lib/common.sh | Keep arch_tag (gentle-ai still needs it) |
| claude/settings.template.json | Remove engram plugin + marketplace |
| openspec/changes/port-engram/ | All phase artifacts |

## Files Unchanged (references engram but no code change)

These files reference "engram" as artifact store mode, not the binary. No action needed:
- skills/sdd-*.md
- claude/agents/sdd-*.md
- opencode/commands/sdd-*.md
- docs/DESIGN.md
- opencode/AGENTS.md