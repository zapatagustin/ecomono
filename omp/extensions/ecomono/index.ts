/**
 * ecomono extension for oh-my-pi (omp): the omp counterpart of the Claude hooks and the OpenCode plugins.
 *
 * What it does:
 * - Gates bash and github delivery through Claude's own hook scripts (secret access, diff size, review receipt),
 *   plus the `rm -rf` literals of Claude's deny list.
 * - Denies the path tools, the targets an edit names in its text input and the @-mentions, `taskFile` and
 *   `sourceSession` path of a task item on the read-deny globs of opencode/opencode.json, and withholds a read that
 *   resolved to such a file or lists one (a directory), a search result (grep, ast_grep, glob, find, ast_edit) that
 *   lists one and an xd://resolve result whose applied edits list one. It is a READ guard: no result channel
 *   (content, details, notices, the details omp persists in the session) carries a denied file's bytes or its path
 *   text to the model. The withhold is itself a one-bit result, a ceiling stated at the search post-check below.
 *   Writes to a denied file it cannot see (ast_edit + xd://resolve, eval, debug, bash outside the secret gate's
 *   patterns) are a ceiling, stated at the path gate below, and so are reads inside a seance subagent, which loads
 *   no extensions (the task gate below).
 * - Runs judge-standards-gate on every task item that names an agent.
 * - Compresses bash tool results with the same compressor Claude's PostToolUse hook runs, and adds the
 *   compaction-summary style text.
 * - Maps the agents' haiku/sonnet/opus tiers to omp's @smol/@task/@slow roles.
 * - Blocks the ecomono-memory tools an agent's own `tools:` line does not list.
 * - From the main session, refreshes the skill registry and saves each user prompt into the shared
 *   ecomono-memory DB; in the main TUI session, lists the open TODOs below the editor (org-todo.ts).
 *
 * omp loads the DEFAULT export only (the named exports are test seams).
 *
 * Error contract (non-negotiable): omp fails a `tool_call` CLOSED on a throw, a rejection or after 30 s, while
 * ecomono's gates fail OPEN. Every handler body therefore runs inside safe(): it catches everything, logs with
 * pi.logger.warn and returns undefined. No raw timers (ctx.setInterval only), no floating promises without a
 * .catch, no console.error (it draws over the TUI).
 *
 * Shared code is imported by path from the repo tree: the extension is linked into omp's extensions directory,
 * and REPO is resolved behind that link's realpath, so Claude's hook script and the OpenCode core files are
 * reused in place, never copied.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
// Spike 1 (docs/DESIGN.md, omp target > Spike results, row 1): static relative imports across trees resolve, so
// cross-tree TypeScript is a static relative import; the CommonJS compressor loads through createRequire below.
import { STYLE } from "../../../opencode/plugins/cave-compress/core.ts"
import { type HookDecision, logFailOpen, runHook, stateDir } from "../../../opencode/plugins/hook-runner/core.ts"

export const REPO = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..")

// The omp version the gates are tested on (README.md, upgrade protocol): omp/tests/smoke.sh and omp/tests/fake-pi.ts
// read it from this line, so a bump is one edit. A session on any other omp warns once per process.
const OMP_TESTED = "18.14.0"
// Module scope, not the factory's: omp re-runs the factory per subagent session in the same process.
let versionWarned = false

// The agents' frontmatter `model:` tier -> the omp role that stands for it. The consumer binds each role to a real
// model with omp's own modelRoles; ecomono ships no model ids (docs/DESIGN.md, omp target > Open questions,
// resolved: provider and models).
export const TIER_ROLE = { haiku: "@smol", sonnet: "@task", opus: "@slow" } as const

// What omp does with each script claude/settings.template.json registers. omp/tests/test_contract.ts keeps this
// table total: a hook added to the template without a line here fails the suite (the omp analogue of
// check-hook-install-drift.sh). Keys are script basenames under claude/hooks.
export const CLAUDE_HOOKS: Record<string, string> = {
  "secret-access-gate.sh": "tool_call bash, plus the path tools through the opencode.json deny globs",
  "check-diff-size.sh": "tool_call bash and github (pr_create, pr_push)",
  "review-receipt-gate.sh": "tool_call bash and github (pr_create, pr_push)",
  "judge-standards-gate.sh": "tool_call task, one run per item that names an agent",
  "ecomono-skill-registry.js": "session_start and before_agent_start, main session, pi.exec node",
  "ecomono-compress.js": "tool_result bash, loaded with createRequire",
  "agent-model-gate.sh": "replaced: before_subagent_spawn tiers",
  "workflow-model-gate.sh": "replaced: before_subagent_spawn tiers, eval spawns take the inheritance rule",
  "heavy-skill-gate.sh": "not needed: gated skills ship only inside Claude Code",
  "statusline.sh": "not needed: native status line",
}

// omp names an MCP tool `mcp__<server>_<tool>` with the server's `-` turned into `_`; Claude's agent files name the
// same tool `mcp__ecomono-memory__<tool>`.
const MEMORY_TOOL = "mcp__ecomono_memory_"
const MEMORY_TOOL_CLAUDE = "mcp__ecomono-memory__"

// omp appends model-facing notices after the body: wall time, raw-output artifact, temp-shell notice,
// spill/truncation, timeout, exit code (omp: tools/bash.ts:715,736-753; exec/bash-executor.ts:853-871;
// pi-tui: tools/bash.ts:201-207, tools/output-meta.ts:205-252). Known prefixes only: a body that ends in a
// one-line JSON array must not be mistaken for a notice. An unknown future notice stays in the body,
// where the tail budget keeps it: degrades, never drops.
const OMP_NOTICE = /^(?:\[(?:raw output: artifact:\/\/|Showing |Some lines truncated |\d+ (?:matches|results) limit|Command timed out).*\]|Wall time: [\d.]+ seconds|Command exited with code -?\d+|Ran in a temporary shell while .*)$/

/** Split a bash result into [body, tail]: tail is the trailing run of blank lines and notice lines, verbatim. */
function peel(text: string): [string, string] {
  const lines = text.split("\n")
  let end = lines.length
  while (end > 0 && (lines[end - 1].trim() === "" || OMP_NOTICE.test(lines[end - 1].trimEnd()))) end--
  const body = lines.slice(0, end).join("\n")
  return [body, text.slice(body.length)]
}

/** The message of a caught value, for a log line. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One pair of outer double quotes removed, as omp's stripOuterDoubleQuotes (tools/path-utils.ts:577-578). */
const unquote = (s: string): string => (s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

// ecomono: mirrors omp's normalizePathLikeInput + expandPath + resolveToCwd
// (tools/path-utils.ts:75-133,332-344,541-543,577-578), which extensions cannot import. Ceiling: a new omp path
// shorthand is not mirrored until test_paths.ts gains its case; the smoke pins the omp version. Every step can
// only widen what the deny check sees.
function ompPath(cwd: string, raw: string): string | undefined {
  let p = unquote(raw.trim())
  if (/^[@:](?=[/~.])/.test(p)) p = p.slice(1)
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p)
    } catch {}
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return undefined // skill://, artifact://, xd://, local://, http(s)://
  if (p.startsWith("~")) p = join(homedir(), p.slice(1)) // ~, ~/x and ~x, as expandTilde
  if (/^\/+$/.test(p)) return cwd
  return resolve(cwd, p)
}

// ---- path deny helpers (docs/DESIGN.md, omp target > Handler contracts: the path tools) ------------------------
// Every helper below only ever ADDS a spelling to test. Over-matching is the safe direction: a spelling omp would
// not read costs at most a false block on a path that already looks like a secret; a spelling omp does read and
// the gate missed is a leak, with no valve to release it.

/**
 * Path tools the deny globs apply to, on `path` and `paths`. edit's hashline headers reach `path`/`paths` through
 * omp's event normalizer only when the call has no `path`, so edit's text input is also read by editTargets().
 */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "find", "ast_grep", "ast_edit"])

/**
 * Tools whose result lists file paths in `details`, checked by the tool_result search post-check. ast_edit is one:
 * its result carries the diff lines of every file it touched.
 */
const SEARCH_RESULT_TOOLS = new Set(["grep", "ast_grep", "glob", "find", "ast_edit"])

// A header of omp's apply_patch form (`*** Update File: X`, `*** Move to: X`, ...), in the loose spelling the edit
// engine strips from a header path (APPLY_PATCH_PATH_NOISE_RE, crates/pi-edit/src/modes/hashline/input.rs:28), and
// the sloppy mode's `*** Edit File: X` / `*** Edit File X all` (HEADER_RE, crates/pi-edit/src/modes/sloppy/parse.rs:
// 48, where the `:` is optional). Written so that no two unbounded runs sit next to each other: the engine's own
// `[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*` is linear in Rust's regex, which does not backtrack, but quadratic in
// JavaScript's on a long header with no `:`.
const PATCH_HEADER = /^\*{1,3}\s*(?:(?:add|update|delete|move)[^A-Za-z0-9]*(?:(?:file|to)[^A-Za-z0-9]*)?:|edit[ \t]+file(?![A-Za-z0-9])[ \t]*:?)/i
// A snapshot tag at the end of a hashline header path: `#1A2B`, or a placeholder such as `#AUTO`, `#????` or a
// bare `#` (the engine's RECOVERY_TAG_RE and PLACEHOLDER_TAG_RE, input.rs:33-39).
const HEADER_TAG = /#[^\s#./\\:[\]]{0,16}(?=\s*(?:\]|$))/g

/**
 * The targets an `edit` call names in its text input (`input`, or `_input` as some hosts forward it), and the
 * `rename` targets of patch mode's `edits[]`. omp's event normalizer fills `path`/`paths` from hashline headers
 * only when the call has no `path` string, and from no other form (omp: extensibility/tool-event-input.ts:70-90),
 * so a hashline input next to an unrelated `path`, an apply_patch input and a hashline `MV` destination would
 * otherwise write a file the gate never sees. Header lines only, so a body line that mentions a secret path
 * costs nothing:
 * - `[PATH#TAG]`, an envelope-wrapped `[*** Begin Patch] [PATH#TAG]` too (the engine classifies any `[...]` line
 *   as a header before a payload, crates/pi-edit/src/modes/hashline/tokenizer.rs classify_line), and the legacy
 *   `¶PATH#TAG`;
 * - the apply_patch headers `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:`, and the
 *   sloppy mode's `*** Edit File:` (its trailing ` all` is one more whitespace part, which no glob matches);
 * - `MV <dest>`, a hashline rename (tokenizer.rs parse_hunk_header).
 * The tag, the header keyword, brackets, `¶` and quotes become spaces; deny() then also splits on whitespace, so a
 * quoted path with a space is tested whole and in parts.
 */
function editTargets(input: any): string[] {
  const out: string[] = []
  for (const text of [input.input, input._input]) {
    if (typeof text !== "string") continue
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      const header =
        (line.startsWith("[") && line.endsWith("]")) || line.startsWith("¶") || PATCH_HEADER.test(line) || /^MV(?:[\s:]|$)/.test(line)
      if (!header) continue
      out.push(line.replace(HEADER_TAG, "").replace(PATCH_HEADER, " ").replace(/^MV:?/, " ").replace(/[[\]¶"']/g, " "))
    }
  }
  for (const edit of Array.isArray(input.edits) ? input.edits : []) if (typeof edit?.rename === "string") out.push(edit.rename)
  return out
}

/**
 * A task field as the child sees it. omp's task tool runs repairTaskParams AFTER the tool_call event (pi-tui:
 * tools/task-repair-args.ts, called from omp: task/index.ts:460) on `task`, the batch `context` and every item's
 * `task`: a string that carries the signature of double-encoding (a `\"`, `\\`, `\/` or `\uXXXX` escape, or two
 * escape sequences) and whose whole body parses as a JSON string is replaced by that decode, so `a\n@.env\nb` reaches
 * the child as a real `@.env` mention and a heading line. The condition is mirrored exactly: a decode omp would not
 * do would let the judge-standards check see a heading the child never gets. Anything else is returned as given.
 */
function repairedTask(text: string): string {
  if (!text.includes("\\")) return text
  let signature = /\\(?:["\\/]|u[0-9a-fA-F]{4})/.test(text)
  for (let i = 0, escapes = 0; !signature && i < text.length; i++) {
    if (text[i] !== "\\") continue
    signature = ++escapes >= 2
    i++ // the escaped char is skipped, so `\\` counts once
  }
  if (!signature) return text
  try {
    const decoded: unknown = JSON.parse(`"${text}"`)
    return typeof decoded === "string" ? decoded : text
  } catch {
    return text // not a JSON string body: a literal path or a regex stays as typed
  }
}

/**
 * The `@path` mentions of a prompt, exactly as omp's extractFileMentions finds them (omp: utils/file-mentions.ts:
 * 33-55,168-186): a mention starts the text or follows whitespace or an opening bracket or quote; a quoted one is
 * only trimmed, a bare one also loses leading and trailing punctuation. omp reads each mentioned file into the
 * prompt with no tool_call of its own. The raw text and its repairedTask decode are both scanned: omp extracts
 * mentions from the decoded one, and the raw spelling is kept as well, since a spelling omp would not read costs at
 * most a false block.
 */
function fileMentions(text: string): string[] {
  const out = new Set<string>()
  for (const scanned of new Set([text, repairedTask(text)])) {
    for (const m of scanned.matchAll(/@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g)) {
      const i = m.index ?? 0
      if (i > 0 && !/[\s([{<"'`]/.test(scanned[i - 1])) continue
      const quoted = m[1] ?? m[2]
      const path =
        quoted !== undefined
          ? quoted.trim()
          : (m[3] ?? "").trim().replace(/^[`"'([{<]+/, "").replace(/[)\]}>.,;:!?"'`]+$/, "").trim()
      if (path) out.add(path)
    }
  }
  return [...out]
}

/** A string, or the strings of an array; anything else is ignored. */
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []

/**
 * The raw value plus the parts omp may split it into, plus each part with `\` as `/`.
 * - read fans a missing or over-long `a;b` list out into separate reads, and splits a `;` list that mixes URLs and paths
 *   before URL detection, so `skill://x;.env` reads `.env` (omp: tools/read.ts:1761-1766,2042-2048). The parts run
 *   through the tool's own execute, so no per-part tool_call fires.
 * - grep reads `path` or `paths`, each a string or an array, and splits a root on /[;,\s]+/
 *   (omp: tools/grep.ts:568-571; tools/search-approval-targets.ts:23). The split here is that superset.
 * - Search roots turn every `\` into `/` (normalizePathSeparators, omp: tools/path-utils.ts:571-575), so grep
 *   `~\.ssh` searches `~/.ssh`; the backslash form is kept as well, since read does not rewrite it.
 * - grep, glob and ast_grep decode a string that trims to a JSON string array (`'[".env"]'`) into its entries
 *   before resolving (omp: tools/grep.ts:677, glob.ts:212, ast-grep.ts:217, via pi-tui render/render-utils.ts
 *   toPathList). Each entry is added next to the raw value, whatever the tool: a decode omp would not do only
 *   costs a false block.
 */
function pathParts(value: string): string[] {
  const parts = new Set<string>()
  const listed = [value]
  const trimmed = value.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const decoded: unknown = JSON.parse(trimmed)
      if (Array.isArray(decoded)) for (const entry of decoded) if (typeof entry === "string") listed.push(entry)
    } catch {} // not JSON: a literal path
  }
  for (const text of listed) {
    parts.add(text)
    for (const part of text.split(/[;,\s]+/)) if (part) parts.add(part)
  }
  for (const part of [...parts]) if (part.includes("\\")) parts.add(part.replaceAll("\\", "/"))
  return [...parts]
}

/**
 * The local path a part reads. read's one `path` field takes a local path, an internal URI or a URL, selectors
 * inline (omp: tools/read.ts:821); the search and write tools take the same spellings. ompPath covers `file://`
 * (omp: tools/read.ts:1755-1757), quotes, `@`/`:` prefixes and `~`; internal URLs (skill://, artifact://, xd://,
 * http(s)://) resolve to undefined and are skipped.
 * `ssh://` is not skipped: it reads, searches and writes files on whatever host OpenSSH resolves, `localhost`
 * included, at the decoded URL pathname (omp: internal-urls/ssh-protocol.ts:76-106). That pathname is matched as
 * text, never resolved against cwd and whatever the host, so a remote `.env` or `~/.ssh/*` is denied like a local
 * one. It lives here and not in ompPath, which the bash cwd handling shares.
 */
function resolvePart(cwd: string, part: string): string | undefined {
  const bare = unquote(part.trim())
  // The original part, not `bare`: ompPath strips the quotes itself, once, as omp does.
  if (!/^ssh:\/\//i.test(bare)) return ompPath(cwd, part)
  try {
    const pathname = new URL(bare).pathname
    try {
      return decodeURIComponent(pathname)
    } catch {
      return pathname
    }
  } catch {
    return undefined
  }
}

/**
 * The path as given, with its `?query` cut and with the read selector cut. Read peels `:1-50`, `:raw` and the
 * compound `:1-50:raw` / `:raw:1-50` down to the path (pi-tui: tools/read.ts:147-184, splitPathAndSel), so the cut
 * is at the FIRST `:` of the last segment: a cut at the last `:` would leave `.env:1-5` or `.env:raw`, which no
 * glob matches. A direct read sets no details target for the post-check either, so this is the only place that
 * catches it.
 * An archive member `b.zip:.ssh/k` (omp: prompts/tools/read.md:12; tools/grep.ts:308 and tools/write.ts:645 parse
 * it too) has its `:` in a middle segment, where the cut above does not look, so the path is also tested with
 * every `:` as a `/`: `b.zip/.ssh/k` meets the `.ssh` glob, stacked selectors and `::` included.
 * A SQLite selector may hold a `/` too (`agent.db:auth_credentials:a/b`), so neither cut above leaves the bare file:
 * omp's read ends the database path at every `.db`, `.db3`, `.sqlite` or `.sqlite3` that a `:`, a `?` or the end
 * follows, whatever comes after (omp: tools/sqlite-reader.ts:63,547-570, SQLITE_PATH_PATTERN), and each such prefix
 * is a candidate here too.
 */
function candidates(path: string): string[] {
  const cutSelector = (s: string) => {
    const i = s.indexOf(":", s.lastIndexOf("/") + 1)
    return i < 0 ? s : s.slice(0, i)
  }
  const q = path.indexOf("?")
  const out = new Set<string>()
  for (const base of q < 0 ? [path] : [path, path.slice(0, q)]) {
    out.add(base)
    out.add(cutSelector(base))
    if (base.includes(":")) out.add(base.replaceAll(":", "/"))
    for (const m of base.matchAll(/\.(?:sqlite3?|db3?)(?=[:?]|$)/gi)) out.add(base.slice(0, (m.index ?? 0) + m[0].length))
  }
  return [...out]
}

/**
 * The path with the symlinks of its existing part resolved and the missing rest re-appended, as pi-utils'
 * resolveEquivalentPath with throughMissing (dirs.ts). omp follows a link when it reads or writes, so a link
 * committed to an untrusted repo (`docs/notes -> ~/.ssh/id_ed25519`), or a new file under a linked directory,
 * must meet the globs at its target. deny() tests it next to the lexical spelling, never in its place: a Nix store
 * link such as `~/.config/gh/hosts.yml` matches only by its name. The path itself when nothing resolves.
 * ecomono: realpath fails on a dangling link, so a link to a missing file is not followed. Ceiling: a `write`
 * through a dangling link to a denied path creates that file unchecked. Upgrade path: follow readlink on the first
 * missing segment, or omp's tools.restrictedFolders.
 */
function realish(path: string): string {
  const rest: string[] = []
  for (let head = path; ; ) {
    try {
      return join(realpathSync(head), ...rest)
    } catch {
      const parent = dirname(head)
      if (parent === head) return path
      rest.unshift(basename(head))
      head = parent
    }
  }
}

/**
 * The `details` a withheld read or search result keeps: its number and boolean fields (counts, limits, flags), and
 * nothing else. omp persists a tool result's details in the session file (session/session-manager.ts appendMessage)
 * and the TUI renders from them (`displayContent`), so the matching lines, find's snippets, the diff, the path lists
 * that name the denied file and the spill link in `meta` must not outlive the withhold. Always an object: omp keeps
 * the original details when a handler returns undefined or null for them (extensibility/extensions/wrapper.ts:548,
 * `resultResult.details ?? result.details`).
 */
const withheldDetails = (d: unknown): Record<string, number | boolean> =>
  Object.fromEntries(
    Object.entries(typeof d === "object" && d !== null && !Array.isArray(d) ? d : {}).filter(
      ([, v]) => typeof v === "number" || typeof v === "boolean",
    ),
  )

/** The paths a search result's `details` lists (the search post-check below names each field's omp source). */
const listedPaths = (d: any): string[] => {
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
  const paths = [...list(d?.files), ...[...list(d?.fileMatches), ...list(d?.fileReplacements)].map((m) => m?.path), ...list(d?.hits).map((h) => h?.rel)]
  // A `parseErrors` entry is `<path>: <error>` or `<pattern>: <path>: <error>`, and a path may hold ": " itself:
  // every segment and every leading join of them is a candidate, so the check over-matches.
  paths.push(...list(d?.parseErrors).flatMap((e) => (typeof e === "string" ? e.split(": ").flatMap((s, i, a) => [s, a.slice(0, i + 1).join(": ")]) : [])))
  return paths.filter((t): t is string => typeof t === "string")
}

/**
 * The entries a `read` of a directory can name: omp lists them to depth 2, hidden ones included and .gitignore
 * ignored (omp: tools/read.ts:3025-3054 #readDirectory, workspace-tree.ts:56-67 buildDirectoryTree). Every entry is
 * returned, past omp's 12-entry cap per child directory, so the check over-matches. An unreadable directory adds
 * nothing.
 */
const directoryEntries = (root: string): string[] => {
  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir).map((name) => join(dir, name))
    } catch {
      return []
    }
  }
  return entries(root).flatMap((entry) => [entry, ...entries(entry)])
}

interface Compressor {
  compressBash(text: string, commandHint?: string): string
  logStats(tool: string, before: string, after: string): void
}

// The time a gate script gets. Exported so omp/tests/test_gates.ts can hold it under omp's per-handler budget,
// EXTENSION_HANDLER_TIMEOUT_MS = 30_000 (omp: extensibility/extensions/runner.ts:136), a mirrored constant that
// docs/DESIGN.md, Version coupling, lists for re-checking on every omp upgrade.
export const GATE_TIMEOUT_MS = 20_000

// hooksDir and timeoutMs are test seams: the extension has no env knob for either. 20 s keeps the slowest gate
// inside omp's 30 s per-handler budget, past which omp fails the call closed.
// ecomono: the 20 s assumes omp's default extensionHandlers.toolCallTimeoutMs of 30 s (omp:
// extensibility/settings.ts:152-154). Ceiling: a user who lowers that setting below about 20 s turns a slow gate
// into a bash call failed CLOSED. Upgrade path: derive timeoutMs from the setting if extensions can ever read it.
export function ecomono(o: { repo: string; hooksDir?: string; timeoutMs?: number }) {
  const hooksDir = o.hooksDir ?? join(o.repo, "claude/hooks")
  const timeoutMs = o.timeoutMs ?? GATE_TIMEOUT_MS
  return (pi: ExtensionAPI): void => {
    // `onError`, when given, replaces the logger line for a caught fault; it must not throw.
    const safe =
      <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, onError?: (why: string, ...args: A) => void) =>
      async (...args: A): Promise<R | undefined> => {
        try {
          return await fn(...args)
        } catch (e) {
          const why = `handler failed: ${errText(e)}`
          if (onError) onError(why, ...args)
          else pi.logger.warn(`ecomono: ${why}`)
          return undefined
        }
      }

    // An event or ctx field that is not the shape omp OMP_TESTED sends (docs/DESIGN.md, Version coupling). The check
    // that reads it finds nothing and allows, so a renamed field would switch a gate off in silence: this says so,
    // once per kind per session. It still allows, because failing closed on a shape mismatch would brick every
    // session after an omp upgrade; the smoke (omp/tests/smoke.sh) is where the mismatch is meant to be caught.
    const drifted = new Set<string>()
    const drift = (kind: string, why: string): void => {
      if (drifted.has(kind)) return
      drifted.add(kind)
      pi.logger.warn(`ecomono: unexpected omp shape, ${kind}: ${why}; the check that reads it is skipped (tested on omp ${OMP_TESTED})`)
    }
    // ctx.agent.kind, the key of every main-session-only and subagent-only branch below. Anything but "main" or
    // "sub" makes all of them skip.
    const agentKind = (ctx: any): unknown => {
      const kind = ctx?.agent?.kind
      if (kind !== "main" && kind !== "sub") drift("ctx.agent.kind", `got ${String(kind)}, expected "main" or "sub"`)
      return kind
    }

    // A warning notice where there is a UI. A notify that throws is logged, never raised.
    const notify = (ctx: any, text: string): void => {
      try {
        ctx.ui.notify(text, "warning")
      } catch (e) {
        pi.logger.warn(`ecomono: notify failed: ${errText(e)}`)
      }
    }

    // Fail-open reporting, for the hook runner (which also appends the state log) and for faults found here.
    // Synchronous on purpose: runHook shields a report that throws but not one that returns a rejected promise.
    // Notify once per session, and only where there is a UI to notify.
    let notified = false
    const failOpen = (ctx: any, line: string): void => {
      pi.logger.warn(line)
      if (notified || !ctx?.hasUI) return
      notified = true
      notify(ctx, `ecomono gate failed open: see ${stateDir()}/`)
    }
    // A fault found here rather than in a gate script: the same report, plus a line in <stateDir>/<name>.log
    // written by the hook runner's own helper, so both kinds of fail-open leave the same trace. `name` is a file
    // name.
    const extensionFault = (ctx: any, name: string, why: string): void => logFailOpen(name, why, (l) => failOpen(ctx, l))

    // The `Bash(<literal>)` entries of Claude's deny list, whitespace-normalised, parsed on first use and
    // cached. Derived from the template rather than copied, so the two hosts cannot drift. A template that
    // cannot be read or parsed warns once and leaves the list empty.
    const normalize = (s: string) => s.trim().replace(/\s+/g, " ")
    let denyLiterals: string[] | undefined
    const literals = (): string[] => {
      if (denyLiterals === undefined) {
        denyLiterals = []
        try {
          const deny = JSON.parse(readFileSync(join(o.repo, "claude/settings.template.json"), "utf8"))?.permissions?.deny
          for (const entry of Array.isArray(deny) ? deny : []) {
            const m = typeof entry === "string" ? /^Bash\((.*)\)$/s.exec(entry) : null
            if (m) denyLiterals.push(normalize(m[1]))
          }
        } catch (e) {
          pi.logger.warn(
            `ecomono: bash deny literals disabled, cannot read claude/settings.template.json from ${o.repo}: ${errText(e)}`,
          )
        }
      }
      return denyLiterals
    }

    // The keys of opencode/opencode.json permission.read whose value is "deny" or "allow", in file order, each
    // compiled once and cached. Derived from the file rather than copied, so the three hosts cannot drift. A file
    // that cannot be read or parsed warns once and leaves the list empty: the gate then denies nothing.
    // OpenCode lets the last matching key win (opencode.ai/docs/permissions), so an "allow" after a "deny" carves
    // an exception out of it; deny() reads the list the same way. The file keeps its keys in byte order
    // (omp/tests/test_paths.ts holds it there), which is the order the Nix deploy hands OpenCode too:
    // builtins.toJSON sorts attribute names. Any other value ("ask", a typo) is skipped, so it can never lift a deny
    // before it. The `.env` templates are not such an exception: see templates() below.
    let denyGlobs: { glob: string; deny: boolean; matcher: { match(path: string): boolean } }[] | undefined
    const globs = () => {
      if (denyGlobs === undefined) {
        denyGlobs = []
        try {
          const read = JSON.parse(readFileSync(join(o.repo, "opencode/opencode.json"), "utf8"))?.permission?.read
          for (const [glob, value] of Object.entries(typeof read === "object" && read !== null ? read : {})) {
            if (value === "deny" || value === "allow") denyGlobs.push({ glob, deny: value === "deny", matcher: new Bun.Glob(glob) })
          }
        } catch (e) {
          denyGlobs = []
          pi.logger.warn(
            `ecomono: path deny disabled, cannot read opencode/opencode.json from ${o.repo}: ${errText(e)}`,
          )
        }
      }
      return denyGlobs
    }

    // The `.env` templates the bash gate lets through (`.env.example`, ...), from the `for benign in` line of
    // claude/hooks/secret-access-gate.sh, read on first use and cached, so the two gates share one list. deny() does
    // not deny a file whose name ends in one by that name; a directory glob still denies it through the "/x" probe.
    // They are not "allow" keys in opencode.json: OpenCode's `*` also matches "/" (packages/core/src/util/wildcard.ts)
    // and its last matching key wins, so an allow for `*.env.example` would lift `**/secrets/**` and `**/.ssh/**`
    // there too. OpenCode therefore denies the templates (docs/DESIGN.md, omp target > Handler contracts). A gate
    // script that cannot be read or has no such line warns once and leaves the list empty: the templates are then
    // denied as any `.env.*` is. Empty tokens (a doubled or trailing space) are dropped: every name ends in "".
    let benign: string[] | undefined
    const templates = (): string[] => {
      if (benign === undefined) {
        benign = []
        try {
          const gate = readFileSync(join(o.repo, "claude/hooks/secret-access-gate.sh"), "utf8")
          const line = /^for benign in (.+); do$/m.exec(gate)?.[1]
          if (!line) throw new Error("it has no `for benign in ...; do` line")
          benign = line.split(/\s+/).filter(Boolean)
        } catch (e) {
          pi.logger.warn(
            `ecomono: .env templates denied, cannot read them from claude/hooks/secret-access-gate.sh in ${o.repo}: ${errText(e)}`,
          )
        }
      }
      return benign
    }

    // Path deny (docs/DESIGN.md, omp target > Handler contracts) on already-collected values: the first value
    // whose parts, resolved against ctx.cwd, hit a deny glob, that is a probe whose last matching key is a "deny".
    // A glob without "/" matches the basename of the candidate; the others match the candidate without its leading
    // "/". Each candidate is also tested with "/x" appended, because `**/.ssh/**` does not match the directory
    // itself, only what is below it, and so is its symlink-resolved form (realish). Any probe that ends on a deny
    // is enough, so an allowed file inside a denied directory still meets that directory's glob through "/x". The
    // probe of a file named for a `.env` template (templates()) is the one that never denies: only its "/x" can.
    // Shared by the tool_call path gate, the task @-mention, taskFile and sourceSession checks and the read post-check, so a
    // target omp resolved gets the same verdict as one the model typed.
    // ecomono: the match is case-sensitive (Bun.Glob has no nocase option), so on a case-insensitive filesystem
    // `~/.SSH/id` or `.ENV` reads the file the glob means and passes. Ceiling: macOS and Windows hosts. Upgrade
    // path: lowercase the candidate and the glob keys on darwin and win32, or omp's tools.restrictedFolders.
    const deny = (ctx: any, values: string[]): { value: string; glob: string } | undefined => {
      const list = globs()
      if (!list.some((g) => g.deny)) return undefined
      for (const value of values) {
        for (const part of pathParts(value)) {
          const path = resolvePart(ctx.cwd, part)
          if (path === undefined) continue
          for (const candidate of candidates(path)) {
            const real = realish(candidate)
            for (const c of real === candidate ? [candidate] : [candidate, real]) {
              for (const probe of [c, `${c}/x`]) {
                const name = basename(probe)
                const last = list.findLast(({ glob, matcher }) =>
                  glob.includes("/") ? matcher.match(probe.replace(/^\//, "")) : matcher.match(name),
                )
                if (last?.deny && !(probe === c && templates().some((t) => name.endsWith(t)))) return { value, glob: last.glob }
              }
            }
          }
        }
      }
      return undefined
    }

    // The ecomono-memory tools an agent's own claude/agents/<name>.md may call, from its frontmatter `tools:`: the
    // `mcp__ecomono-memory__<tool>` entries, prefix stripped. Cached per name; null means "no restriction" (no
    // such file, which covers omp's bundled agents, /tan clones and the advisor, or a file with no or a null
    // `tools:`, which Claude reads as "inherits every tool"). The name is matched before it joins a path, so nothing
    // outside claude/agents is ever read.
    // The frontmatter is read the way omp reads it: the text between a leading `---` and the next `\n---`, parsed
    // with Bun.YAML (pi-utils frontmatter.ts parseFrontmatter), and `tools:` taken as a list or a comma-separated
    // string (discovery/helpers.ts parseArrayOrCSV, parseAgentFields). Any other non-null value is an empty
    // allowlist, as omp makes it: a malformed restriction must not widen access. A block Bun.YAML rejects is read
    // as omp's fallback reads it, one `key: value` line at a time with the value parsed on its own (pi-utils
    // frontmatter.ts), with a warning; omp/tests/test_contract.ts check (e) parses every agent file with Bun.YAML
    // and fails on one that does not parse.
    // ecomono: omp's other repairs are not mirrored: stripping leading and inline HTML comments, tabs to spaces,
    // quoting ambiguous plain scalars. Ceiling: a file that parses only after them is read differently here; one
    // that starts with `<!-- -->` has no frontmatter here, so its memory tools are unrestricted. Upgrade path:
    // call pi-utils parseFrontmatter if the extension can ever import it.
    const memoryTools = new Map<string, Set<string> | null>()
    const memoryAllowed = (name: string): Set<string> | null => {
      const cached = memoryTools.get(name)
      if (cached !== undefined) return cached
      let allowed: Set<string> | null = null
      if (/^[a-z0-9-]+$/.test(name)) {
        try {
          const text = readFileSync(join(o.repo, "claude/agents", `${name}.md`), "utf8").replace(/\r\n?/g, "\n")
          const close = text.startsWith("---") ? text.indexOf("\n---", 3) : -1
          const block = close < 0 ? "" : text.slice(4, close)
          let tools: unknown
          try {
            tools = (Bun.YAML.parse(block) as any)?.tools
          } catch (e) {
            pi.logger.warn(
              `ecomono: claude/agents/${name}.md frontmatter is not valid YAML (${errText(e)}); its tools: line is read on its own, as omp does`,
            )
            for (const line of block.split("\n")) {
              const raw = /^tools:\s*(.*)$/.exec(line)?.[1]?.trim()
              if (raw === undefined) continue
              // An empty value stays "", which restricts to nothing, as omp reads it (helpers.ts parseAgentFields).
              tools = raw
              if (raw === "") continue
              try {
                const v = Bun.YAML.parse(raw)
                if ((v !== null && typeof v !== "object") || Array.isArray(v)) tools = v
              } catch {
                // the raw string, as omp keeps it
              }
            }
          }
          if (tools != null) {
            const list = Array.isArray(tools) ? tools : typeof tools === "string" ? tools.split(",") : []
            allowed = new Set(
              list
                .filter((t): t is string => typeof t === "string")
                .map((t) => t.trim())
                .filter((t) => t.startsWith(MEMORY_TOOL_CLAUDE))
                .map((t) => t.slice(MEMORY_TOOL_CLAUDE.length)),
            )
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            pi.logger.warn(
              `ecomono: memory guard disabled for ${name}, cannot read or parse claude/agents/${name}.md from ${o.repo}: ${errText(e)}`,
            )
          }
        }
      }
      memoryTools.set(name, allowed)
      return allowed
    }

    // Skill registry refresh, same generator, flags and timeout as OpenCode's skill-registry.ts. Fire and forget: the
    // generator exits 0 under --quiet and a failure must never hold a prompt, so the promise is never awaited and
    // never rejects. Main session only: a subagent shares the parent's project and would only repeat the work.
    // A failed run warns once per session, since it runs on every prompt: pi.exec rejects when `node` is not on
    // PATH (an omp-only host can lack it) and resolves with `killed` or a non-zero code on a timeout or a crash
    // (omp: exec/exec.ts:41-64). `node` from PATH as in OpenCode; process.execPath is bun here.
    // ecomono: runs are not deduplicated, so a prompt during a slow refresh starts a second one. Add an in-flight
    // guard if overlapping runs ever cause harm.
    let refreshWarned = false
    const refreshFailed = (why: string): void => {
      if (refreshWarned) return
      refreshWarned = true
      pi.logger.warn(`ecomono: skill registry not refreshed: ${why}`)
    }
    const refresh = (ctx: any): void => {
      if (agentKind(ctx) !== "main") return
      pi.exec("node", [join(o.repo, "claude/hooks/ecomono-skill-registry.js"), "--quiet", "--cwd", ctx.cwd], {
        cwd: ctx.cwd,
        timeout: 30_000,
      })
        .then((r) => {
          if (r?.killed) refreshFailed("the generator timed out")
          else if (r?.code !== 0) refreshFailed(`the generator exited with ${r?.code}`)
        })
        .catch((e) => refreshFailed(e?.code === "ENOENT" ? "node not on PATH" : errText(e)))
    }

    const gate = (name: string, payload: unknown, cwd: string, ctx: any) =>
      runHook({
        name,
        script: join(hooksDir, `${name}.sh`),
        payload,
        cwd,
        timeoutMs,
        report: (line) => failOpen(ctx, line),
      })

    // Merges the gates' answers: any deny blocks; otherwise the asks go to the user, or, with nobody to ask,
    // block, except that a headless ask from check-diff-size alone is dropped. It is a nudge, and omp's headless
    // mode includes subagents, which Claude would prompt interactively. A confirm that rejects fails open like any
    // other fault: the tool_call handler's extensionFault reports it to the logger, the state log and the UI.
    const decide = async (ctx: any, results: { name: string; r: HookDecision | undefined }[]) => {
      const reasons = (kind: "deny" | "ask") =>
        results.filter(({ r }) => r?.decision === kind).map(({ r }) => r!.reason)
      const denied = reasons("deny")
      if (denied.length > 0) return { block: true, reason: denied.join("\n\n") }
      const asked = reasons("ask")
      if (asked.length === 0) return undefined
      const reason = asked.join("\n\n")
      if (ctx.hasUI) return (await ctx.ui.confirm("ecomono", reason)) ? undefined : { block: true, reason }
      if (results.every(({ name, r }) => r?.decision !== "ask" || name === "check-diff-size")) return undefined
      return { block: true, reason }
    }

    const runGates = async (names: string[], command: string, cwd: string, ctx: any) =>
      decide(
        ctx,
        await Promise.all(
          names.map(async (name) => ({ name, r: await gate(name, { tool_input: { command } }, cwd, ctx) })),
        ),
      )

    // A throw here (a rejected confirm, a malformed ctx) allows the call; it goes through extensionFault rather than
    // the plain logger line, because an unchecked call must leave the same trace as a gate that failed open.
    pi.on(
      "tool_call",
      safe(async (event: any, ctx: any) => {
        const input = event?.input
        if (typeof input !== "object" || input === null) return undefined

        if (event.toolName === "bash") {
          if (typeof input.command !== "string") return undefined
          const command: string = input.command
          const denied = literals()
          if (denied.length > 0) {
            for (const segment of command.split(/\|\||&&|[;|&\n]/).map(normalize)) {
              if (denied.includes(segment)) {
                return {
                  block: true,
                  reason: `Blocked: "${segment}" is on the deny list in claude/settings.template.json, which this omp extension enforces for bash.`,
                }
              }
            }
          }
          // A cwd that is an internal URL (skill://, local://, ...) has no host directory to run a script in, yet omp
          // still runs the command, in its embedded shell, which reads host files and runs external programs
          // (omp: tools/bash.ts:1127-1147; internal-urls/url-filesystem.ts:4-6,289-294,559). Such a call is judged
          // on the session cwd, like a call with no cwd: the secret gate reads only the command text, and the
          // delivery gates then judge the session repository, which can only err toward a block.
          const raw = typeof input.cwd === "string" ? input.cwd : ""
          const cwd = (raw ? ompPath(ctx.cwd, raw) : undefined) ?? ctx.cwd
          return runGates(["secret-access-gate", "check-diff-size", "review-receipt-gate"], command, cwd, ctx)
        }

        if (event.toolName === "github" && (input.op === "pr_create" || input.op === "pr_push")) {
          const command = input.op === "pr_create" ? "gh pr create" : "git push"
          return runGates(["check-diff-size", "review-receipt-gate"], command, ctx.cwd, ctx)
        }

        // Hard deny, no valve (neither host's read deny has one): the globs are opencode.json's own, the ones
        // OpenCode enforces natively on its read tool.
        // ecomono: the gate checks the roots a call names, never the walk beneath them. grep, glob, find, ast_grep
        // and ast_edit over a parent directory, a root with glob characters or no path at all can still reach a
        // denied file; the tool_result search post-check below withholds a result that lists one. Ceiling: it sees
        // the paths omp reports in `details`, nothing else. Upgrade path: omp's tools.restrictedFolders.
        // ecomono: ceiling, writes. This is a read guard (see the header), so a write to a denied file through a
        // call whose target this gate cannot see is accepted, in the same class as eval and debug, which read and
        // write anything. ast_edit only stages its edits: it runs as a dry run, returns the diff as a preview and
        // queues the apply, which runs when the model writes a reason to xd://resolve (omp: tools/ast-edit.ts:
        // 290-300,437-447; tools/resolve.ts). A pathless or parent-rooted ast_edit can therefore write a denied
        // file; the preview and the resolve result that list it are withheld (tool_result below), the write is not.
        // No tool_call can tell which staged preview a resolve applies: ast_edit runs as the xd://ast_edit device
        // by default, so its tool_call fires nested, after a resolve in the same message was already judged. Bash
        // outside the secret gate's patterns writes too. Upgrade path: astEdit.enabled: false, eval.py and
        // eval.js: false, debug.enabled: false, or omp's tools.restrictedFolders, an approval prompt for any call at
        // or below a listed folder.
        if (PATH_TOOLS.has(event.toolName)) {
          const values = [...strings(input.path), ...strings(input.paths)]
          if (event.toolName === "read" && values.length === 0) drift("read tool_call", "the input has no string path or paths")
          if (event.toolName === "edit") values.push(...editTargets(input))
          const hit = deny(ctx, values)
          if (!hit) return undefined
          return {
            block: true,
            reason: `Blocked: ${event.toolName} "${hit.value}" is denied by "${hit.glob}" in opencode/opencode.json (permission.read), which this omp extension enforces for path tools.`,
          }
        }

        // Every item with an agent goes through the judge gate; the script alone knows which agents are judges,
        // so there is no list of judge names here. The prompt is rebuilt from the two fields omp hands the child as
        // text: the batch `context` (its subagent system prompt, omp: task/executor.ts:3976,4786) and the item's
        // `task` (the initial prompt, executor.ts:2531), each in the form repairedTask gives, because omp repairs a
        // double-encoded field after this event and the heading is judged where the child reads it. `solutionSpace`
        // is left out on purpose: omp feeds it only to the auto-thinking classifier
        // (session/agent-session-types.ts:457), so a heading that sits only there never reaches the judge. omp drops
        // `context` when task.batch is off, but then it rejects a call that carries one (task/index.ts:235-247), so
        // no judge launches without it.
        // ecomono: an eval `agent()` spawn of a judge skips this gate. before_subagent_spawn carries no prompt
        // (omp: extensibility/extensions/types.ts:1174-1186), so there is nothing to hand the script. Upgrade
        // path: when such a spawn is observed, run the script with an empty prompt from before_subagent_spawn.
        // Before the judge gate, the path deny on the @-mentions of every item's `task`, whatever its agent: omp
        // reads each mentioned file into the child's first prompt with no tool_call (task/executor.ts:2498,2531;
        // session/agent-session.ts:8882-8891). `context` becomes the system prompt and is never scanned for
        // mentions, so it is not checked. fileMentions scans each `task` as typed and as repairedTask decodes it.
        // An item has two file fields. `taskFile` (setting task.file, off by default) is an absolute path or local://
        // URL whose contents omp reads at dispatch and hands the child as its `task` (task/index.ts:373-408).
        // `sourceSession` (the bundled seance agent, advertised by default: task.disabledAgents is []) names the omp
        // session a seance child forks: a value with `/` or `\`, or ending in `.jsonl`, is a path resolved against
        // cwd and read; any other is an id omp looks up in its own session directories, never a path the caller names
        // (task/seance.ts:110-132). Both paths are denied like a path tool's, top-level and per item; local:// is
        // skipped as an internal URL. The schema omp runs (createTaskSchema, task/types.ts:53-73,172-260) has no
        // other path field and deletes every other unknown key (`"+": "delete"`), so there is nothing else to deny.
        // ecomono: ceiling. A seance child loads no extensions (task/seance-policy.ts disableExtensionDiscovery), so
        // its read, grep and glob skip the path deny and its answer returns here as the task result. Upgrade path:
        // task.disabledAgents: ["seance"].
        // ecomono: ceiling. A taskFile's contents are read after this event, so their @-mentions and, for a judge,
        // their headings are not checked: a same-message write can change them after any check here. Upgrade path:
        // keep task.file off (omp's default), or omp's tools.restrictedFolders, which covers task files.
        // ecomono: other text omp sends through the same prompt path, such as the queued hidden next-turn messages
        // (session/agent-session.ts:9856-9871), has its mentions read too and is not seen here. Upgrade path: deny
        // their mentions at the event that carries them, if one is ever exposed to extensions.
        if (event.toolName === "task") {
          if (!Array.isArray(input.tasks) && typeof input.agent !== "string") drift("task tool_call", "the input has neither tasks[] nor a string agent")
          const items: unknown[] = Array.isArray(input.tasks) ? input.tasks : [input]
          const taskFile = deny(ctx, [input, ...items].flatMap((item: any) => strings(item?.taskFile)))
          if (taskFile) {
            return {
              block: true,
              reason: `Blocked: taskFile "${taskFile.value}" is denied by "${taskFile.glob}" in opencode/opencode.json (permission.read); omp reads a taskFile into the subagent's first prompt.`,
            }
          }
          const sources = [input, ...items].flatMap((item: any) => strings(item?.sourceSession).filter((s) => /[/\\]|\.jsonl$/.test(s.trim())))
          const sourceSession = deny(ctx, sources)
          if (sourceSession) {
            return {
              block: true,
              reason: `Blocked: sourceSession "${sourceSession.value}" is denied by "${sourceSession.glob}" in opencode/opencode.json (permission.read); omp reads a sourceSession path into a seance subagent.`,
            }
          }
          const mentions = items.flatMap((item: any) => (typeof item?.task === "string" ? fileMentions(item.task) : []))
          const mentioned = deny(ctx, mentions)
          if (mentioned) {
            return {
              block: true,
              reason: `Blocked: task mention "@${mentioned.value}" is denied by "${mentioned.glob}" in opencode/opencode.json (permission.read); omp reads @-mentioned files into the subagent's first prompt.`,
            }
          }
          const name = "judge-standards-gate"
          const results = await Promise.all(
            items.flatMap((item: any) => {
              if (typeof item?.agent !== "string") return []
              // The fields as the child gets them: each one through omp's own double-encoding repair (repairedTask).
              const prompt = [input.context, item.task]
                .filter((s): s is string => typeof s === "string" && s !== "")
                .map(repairedTask)
                .join("\n")
              // omp trims the agent name before the lookup (task/index.ts spawnParamsFor), and the script matches
              // it exactly, so a padded judge name would otherwise slip past.
              const payload = { tool_input: { subagent_type: item.agent.trim(), prompt } }
              return [gate(name, payload, ctx.cwd, ctx).then((r) => ({ name, r }))]
            }),
          )
          return decide(ctx, results)
        }

        // Memory write guard: Claude restricts a subagent to the memory tools its own `tools:` line lists, and omp
        // mounts every MCP tool on every agent, so the same line is enforced here. The tool arrives under its own
        // name even when the model reaches it through `write xd://mcp__ecomono_memory_<tool>`: omp fires a second
        // tool_call for the inner call (spike 2, docs/DESIGN.md, omp target > Spike results, row 2), so this one
        // branch covers both routes.
        if (typeof event.toolName === "string" && event.toolName.startsWith(MEMORY_TOOL)) {
          const agent = ctx?.agent
          if (agentKind(ctx) !== "sub") return undefined
          if (typeof agent.name !== "string") {
            drift("ctx.agent.name", `a subagent has no string name (got ${String(agent.name)}), so its memory guard is skipped`)
            return undefined
          }
          const allowed = memoryAllowed(agent.name)
          const tool = event.toolName.slice(MEMORY_TOOL.length)
          if (allowed === null || allowed.has(tool)) return undefined
          // A read is refused as well as a write, so the reason names the missing tools: entry, in the file's spelling.
          return {
            block: true,
            reason: `${agent.name}: memory tool ${MEMORY_TOOL_CLAUDE}${tool} is not listed in its tools: (claude/agents/${agent.name}.md); report it to the parent instead`,
          }
        }
        return undefined
      }, (why, _event, ctx) => extensionFault(ctx, "tool-call", why)),
    )

    // Loaded on first use and cached, also when loading fails: one warning per session, then pass-through.
    // Claude's hook is CommonJS and guards its CLI behind require.main, so loading it runs nothing.
    let compressor: Compressor | null | undefined
    const loadCompressor = (): Compressor | undefined => {
      if (compressor === undefined) {
        try {
          const m = createRequire(import.meta.url)(join(o.repo, "claude/hooks/ecomono-compress.js"))
          if (typeof m?.compressBash !== "function" || typeof m?.logStats !== "function") {
            throw new Error("it does not export compressBash and logStats")
          }
          compressor = m
        } catch (e) {
          compressor = null
          pi.logger.warn(
            `ecomono: bash compression disabled, cannot load claude/hooks/ecomono-compress.js from ${o.repo}: ${errText(e)}`,
          )
        }
      }
      return compressor ?? undefined
    }

    pi.on(
      "tool_result",
      safe(async (event: any, ctx: any) => {
        // Read post-check (docs/DESIGN.md, omp target > Handler contracts): omp resolves some reads to a file the model never named, and
        // reports where in `details`. A suffix match (`read prod` -> `secrets/prod`, omp: tools/read.ts:2053-2066,
        // details.suffixResolution.to) and the parts of a delimited list (details.displayReadTargets) never fire
        // their own tool_call, so the path gate cannot see them. `details.resolvedPath`, the absolute file omp read
        // (an internal URL's backing file included, tools/read.ts:830-835,2993), goes the same way. A directory read
        // (details.isDirectory) lists the entries below resolvedPath, the directory itself (tools/read.ts:3025-3054),
        // so they are re-listed (directoryEntries) and checked too. The targets go through the same deny check and a
        // match withholds the content. A result is never rewritten otherwise: hashline anchors feed `edit`.
        // A withhold names the glob, never the file, so the notice carries no path the model did not type. That keeps
        // the name out of this result; it does not stop the model learning that a denied file exists there, which the
        // withhold itself tells (ceiling (5) at the search post-check). `details` is replaced too (withheldDetails),
        // since omp persists it in the session file and the TUI renders the file from it.
        // ecomono: ceiling. An oversized read result is saved to artifact://N before tool_result fires (omp:
        // tools/output-meta.ts spill), and `read artifact://N` is an internal URL the path gate skips, so it can
        // still return the file; N is no longer shown to the model. Upgrade path: when such a read is observed,
        // record N from the replaced content's artifact link and deny `read artifact://N`.
        if (event?.toolName === "read") {
          const d = event.details
          const listed = Array.isArray(d?.displayReadTargets) ? d.displayReadTargets : []
          const targets = [d?.resolvedPath, d?.suffixResolution?.to, ...listed].filter((t): t is string => typeof t === "string")
          if (d?.isDirectory === true && typeof d.resolvedPath === "string") targets.push(...directoryEntries(d.resolvedPath))
          const hit = deny(ctx, targets)
          if (!hit) return undefined
          return {
            content: [
              {
                type: "text",
                text: `ecomono: read resolved to a file that ${hit.glob} in opencode/opencode.json denies; content withheld.`,
              },
            ],
            details: withheldDetails(d),
            isError: true,
          }
        }
        // Search post-check. The path gate sees only the roots a call names, so a grep with no `path`, or over a
        // parent directory, can list lines or names of a denied file below it. omp reports every path a search
        // result shows in `details`: `files` and `fileMatches[].path` (grep, ast_grep; paths relative to the session
        // cwd, absolute outside it; omp: tools/grep.ts:1287-1291, tools/ast-grep.ts:299,382), `files` (glob;
        // tools/glob.ts:349-350), `hits[].rel` (find, the semantic search; tools/jfind/index.ts:139-148) and `files`
        // and `fileReplacements[].path` (ast_edit, whose result holds the diff of every file it touched;
        // tools/ast-edit.ts:324-335,491-502), and `parseErrors` (ast_grep and ast_edit: every file that failed to
        // parse or to read, matched or not; tools/ast-grep.ts:270-295, tools/ast-edit.ts:303-330,498). They go
        // through the same deny check, and a match withholds the whole result, error results included (one that
        // still carries `details` is cut like any other): the text is not parsed per file. The notice and `details`
        // are cut as in the read post-check.
        // ecomono: ceilings. (1) The read post-check's artifact://N spill applies here too. (2) Only what omp lists in
        // `details` is checked, so a result whose `details` lacks those fields passes; a non-error result with none of
        // the four arrays, a shape omp 18.14.0 never sends, says so through drift(). (3) An ast_edit result is a
        // staged preview (dryRun: true): withholding it hides the diff, not the queued apply, which xd://resolve can
        // still run (the write ceiling at the tool_call path gate). (4) A tracked file under a deny glob (a fixture
        // `.pem`, a `secrets/` doc) withholds every repo-wide search that lists it; the notice asks for a narrower
        // `path`. (5) A withhold is itself a one-bit result: whether a pathless or parent-rooted grep, ast_grep, glob
        // or find is withheld tells the model that a denied file under the searched root exists and matches the
        // pattern it chose, so repeated calls can recover that file's content and, by narrowing `path`, its location.
        // A directory read's withhold tells the same of its entries. Upgrade path: omp's tools.restrictedFolders, an
        // approval prompt for any call at or below a folder and for a recursive search rooted above one (omp:
        // tools/approval.ts restrictedFolderReason), which blocks headless and so refuses such searches up front.
        // A settled preview: the write result of xd://resolve or xd://reject (details.xdev; tools/resolve.ts
        // runResolveInvocation) carries the source tool's apply or reject result in inner.sourceResultDetails (for
        // ast_edit, its `files` and `fileReplacements`), which goes through the same deny check as a search result;
        // a match withholds it.
        if (event?.toolName === "write") {
          const xdev = event.details?.xdev
          const hit = deny(ctx, listedPaths(xdev?.inner?.sourceResultDetails))
          if (!hit) return undefined
          return {
            content: [
              {
                type: "text",
                text: `ecomono: xd://${xdev.tool} listed a file that ${hit.glob} in opencode/opencode.json denies; result withheld. Its staged edits may already be written to that file.`,
              },
            ],
            details: withheldDetails(event.details),
            isError: true,
          }
        }
        if (SEARCH_RESULT_TOOLS.has(event?.toolName)) {
          const d = event.details
          if (event.isError !== true && ![d?.files, d?.fileMatches, d?.fileReplacements, d?.hits].some(Array.isArray)) {
            drift(`${event.toolName} tool_result`, "details has no files, fileMatches, fileReplacements or hits array")
          }
          const hit = deny(ctx, listedPaths(d))
          if (!hit) return undefined
          // Steering, not a guard: xd://resolve would still apply the staged preview (ceiling (3) above).
          const discard = event.toolName === "ast_edit" ? " Its edits stay staged: write a reason to xd://reject to discard them." : ""
          return {
            content: [
              {
                type: "text",
                text: `ecomono: ${event.toolName} listed a file that ${hit.glob} in opencode/opencode.json denies; result withheld. Narrow \`path\` or the pattern so the result lists no file that glob matches.${discard}`,
              },
            ],
            details: withheldDetails(d),
            isError: true,
          }
        }
        // shellMinimizer: coexist, not disabled. omp's minimizer runs inside the bash executor, before tool_result,
        // and only for commands it has a filter for; it keeps the raw bytes as an artifact. compressBash then sees
        // already-minimized text, usually short enough to pass through unchanged (no stats line). ecomono ships no
        // config.yml, so it does not turn an omp default off. Consequences: stats.jsonl under-counts savings on
        // minimized commands, and the "[raw output: artifact://N]" notice is peeled and re-appended like any other.
        if (event?.toolName !== "bash") return undefined
        // Eval-bridged results go back to a script, which must see them whole.
        if (/^(?:js|prelude)-/.test(String(event.toolCallId))) return undefined
        // Read per call, so a test or a user can flip it mid-session.
        if (process.env.ECOMONO_COMPRESS === "off") return undefined
        if (!Array.isArray(event.content) || typeof event.input !== "object" || event.input === null) return undefined

        const texts: string[] = []
        const rest: unknown[] = []
        for (const part of event.content) {
          if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
          else rest.push(part)
        }
        if (texts.length === 0) return undefined

        const c = loadCompressor()
        if (!c) return undefined

        const [body, tail] = peel(texts.join("\n"))
        const command = typeof event.input.command === "string" ? event.input.command : undefined
        // isError results are compressed too: a failing build's log is exactly the output worth trimming.
        const out = c.compressBash(body, command)
        if (out === body) return undefined
        c.logStats("omp.bash", body, out)
        // Image (and any other non-text) parts go after the text, in their original order.
        return { content: [{ type: "text", text: out + tail }, ...rest] }
      }),
    )

    // LLM summaries only: omp's snapcompact and shake modes ignore it.
    pi.on(
      "session.compacting",
      safe(() => (process.env.ECOMONO_COMPRESS === "off" ? undefined : { context: [STYLE] })),
    )

    // Tier routing. A bare tier word (the agents' frontmatter `model:`) becomes its role: a bare `sonnet` would
    // otherwise fuzzy-match whatever authenticated model comes first, so `[tier, @role]` cannot steer it. Silent
    // inheritance (no role, and the one pattern is exactly the main model) goes to @task instead of the main
    // model. Same rule for a task spawn and an eval agent(). Anything else is left alone: a role, and an explicit
    // model or task.agentModelOverrides entry that names a model other than the main one.
    // Spike 3 (docs/DESIGN.md, omp target > Spike results, row 3): the handler's `model` replacement was observed to
    // take effect, so no fallback was needed.
    // ecomono: ceiling. An override or explicit selector that is exactly the main model's `provider/id` reaches this
    // event as [mainModel] with modelRole undefined, identical to silent inheritance (the event carries no selection
    // source and extensions get no settings access), so it is rerouted to @task. Workaround: bind the override
    // through a role alias such as `@slow`, which sets modelRole. Upgrade path: use the selection source if omp adds
    // it to BeforeSubagentSpawnEvent.
    pi.on(
      "before_subagent_spawn",
      safe((event: any, ctx: any) => {
        const patterns = event?.patterns
        if (!Array.isArray(patterns)) {
          drift("before_subagent_spawn", "patterns is not an array")
          return undefined
        }
        if (patterns.length !== 1 || typeof patterns[0] !== "string") return undefined
        const pattern: string = patterns[0]
        const tier = pattern.toLowerCase()
        if (Object.hasOwn(TIER_ROLE, tier)) {
          const role = TIER_ROLE[tier as keyof typeof TIER_ROLE]
          return { model: role, note: `ecomono: ${tier} tier -> ${role}` }
        }
        if (!event.modelRole && ctx?.model && pattern === `${ctx.model.provider}/${ctx.model.id}`) {
          return { model: "@task", note: "ecomono: no model tier; routed to @task instead of the main model" }
        }
        return undefined
      }),
    )

    // Once per session, main agent only: a subagent's factory has its own closure and would repeat it.
    // Separate flags: one warning must not suppress the other.
    let skillsWarned = false
    let jqWarned = false
    // Where a startup fault is written besides the logger; the same directory runHook's fail-open lines go to.
    // Never throws: the file is a trace for headless runs, and a write failure must not cost the warning.
    const stateLog = (line: string): void => {
      try {
        const dir = stateDir()
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, "ecomono.log"), `${new Date().toISOString()} ${line}\n`)
      } catch {}
    }
    // Notify where there is a UI, else the logger. notify() keeps a throwing UI from skipping the refresh and the
    // widget that follow the jq warning in session_start.
    const warnOnce = (ctx: any, text: string): void => {
      if (ctx.hasUI) notify(ctx, text)
      else pi.logger.warn(text)
    }
    // The org-todo widget and its parser load here, on first use, and not at the top of the file: a static import
    // that fails (a missing or broken org-todo file) would fail the whole extension, and every gate with it. Its own
    // safe(), so a failed load or start costs the widget only, and the skills check after it still runs.
    const startWidget = safe(
      async (ctx: any) => {
        const [{ startOrgTodo }, core] = await Promise.all([
          import(join(o.repo, "omp/extensions/ecomono/org-todo.ts")),
          import(join(o.repo, "opencode/tui-plugins/org-todo/core.ts")),
        ])
        startOrgTodo(pi, ctx, core)
      },
      (why) => pi.logger.warn(`ecomono: org-todo widget not started: ${why}`),
    )
    pi.on(
      "session_start",
      safe(async (_event: any, ctx: any) => {
        if (agentKind(ctx) !== "main") return undefined
        // Checked before the skills guard below, which returns early on a healthy tree. Three gate scripts
        // (secret-access, review-receipt, judge-standards) exit 0 with no output when jq is missing, which
        // runHook reads as a deliberate allow and so reports nothing; check-diff-size.sh exits 127 and is
        // reported, but the cause is the same. Say it here, once, where nothing else would.
        // The gates spawn with this process's env (runHook), so its PATH is the one that matters. It is passed
        // explicitly because Bun.which does not see a PATH changed at runtime.
        if (!jqWarned && !Bun.which("jq", { PATH: process.env.PATH ?? "" })) {
          jqWarned = true
          const text =
            "ecomono: jq is not on PATH; the bash secret-path gate, the review gate, the judge gate and the diff-size reminder are disabled (they fail open without it)"
          stateLog(text)
          warnOnce(ctx, text)
        }
        refresh(ctx)
        // The org-todo widget, the counterpart of OpenCode's org-todo panel: the interactive main session only.
        if (ctx.mode === "tui" && ctx.hasUI) await startWidget(ctx)
        if (skillsWarned) return undefined
        // The remaining prose dependency: the ecomono-sdd-* commands and agents read ~/.claude/skills by path, and
        // omp reads skills only from ~/.agents/skills, so a missing tree is a silent half-working install.
        const shared = join(process.env.HOME || homedir(), ".claude/skills/ecomono-sdd-shared")
        if (existsSync(shared)) return undefined
        skillsWarned = true
        warnOnce(
          ctx,
          `ecomono: ${shared} is missing; the ecomono-sdd-* commands and agents read ~/.claude/skills, so run install.sh (or switch the home-manager config) to link it`,
        )
        return undefined
      }),
    )

    // Prompt capture (docs/DESIGN.md, omp target > Handler contracts), the counterpart of the prompt hook in opencode/plugins/memory.ts:108-117: the
    // same DB (WAL + busy_timeout) and the same ensureSession + savePrompt pair, the project taken from the cwd.
    // The storage modules load on first use and always dynamically, whatever spike 1 found (docs/DESIGN.md, omp
    // target > Spike results, row 1):
    // a storage failure (bun:sqlite, an unopenable DB) then costs the capture and never the extension and its
    // gates. The load result is cached, failure included, and the first fault warns once per session; a later
    // prompt still attempts the capture. As in OpenCode, the session_id a model passes to the MCP tools is not
    // joined to this omp session id.
    // ecomono: ceiling. before_agent_start (reason "prompt") also fires for the prompts omp sends on its own
    // behalf (the `.`/`c` continue key, plan execution, mode kickoffs, compaction and task prompts) and carries the
    // text only, with no synthetic or attribution field, so those are stored as if the user had typed them;
    // OpenCode's hook skips non-user text for that reason (memory.ts:109-114). A prompt template is stored as its
    // expanded body for the same reason: the event holds the already-transformed text. Upgrade path: capture from
    // `message_start` instead and keep `message.role === "user" && !message.synthetic && message.attribution !==
    // "agent"` (omp sends its own prompts as `developer` messages); omp/tests/fake-pi.ts must then accept the event.
    // Queued steer and follow-up messages reach one before_agent_start with their texts joined by a blank line
    // (omp: session/agent-session.ts:8578-8601), so N queued messages are stored as one row; the same upgrade path
    // stores them one by one.
    // ecomono: the storage modules report a few faults with console.error (db.ts when stat fails, observations.ts
    // for a stranded legacy project key), which draws over the TUI. Upgrade path: pass them a sink backed by
    // pi.logger if that is ever observed.
    // ecomono: a failed load is cached too (`storage ??=` keeps the null). Ceiling: after one failed load, for
    // example a checkout updated while omp runs, capture stays off until omp restarts. Upgrade path: clear `storage`
    // in the catch so the next prompt retries, still warning once.
    type Storage = { Sess: any; Prompts: any; Obs: any }
    let storage: Promise<Storage | null> | undefined
    let captureWarned = false
    const captureFailed = (e: unknown): void => {
      if (captureWarned) return
      captureWarned = true
      pi.logger.warn(`ecomono: prompt capture failed: ${errText(e)}`)
    }
    const loadStorage = (): Promise<Storage | null> =>
      (storage ??= (async () => {
        try {
          const dir = join(o.repo, "opencode/plugins/storage")
          const [Sess, Prompts, Obs] = await Promise.all([
            import(join(dir, "sessions.ts")),
            import(join(dir, "prompts.ts")),
            import(join(dir, "observations.ts")),
          ])
          return { Sess, Prompts, Obs }
        } catch (e) {
          captureFailed(e)
          return null
        }
      })())
    // The project key is read once per cwd: currentProject runs two synchronous git calls (no timeout) on omp's
    // event loop, before the prompt is sent, and a session's cwd is stable. OpenCode derives it once at plugin init.
    const projects = new Map<string, string>()
    const capture = async (event: any, ctx: any): Promise<void> => {
      if (agentKind(ctx) !== "main" || typeof event?.prompt !== "string") return
      const text = event.prompt.trim()
      if (!text) return
      const s = await loadStorage()
      if (!s) return
      try {
        const sid: string = ctx.sessionManager.getSessionId()
        let project = projects.get(ctx.cwd)
        if (project === undefined) projects.set(ctx.cwd, (project = s.Obs.currentProject(ctx.cwd).project))
        s.Sess.ensureSession(sid, project)
        s.Prompts.savePrompt(sid, text)
      } catch (e) {
        captureFailed(e)
      }
    }

    // The running omp against OMP_TESTED, main session only. The read and search post-checks read result `details`
    // fields by name that neither the smoke nor drift() covers (docs/DESIGN.md, Version coupling), so any omp
    // other than the tested one says so before any gate runs. It warns, never blocks. On a prompt, not in
    // session_start: in omp 18.14.0 `pi.pi` is a getter that requires the SDK index on first access (omp:
    // extensibility/extensions/loader.ts:211-213, extensibility/host-api.ts:3-6), about 50 ms measured in print mode
    // that would otherwise land on startup. Its own safe(), so a throwing getter costs this check and never the
    // refresh or the capture.
    const checkVersion = safe(
      (ctx: any) => {
        if (versionWarned || agentKind(ctx) !== "main") return
        const running = (pi as any).pi?.VERSION
        if (typeof running !== "string") return drift("pi.pi.VERSION", "not a string")
        if (running === OMP_TESTED) return
        versionWarned = true
        const text = `ecomono: tested on omp ${OMP_TESTED}, running ${running}; the gates read omp fields by name and may be off until omp/tests/smoke.sh passes (README.md, upgrade protocol)`
        stateLog(text)
        warnOnce(ctx, text)
      },
      (why) => pi.logger.warn(`ecomono: omp version not checked: ${why}`),
    )

    // Every prompt, so a skill added mid-session is in the registry by the next one, and so the prompt is saved.
    // A revive replays no prompt.
    pi.on(
      "before_agent_start",
      safe(async (event: any, ctx: any) => {
        if (event?.reason === "prompt") {
          await checkVersion(ctx)
          refresh(ctx)
          await capture(event, ctx)
        }
        return undefined
      }),
    )

    // Release the memory DB handle. Only a factory that loaded the storage modules has anything to close; db.ts
    // keeps one handle per process, and every module imported above shares it through the same resolved path.
    pi.on(
      "session_shutdown",
      safe(async () => {
        if (!(await storage)) return
        const { closeDb } = await import(join(o.repo, "opencode/plugins/storage/db.ts"))
        closeDb()
      }),
    )
  }
}

export default ecomono({ repo: REPO })
