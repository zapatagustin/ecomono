# Spec: Port Engram to Native ecomono

## Requirements

### REQ-1: Storage Layer (MUST)
Replace HTTP bridge to engram Go binary with direct SQLite access via `bun:sqlite`. Misma schema de datos, mismo comportamiento.

### REQ-2: MCP Tool Interface (MUST)
Preservar interfaz exacta de todas las MCP tools que skills/agentes usan:
- `mem_save` — save observation with title, type, content, project, topic_key, scope
- `mem_search` — FTS5 full-text search por query + filters (project, type, scope, limit)
- `mem_get_observation` — get full content por ID
- `mem_context` — recent observations por project
- `mem_session_summary` — save end-of-session summary
- `mem_save_prompt` — save user prompt text
- `mem_update` — update existing observation por ID
- `mem_delete` — delete observation
- `mem_suggest_topic_key` — suggest stable topic_key from title
- `mem_stats` — observation/session counts
- `mem_session_start` / `mem_session_end` — session lifecycle
- `mem_pin` / `mem_unpin` — pinning
- `mem_review` — lifecycle review
- `mem_current_project` — detect project from cwd

### REQ-3: Eliminar fetch de binary (MUST)
- `install.sh`: remover `install_gh_binary Gentleman-Programming/engram`
- `install.sh`: remover `engram setup opencode`
- `nix/engram.nix`: eliminar archivo
- `flake.nix`: remover engram package, home.packages, activation
- `lib/common.sh`: mantener arch_tag si gentle-ai aún lo usa

### REQ-4: Eliminar Claude plugin (MUST)
- `claude/settings.template.json`: remover `engram@engram` de enabledPlugins y extraKnownMarketplaces
- `flake.nix` activation: remover `ensurePlugin Gentleman-Programming/engram`

### REQ-5: Data directory (MUST)
Migrar de `~/.engram/memory.db` a `~/.ecomono/memory.db`. Script de migración one-shot en plugin, primera ejecución.

### REQ-6: Session continuity (MUST)
Session ID tracking vía `input.sessionID` de OpenCode hooks (igual que hoy). No perder sesiones activas durante upgrade.

### REQ-7: Compaction support (MUST)
`experimental.session.compacting` hook debe seguir funcionando: guardar checkpoint + inyectar contexto + instruir compressor.

### REQ-8: Health check (SHOULD)
Endpoint `/health` o equivalente para que `isEngramRunning()` en el plugin pueda verificar.

## Scenarios

### Scenario 1: Fresh install
Given: usuario instala ecomono fresh (sin ~/.engram)
When: plugin carga por primera vez
Then: crea `~/.ecomono/memory.db` con schema
Then: todas las MCP tools funcionan sin binary externo
Then: install.sh no descarga engram binary

### Scenario 2: Upgrade from existing engram
Given: usuario tiene ~/.engram/memory.db con datos existentes
When: plugin carga con nueva versión
Then: detecta ~/.engram, migra datos a ~/.ecomono/memory.db
Then: crea backup de ~/.engram antes de migrar
Then: MCP tools responden con datos migrados

### Scenario 3: MCP tool backward compat
Given: skill llama mem_save con title, type, content, project
When: implementación nativa procesa
Then: observation guardada con mismos campos que antes
Then: mem_get_observation(id) devuelve mismo formato
Then: mem_search(query) devuelve mismos resultados con FTS5

### Scenario 4: Compaction
Given: OpenCode dispara experimental.session.compacting
When: plugin maneja hook
Then: guarda checkpoint de sesión actual
Then: inyecta contexto de sesiones previas
Then: agrega instrucción CRITICAL INSTRUCTION para compressor

## Non-Goals
- NO cambiar gentle-ai dependency
- NO cambiar interfaz de MCP tools expuesta a skills/agentes
- NO agregar runtime nuevo (solo bun:sqlite que ya existe en Bun)
- NO refactorizar el plugin engram.ts beyond storage layer