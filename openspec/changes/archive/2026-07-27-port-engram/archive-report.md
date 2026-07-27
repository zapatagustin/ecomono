# Archive Report: Port Engram to Native ecomono

## Summary
Engram external Go binary replaced with native bun:sqlite implementation. All MCP tools preserved. External dependency eliminated.

## Files Created (4)
- `opencode/plugins/storage/db.ts` — SQLite init, schema, migration
- `opencode/plugins/storage/observations.ts` — CRUD + search
- `opencode/plugins/storage/sessions.ts` — session lifecycle
- `opencode/plugins/storage/prompts.ts` — prompt capture

## Files Modified (8)
- `opencode/plugins/engram.ts` — rewrote storage layer (HTTP → direct SQLite)
- `install.sh` — removed engram binary fetch + setup
- `flake.nix` — removed engram package, home.packages, activation
- `claude/settings.template.json` — removed engram plugin + marketplace
- `lib/common.sh` — updated comments
- `README.md` — updated references
- `opencode/tui.json` — removed opencode-sdd-engram-manage
- `opencode/opencode.json` — removed engram MCP server entry

## Files Deleted (1)
- `nix/engram.nix`

## Delta Spec (behavior changes)
- **Storage**: HTTP bridge (port 7437) → direct bun:sqlite calls
- **MCP server**: External Go binary → plugin-registered tools
- **Data dir**: ~/.engram → ~/.ecomono (auto-migration)
- **Deployment**: No more Go binary fetch from GitHub releases
- **Health check**: Removed (no HTTP server to health-check)

## Open Items
- Health check should be added if runtime storage verification is needed
- Protocol rename from "engram" to "ecomono-memory" deferred

## Dependencies
- Bun runtime (bun:sqlite built-in) — same as before
- No new external dependencies