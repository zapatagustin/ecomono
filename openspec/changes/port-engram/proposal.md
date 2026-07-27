# Proposal: Port Engram to Native ecomono

## Intent

Reemplazar la dependencia externa `engram` (Go binary, GitHub release) por una implementación nativa dentro de ecomono. Misma interfaz MCP, cero dependencias externas.

## Scope

**In scope:**
- Implementar storage layer (SQLite) directamente en ecomono
- Eliminar HTTP bridge del plugin engram.ts → calls directas
- Remover `install.sh` fetch de engram binary
- Remover `nix/engram.nix`
- Remover engram package + activation de `flake.nix`
- Remover Claude plugin `engram@engram` de `settings.template.json`
- Mantener interfaz MCP idéntica (mem_save, mem_search, mem_get_observation, mem_context, mem_session_summary, etc.)
- Migrar datos de ~/.engram si existe

**Out of scope:**
- No tocar gentle-ai (otra dependencia externa, otro cambio)
- No cambiar el protocolo de skills/agentes que usan engram MCP tools
- No cambiar el registro de Claude plugins (solo engram, no superpowers/context7)

## Approach

**Opción A (recomendada): SQLite directo en el plugin TypeScript**

El plugin engram.ts ya corre en Bun (OpenCode runtime). Bun tiene `bun:sqlite` nativo. Reemplazar:

```
Flow actual:  plugin → HTTP fetch → engram Go server → SQLite
Flow nuevo:   plugin → bun:sqlite directo → SQLite
```

Ventajas:
- Cero dependencias nuevas (bun:sqlite es built-in)
- Elimina latencia de HTTP (localhost round-trip)
- Simplifica deployment (no binary que mantener)
- El plugin ya maneja sessions, compaction, nudges — solo cambiar storage

Desventajas:
- SQLite embebido en proceso OpenCode (no compartible entre procesos)
- Migración de datos existentes requiere script one-shot

**Opción B: Plugin MCP server interno**

Un script aparte que corre como MCP server en lugar del Go binary. Similar pero sin HTTP.

Ventajas: desacoplado del plugin. Desventajas: más moving parts.

## Storage Schema

```sql
-- ~/.ecomono/memory.db

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'manual',
  scope TEXT NOT NULL DEFAULT 'project',
  content TEXT NOT NULL,
  topic_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  summary TEXT
);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Migration

- Detectar `~/.engram/memory.db`
- Si existe, copiar datos a `~/.ecomono/memory.db`
- Script one-shot en el plugin, primera ejecución post-instalación

## Risks

| Risk | Mitigation |
|------|------------|
| Pérdida de memoria existente | Script de migración + backup automático |
| SQLite lock en writes concurrentes | WAL mode + single-writer pattern |
| Compatibilidad MCP tools | Test suite que verifica cada tool contra schema actual |
| Rotura de sesiones activas | Session ID tracking igual que hoy (input.sessionID de OpenCode) |