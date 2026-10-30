#!/usr/bin/env bash
# Smoke test: drive the installed `omp` through the deployed ecomono layout, offline.
#
#   bash omp/tests/smoke.sh               hermetic scenarios against this checkout
#   bash omp/tests/smoke.sh --installed   first assert, read-only, that the real omp agent dir (the
#                                         home-manager or install.sh result) matches its source tree, then
#                                         run the same scenarios with that tree as the source
#
# A throwaway HOME gets the layout install.sh would build (install_omp_config, the skills link, the two
# mcp.json entries), then omp runs with omp/tests/mock-provider.ts as its model, so no LLM and no network is
# involved. Each scenario asserts on the dump the mock writes: what the real harness resolved (persona, style,
# commands, skills, the memory bundle) and what it fed back to the model (the compression handler, the bash
# receipt, path deny, judge and github gates through the symlinked extension), plus what omp did with a spawn (the
# payload the tier routing reads, the model it applied, the memory guard in the child). The end-to-end layer above
# the bun suites of omp/tests/run-tests.sh, whose events are built by hand: this is where a renamed omp field shows.
# A version other than the tested one fails unless ECOMONO_OMP_UNTESTED=1.
#
# Skips (exit 0) without omp on PATH. The first statements are shell builtins on purpose: this guard runs
# before anything that might not be installed.

if ! command -v omp >/dev/null 2>&1; then
  echo "SKIP: omp not on PATH"
  exit 0
fi

set -euo pipefail

installed=0
case "${1:-}" in
  "") ;;
  --installed) installed=1 ;;
  *) echo "usage: smoke.sh [--installed]" >&2; exit 2 ;;
esac

CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_HOME="$HOME"
fails=0
bad() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

command -v jq >/dev/null 2>&1 || { echo "error: jq not found (needed to read the dump and edit mcp.json)" >&2; exit 1; }

# The one deliberate write into the real HOME: omp extracts its native grammars here, about 94 MB per omp
# version in a <version>/ subdirectory. It is persistent because check.sh runs this smoke every time and a temp
# dir would re-extract that on each run. Never ~/.omp/natives. Deleting it is safe, the next run re-extracts:
# rm -r "${XDG_CACHE_HOME:-$HOME/.cache}/ecomono-omp-natives". An omp upgrade leaves the old version behind.
# Resolved here, before HOME is replaced below.
export PI_NATIVES_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ecomono-omp-natives"
mkdir -p "$PI_NATIVES_DIR"

SRC="$CHECKOUT"
if [ "$installed" -eq 1 ]; then
  # Same resolution as install.sh, so a redirected agent dir is the one inspected. Read-only from here to the
  # end of this block.
  real_omp="${PI_CODING_AGENT_DIR:-$REAL_HOME/${PI_CONFIG_DIR:-.omp}/agent}"
  [ -f "$real_omp/extensions/ecomono/index.ts" ] \
    || { echo "error: $real_omp/extensions/ecomono/index.ts does not resolve (run install.sh or switch the home-manager config first)" >&2; exit 1; }
  # <repo>/omp/extensions/ecomono -> the repo root is three levels up.
  SRC="$(cd "$(readlink -f "$real_omp/extensions/ecomono")/../../.." && pwd)"
  echo "installed source tree: $SRC"

  [ -x "$SRC/claude/hooks/review-receipt-gate.sh" ] || bad "$SRC/claude/hooks/review-receipt-gate.sh is not executable"
  same() { cmp -s "$1" "$2" || bad "$2 is missing or differs from $1"; } # cmp follows symlinks
  same "$SRC/opencode/AGENTS.md" "$real_omp/RULES.md"
  same "$SRC/claude/output-styles/ecomono.md" "$real_omp/PERSONALITY.md"
  for f in "$SRC"/claude/agents/*.md; do same "$f" "$real_omp/agents/$(basename "$f")"; done
  for f in "$SRC"/claude/commands/*.md; do same "$f" "$real_omp/commands/$(basename "$f")"; done
  jq -e '.mcpServers["ecomono-memory"] and .mcpServers.context7' "$real_omp/mcp.json" >/dev/null \
    || bad "$real_omp/mcp.json lacks the ecomono-memory or context7 entry"
  [ "$fails" -eq 0 ] || exit 1
  echo "ok: installed layout matches $SRC"
fi

# Resolves bun while HOME is still the real one (its fallback is ~/.bun/bin/bun).
# shellcheck source=/dev/null
. "$SRC/opencode/plugins/storage/_bun.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp"
export XDG_CONFIG_HOME="$tmp/.config" XDG_DATA_HOME="$tmp/.local/share"
export XDG_STATE_HOME="$tmp/.local/state" XDG_CACHE_HOME="$tmp/.cache"
# db.ts reads these two at import: without them the memory bundle would ATTACH and back up the real
# ~/.engram/engram.db. The legacy path is never created.
export ECOMONO_DATA_DIR="$tmp/data" ECOMONO_LEGACY_DB="$tmp/no-legacy.db"
export PI_NO_TITLE=1 OMP_MCP_TIMEOUT_MS=8000
unset PI_CODING_AGENT_DIR PI_CONFIG_DIR CLAUDE_CONFIG_DIR OMP_PROFILE PI_PROFILE
# Valves and toggles of the calling shell: any of them changes what the gates and the compressor do.
unset ECOMONO_COMPRESS ECOMONO_ALLOW_UNREVIEWED_PUSH ECOMONO_ALLOW_SECRET_PATHS
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$ECOMONO_DATA_DIR" "$tmp/project"

# After the isolation above, so not even `--version` can touch the real home.
version="$(omp --version)"
echo "omp: $version"
# An untested omp is a failure: the gates read event fields by name, and a renamed one would allow in silence while
# every other check stays green. ECOMONO_OMP_UNTESTED=1 runs it anyway, for the upgrade protocol in README.md: the
# scenarios below are what vets a new version, after which OMP_TESTED in the extension is bumped. Read from the tree
# under test, the one whose extension runs below.
tested="$(sed -n 's/^const OMP_TESTED = "\([^"]*\)".*/\1/p' "$SRC/omp/extensions/ecomono/index.ts")"
[ -n "$tested" ] || { echo "error: no OMP_TESTED line in $SRC/omp/extensions/ecomono/index.ts" >&2; exit 1; }
case "$version" in
  *"$tested"*) ;;
  *)
    if [ "${ECOMONO_OMP_UNTESTED:-}" = 1 ]; then
      echo "warn: tested against omp $tested, running $version (ECOMONO_OMP_UNTESTED=1)" >&2
    else
      echo "error: tested against omp $tested, running $version; run with ECOMONO_OMP_UNTESTED=1 to vet it (README.md, upgrade protocol)" >&2
      exit 1
    fi
    ;;
esac

OMP="$tmp/.omp/agent"
# A subshell: lib/common.sh sets -euo pipefail and defines helpers this script does not want.
(
  # shellcheck source=lib/common.sh
  . "$CHECKOUT/lib/common.sh"
  REPO="$SRC" install_omp_config "$OMP"
  # omp reads skills only from ~/.agents/skills; install.sh's skills step is not part of install_omp_config.
  link_children "$SRC/agent-skills" "$tmp/.agents/skills"
  ensure_omp_mcp "$OMP/mcp.json" ecomono-memory "$BUN" "$SRC/opencode/plugins/storage/mcp-server.js"
  ensure_omp_mcp "$OMP/mcp.json" context7 "${CONTEXT7_MCP[@]}"
) >/dev/null
# omp's own settings for the run. ecomono ships no config.yml, so this one is the smoke's alone: the three roles the
# tier routing resolves (smol, task, slow) name distinct mock models, which shows what omp applied to a spawn, and
# the github tool, off by default, is on where gh exists (omp registers it only then).
cat > "$OMP/config.yml" <<'EOF'
modelRoles:
  smol: fakellm/fake-smol
  task: fakellm/fake-task
  slow: fakellm/fake-slow
github:
  enabled: true
EOF
# Registered like install.sh does, then disabled so print mode does not wait on npx.
jq '.disabledServers = ((.disabledServers // []) + ["context7"])' "$OMP/mcp.json" > "$tmp/mcp.json.new"
mv "$tmp/mcp.json.new" "$OMP/mcp.json"
jq -e '.mcpServers["ecomono-memory"] and .mcpServers.context7' "$OMP/mcp.json" >/dev/null \
  || { echo "error: the deploy did not write both mcp.json entries" >&2; exit 1; }

# scenario <name> <prompt> <steps-json>: one omp run, then DUMP names the mock's JSON lines.
SCEN=""
DUMP=""
scenario() {
  SCEN="$1"
  local script="$tmp/$1.script.json" err="$tmp/$1.err" out="$tmp/$1.out"
  DUMP="$tmp/$1.dump.jsonl"
  printf '%s\n' "$3" > "$script"
  : > "$DUMP"
  (
    cd "$tmp/project"
    ECOMONO_OMP_SCRIPT="$script" ECOMONO_OMP_DUMP="$DUMP" \
      timeout 120 omp -p --no-session --no-lsp -e "$CHECKOUT/omp/tests/mock-provider.ts" \
      --model fakellm/fake-1 --mode json "$2" </dev/null >"$out" 2>"$err"
  ) || {
    rc=$?
    bad "$SCEN: omp exited $rc, first lines of its stderr:"
    # The temp dir (and with it $err) is gone once the trap runs, so the lines are printed now.
    head -n 20 "$err" | sed 's/^/  /' >&2
  }
  if grep -q 'Failed to load extension' "$out" "$err"; then
    bad "$SCEN: an extension failed to load: $(grep -h 'Failed to load extension' "$out" "$err" | head -n 1)"
  fi
  [ -s "$DUMP" ] || bad "$SCEN: the mock wrote no dump"
}

# expect <label> <jq filter>: the filter must be true over the slurped dump lines.
expect() {
  if jq -se "$2" "$DUMP" >/dev/null 2>&1; then echo "ok: $SCEN: $1"; else bad "$SCEN: $1"; fi
}

# (a) discovery: what persona, style, commands, skills and the memory bundle resolved to.
# The prompt is a markdown slash command: omp expands it into the user message before the first request.
scenario discovery "/ecomono-sdd-new smoke-change" '[{"text":"done"}]'
sysprompt='[.[] | select(.ev == "prompt")][0].systemPrompt'
for marker in \
  "## Contextual Skill Loading (MANDATORY)" \
  "## Comportamiento mentor" \
  "## MCP Server Instructions" \
  "## ecomono-memory — Persistent Memory Protocol"; do
  # RULES.md carries the first; "## Comportamiento mentor" appears only in claude/output-styles/ecomono.md
  # (checked with grep over the repo), so it proves PERSONALITY.md reached the prompt.
  expect "system prompt has '$marker'" "$sysprompt | contains(\"$marker\")"
done
expect "command skill:ecomono-commit is registered" \
  '[.[] | select(.ev == "prompt")][0].commands | index("skill:ecomono-commit") != null'
# pi.getCommands() lists extension, TypeScript and skill commands, never markdown files from commands/
# (omp: extensibility/extensions/get-commands-handler.ts), so ecomono-sdd-new is proven by its expansion:
# the first request carries the command body with $ARGUMENTS substituted, not the literal slash text.
expect "markdown command ecomono-sdd-new expanded with its arguments" \
  '[.[] | select(.ev == "request" and .model == "fakellm/fake-1")][0].last | tostring | contains("Change name: smoke-change")'
# Spike 2 (docs/DESIGN.md, omp target > Spike results, row 2): the memory tool is either a bare tool name or reachable through its
# xd:// route in the system prompt.
mem="mcp__ecomono_memory_mem_save"
expect "memory tool reachable ($mem or xd://$mem)" \
  "[.[] | select(.ev == \"prompt\")][0] | ((.tools | index(\"$mem\")) != null) or (.systemPrompt | contains(\"xd://$mem\"))"

# (b) compression: the handler loads through the symlinked extension and rewrites the bash result.
# `seq` output reached the handler unchanged when this was written; if omp's shell minimizer starts rewriting
# it, switch to a loop that prints numbered lines.
scenario compression "smoke: compression" '[{"tool":"bash","args":{"command":"seq 1 2000"}},{"text":"done"}]'
expect "the bash result reaching the model has 'lines omitted'" \
  '[.[] | select(.ev == "request" and .last.role == "toolResult")] | any(.last | tostring | contains("lines omitted"))'

# (c) receipt: Claude's review-receipt-gate.sh, run by the extension, refuses a delivery in an armed repository.
# The project has no remote, so even a gate that failed open could not push anything. It is a git repository
# only from here on: scenarios (a) and (b) ran in a plain directory.
pgit() { git -C "$tmp/project" -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false "$@"; }
pgit init -q -b master
echo base > "$tmp/project/a.txt"
pgit add a.txt
pgit commit -q -m base
pgit checkout -q -b work
echo work > "$tmp/project/b.txt"
pgit add b.txt
pgit commit -q -m work
mkdir -p "$tmp/project/.git/ecomono"
: > "$tmp/project/.git/ecomono/review-mode"
scenario receipt "smoke: receipt" '[{"tool":"bash","args":{"command":"git push"}},{"text":"done"}]'
expect "the bash result reaching the model has 'Review mode is armed'" \
  '[.[] | select(.ev == "request" and .last.role == "toolResult")] | any(.last | tostring | contains("Review mode is armed"))'
if [ -z "$(pgit remote)" ]; then echo "ok: receipt: the project has no remote, nothing could be pushed"; else bad "receipt: the project has a remote"; fi

# (d) spawn shape: the tier mapping in the extension reads one payload shape, `patterns` holding exactly the bare
# tier word of the agent's frontmatter `model:`. The mock refuses the spawn (ECOMONO_OMP_BLOCK_SPAWN=1, set for
# this call only), so no subagent ever runs; the step is a non-batch `task` call (schema: omp task/types.ts).
# `task` runs as a background job and the spawn event fires inside it, so the scripted parent must `wait` for the
# job; without that step it ends first and the event never fires (spike 3, docs/DESIGN.md Spike results, row 3).
ECOMONO_OMP_BLOCK_SPAWN=1 scenario spawn "smoke: spawn shape" \
  '[{"tool":"task","args":{"agent":"ecomono-explore","task":"say hi","solutionSpace":"n/a"}},{"tool":"wait","args":{}},{"text":"done"}]'
expect "a spawn event for ecomono-explore has patterns [\"sonnet\"]" \
  '[.[] | select(.ev == "spawn" and .agent == "ecomono-explore")] | any(.patterns == ["sonnet"])'

# (e) internal-URL cwd: omp runs such a bash call in its embedded shell, which reaches the host, so the bash gates
# still judge it. Headless, the secret gate's ask blocks. The throwaway HOME has no such key; the path is only
# command text.
scenario urlcwd "smoke: url cwd" '[{"tool":"bash","args":{"command":"cat ~/.ssh/id_ed25519","cwd":"local://"}},{"text":"done"}]'
expect "the bash result reaching the model has 'credential material'" \
  '[.[] | select(.ev == "request" and .last.role == "toolResult")] | any(.last | tostring | contains("credential material"))'

# (f) path deny: the in-process deny on the read tool, with the globs of opencode/opencode.json. The sentinel is not a
# secret; the file name is what matches `**/.env`. A gate that failed open would hand its content to the model.
sentinel="SMOKE-SENTINEL-4f9c1e"
printf '%s\n' "$sentinel" > "$tmp/project/.env"
scenario pathdeny "smoke: path deny" '[{"tool":"read","args":{"path":".env"}},{"text":"done"}]'
expect "the read result reaching the model names opencode/opencode.json" \
  '[.[] | select(.ev == "request" and .last.role == "toolResult")] | any(.last | tostring | contains("opencode/opencode.json"))'
expect "no request carries the file's content" \
  "[.[] | select(.ev == \"request\")] | all(.last | tostring | contains(\"$sentinel\") | not)"

# (g) judge gate: judge-standards-gate.sh refuses a task item for a judge whose prompt has no skills heading. The spawn
# is blocked as in (d), so a gate that failed open still could not launch a child that replays the script.
ECOMONO_OMP_BLOCK_SPAWN=1 scenario judge "smoke: judge gate" \
  '[{"tool":"task","args":{"agent":"ecomono-judge-a","task":"review the diff","solutionSpace":"n/a"}},{"text":"done"}]'
expect "the task result reaching the model has the judge gate's reason" \
  '[.[] | select(.ev == "request" and .last.role == "toolResult")] | any(.last | tostring | contains("Skills to load before work"))'

# (h) github gate: a delivery through the github tool meets the same receipt gate as `git push`, in the armed project.
# omp registers the github tool only where gh is installed (config.yml above enables it).
if command -v gh >/dev/null 2>&1; then
  scenario github "smoke: github gate" '[{"tool":"github","args":{"op":"pr_push"}},{"text":"done"}]'
  expect "the github tool is registered" \
    '[.[] | select(.ev == "prompt")][0].tools | index("github") != null'
  expect "the github result reaching the model has 'Review mode is armed'" \
    '[.[] | select(.ev == "request" and .last.role == "toolResult")] | any(.last | tostring | contains("Review mode is armed"))'
else
  echo "skip: github: gh is not on PATH, omp does not register the github tool"
fi

# (i) a spawned child: the memory guard and the tier model, in a session omp really runs. The spawn is NOT blocked here,
# and the mock scripts the two sessions apart ({"main", "sub"}, told by the marker in the task text) so the child does
# not replay the parent's `task` step. ecomono-explore lists no memory tool and has `model: sonnet`: its mem_save call
# must be refused, and its own requests must name the model the smoke bound to @task, not the main model. The refused
# call is the only memory call; had the guard failed open, the row would land in the throwaway data dir.
scenario child "smoke: child session" \
  '{"main":[{"tool":"task","args":{"agent":"ecomono-explore","task":"ecomono-smoke-child: save a memory","solutionSpace":"n/a"}},{"tool":"wait","args":{}},{"text":"done"}],"sub":[{"tool":"mcp__ecomono_memory_mem_save","args":{"title":"smoke","content":"smoke","type":"learning"}},{"text":"child done"}]}'
expect "the child's memory call was refused by the guard" \
  '[.[] | select(.ev == "request" and .session == "sub" and .last.role == "toolResult")] | any(.last | tostring | contains("memory tool mcp__ecomono-memory__mem_save is not listed in its tools:"))'
# The child's first request is omp's own background call on the smol role; the agent loop's requests carry a tool result.
expect "the child's agent-loop requests name the @task model" \
  '[.[] | select(.ev == "request" and .session == "sub" and .last.role == "toolResult")] | length > 0 and all(.model == "fakellm/fake-task")'

if [ "$fails" -ne 0 ]; then
  echo "smoke: $fails check(s) failed" >&2
  exit 1
fi
echo "smoke: all checks pass"
