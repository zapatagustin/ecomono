# Tasks: Port Engram to Native ecomono

## Dependency Graph

```
T1.1 (db.ts) ──→ T1.2 (observations.ts)
             ├─→ T1.3 (sessions.ts)
             └─→ T1.4 (prompts.ts)
T1.2 + T1.3 + T1.4 → T2.1 (rewrite plugin storage calls)
T2.1 → T3.1 (remove binary fetch from install.sh)
     → T3.2 (delete nix/engram.nix)
     → T3.3 (update flake.nix)
     → T3.4 (update settings.template.json)
     → T3.5 (migration script)
```

## Phase 1 — Storage Layer

### T1.1 Create db.ts
Init SQLite, WAL mode, schema con FTS5. `~/.ecomono/memory.db`.
File: `opencode/plugins/storage/db.ts`

### T1.2 Create observations.ts
CRUD: mem_save, mem_search, mem_get_observation, mem_update, mem_delete, mem_suggest_topic_key, mem_stats, mem_pin, mem_unpin, mem_review, mem_current_project.
File: `opencode/plugins/storage/observations.ts`

### T1.3 Create sessions.ts
Session lifecycle: mem_session_start, mem_session_end, mem_session_summary, ensureSession.
File: `opencode/plugins/storage/sessions.ts`

### T1.4 Create prompts.ts
Prompt capture: mem_save_prompt. Session-linked storage.
File: `opencode/plugins/storage/prompts.ts`

## Phase 2 — Plugin Rewrite

### T2.1 Rewrite engram.ts storage calls
Replace HTTP fetch calls (engramFetch) with direct storage module calls. Keep hooks, memory-instructions, nudge logic intact. Remove ENGRAM_URL, ENGRAM_PORT, ENGRAM_BIN, isEngramRunning().
File: `opencode/plugins/engram.ts`

## Phase 3 — Remove External Dependency

### T3.1 Remove binary fetch from install.sh
Remove: `install_gh_binary Gentleman-Programming/engram`, `engram setup opencode` section, related vars.
File: `install.sh`

### T3.2 Delete nix/engram.nix
File: `nix/engram.nix` (delete)

### T3.3 Update flake.nix
Remove: engram package, engram from home.packages, engram activation block (ensurePlugin, `engram setup opencode`, shebang patch).
File: `flake.nix`

### T3.4 Update settings.template.json
Remove: `engram@engram` from enabledPlugins, engram from extraKnownMarketplaces.
File: `claude/settings.template.json`

### T3.5 Migration script
In plugin setup(): detect ~/.engram/memory.db, copy data, backup to .bak.
File: `opencode/plugins/storage/db.ts` (added to init)
