/**
 * cave-compress — tool-output token compression for opencode (v2 plugin API).
 *
 * Replicates caveman-code's tool-output compression layer inside opencode via
 * the tool `execute.after` hook: opencode runs this hook AFTER a tool executes
 * and BEFORE the result is returned to the model, and the hook rewrites
 * `event.result.content` in place. Every large tool result (shell/read/grep/…)
 * is trimmed before it ever costs context tokens — the single highest-impact
 * layer of caveman-code's ~50% savings, brought to opencode without leaving
 * your host runtime.
 *
 * Layers implemented here:
 *   1. Per-tool head+tail budget truncation
 *   2. Structured (JSON/XML) semantic compression for shell output
 *   3. ANSI stripping + blank-line collapse + hard line-count truncation
 *   4. Read deduplication (re-reading an unchanged file returns a stub)
 *
 * v2 tool names: `shell` is aliased to `bash` at the hook boundary, so the
 * budgets, markers and stats records keep their v1 names. A `read` of a
 * directory gets the old `list` budget and is never deduplicated. `skill`
 * results pass through whole. There is no `multiedit`; `patch` invalidates the
 * files it names.
 *
 * Not reachable in v2 (accepted gaps):
 *   - Output that arrives as a synthetic session message never fires
 *     `execute.after`: background shells, shells the user moved to the
 *     background, user `!` commands and background subagent results
 *     (packages/core/src/tool/plugin/shell.ts:157-189,254-266). It reaches the
 *     model uncompressed.
 *   - Code Mode: MCP tools and the other `codemode` tools run inside one
 *     `execute` call, and each inner call fires the hooks with the outer call's
 *     sessionID and id. Inner results are skipped; the outer `execute` result is
 *     compressed once.
 *   - ECOMONO_COMPRESS and ECOMONO_COMPRESS_STATS are read from the managed
 *     background service's environment, frozen when it was spawned. A per-run
 *     `ECOMONO_COMPRESS=off opencode` only works with `--standalone`; otherwise
 *     export the variable and run `opencode service restart` from a login shell.
 *
 * Compaction: handled natively by opencode. This plugin only asks for a terse
 * summary style through the session `compaction` hook below, and drops the
 * session's read cache there.
 *
 * Not ported: the messages-transform layer (v1 experimental.chat.messages.transform,
 * v2 session `context` hook). Redundant here — tool outputs are already
 * compressed on entry by the `execute.after` hook, and native compaction drops
 * old ones, so a per-turn re-transform would cost latency for marginal gain.
 *
 * The pure helpers (budget truncation, blank collapse, char cap) live in
 * ./cave-compress/core.ts: opencode loads every top-level `.ts` file in
 * plugins/ as a plugin, while a subdirectory with no index/server entry is
 * skipped. The default export is the only plugin contract. They are ported from
 * @juliusbrussee/caveman-code (dist/core/cave-tool-compression.js and
 * cave-structured-compression.js), MIT licensed, © Julius Brussee. They are
 * self-contained (zero dependencies), so this plugin does NOT require
 * caveman-code to be installed. One deliberate ordering change from upstream:
 * structured compression runs BEFORE budget truncation (upstream runs it
 * after), because head+tail truncation makes JSON unparseable and would
 * reduce the structured pass to a no-op on exactly the large outputs where
 * it matters most.
 */
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { truncateWithToolBudget, collapseBlankLines, truncateLongOutput, truncateByChars } from "./cave-compress/core"

// ── Compression logic (ported from caveman-code, MIT) ───────────────────────

// Matches ESC-introduced ANSI/VT100 escape sequences (colors, cursor moves).
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~]|[@-_][0-9;]*[@-~]?|[@-_]|[0-9;]*m)/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "")
}


/** Full general pipeline: strip ANSI, collapse blanks, hard truncate by lines then chars. */
function compressCaveToolOutput(text: string): string {
  return truncateByChars(truncateLongOutput(collapseBlankLines(stripAnsi(text))))
}

// ── Structured (JSON/XML) compression (ported from caveman-code, MIT) ───────

type OutputFormat = "json" | "xml" | "text"

/**
 * Detect whether text is JSON, XML, or plain text.
 * Only triggers on outputs > 50 lines to avoid compressing small results.
 */
function detectOutputFormat(text: string): OutputFormat {
  const lines = text.split("\n")
  // Trigger on many lines OR a large single blob — minified JSON/XML arrives
  // on one line and would otherwise slip past a purely line-count gate.
  if (lines.length <= 50 && text.length <= 4000) return "text"
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed)
      return "json"
    } catch {
      // Could be truncated JSON — starts like JSON and ends like JSON.
      if (/^\s*[[{]/.test(trimmed) && /[}\]]\s*$/.test(text.trimEnd())) return "json"
    }
  }
  // HTML never goes to compressXml: a doctype or <html> opening, any case, with
  // a tag boundary so <htmlReport> stays XML (caveman 15ebd61).
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && !/^(<!doctype\s+html|<html[\s>/])/i.test(trimmed))) {
    if (trimmed.includes("</") || trimmed.includes("/>")) return "xml"
  }
  return "text"
}

/** Keywords commonly associated with specific JSON keys in CLI output. */
const COMMAND_KEY_HINTS: Record<string, string[]> = {
  "docker inspect": ["State", "Config", "NetworkSettings", "Mounts", "HostConfig"],
  "docker ps": ["Names", "Status", "Ports", "Image"],
  "npm ls": ["name", "version", "dependencies"],
  "package.json": ["name", "version", "scripts", "dependencies", "devDependencies"],
  tsconfig: ["compilerOptions", "include", "exclude"],
  kubectl: ["metadata", "spec", "status"],
  "aws ": ["Arn", "Name", "Status", "State", "Id"],
}

/** Extract likely relevant key names from the command that produced the output. */
function extractKeyHints(commandHint?: string): Set<string> {
  const hints = new Set<string>()
  if (!commandHint) return hints
  const lower = commandHint.toLowerCase()
  for (const [pattern, keys] of Object.entries(COMMAND_KEY_HINTS)) {
    if (lower.includes(pattern.toLowerCase())) for (const key of keys) hints.add(key)
  }
  return hints
}

/** Maximum depth to traverse when compressing JSON. */
const MAX_DEPTH = 4
/** Maximum array elements to keep before stubbing. */
const MAX_ARRAY_ELEMENTS = 3

/** Compress a parsed JSON value, keeping relevant keys and stubbing deep/large structures. */
function compressValue(value: unknown, relevantKeys: Set<string>, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    if (Array.isArray(value)) return `[Array(${value.length})]`
    if (typeof value === "object" && value !== null)
      return `{Object(${Object.keys(value).length} keys)}`
    return value
  }
  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY_ELEMENTS) {
      return value.map((item) => compressValue(item, relevantKeys, depth + 1))
    }
    const kept = value
      .slice(0, MAX_ARRAY_ELEMENTS)
      .map((item) => compressValue(item, relevantKeys, depth + 1))
    return [...kept, `... ${value.length - MAX_ARRAY_ELEMENTS} more items (${value.length} total)`]
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    // With key hints at the top levels, keep hinted keys and stub the rest.
    if (relevantKeys.size > 0 && depth <= 1) {
      const result: Record<string, unknown> = {}
      let kept = 0
      const omitted: string[] = []
      for (const key of keys) {
        if (relevantKeys.has(key)) {
          result[key] = compressValue(obj[key], relevantKeys, depth + 1)
          kept++
        } else {
          omitted.push(key)
        }
      }
      if (kept === 0) {
        // No hints matched — keep first 5 keys.
        for (const key of keys.slice(0, 5)) {
          result[key] = compressValue(obj[key], relevantKeys, depth + 1)
        }
        if (keys.length > 5) result["..."] = `${keys.length - 5} more keys omitted`
      } else if (omitted.length > 0) {
        result["..."] =
          `${omitted.length} keys omitted: ${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? "..." : ""}`
      }
      return result
    }
    // No hints or deeper level — keep first 8 keys.
    const maxKeys = 8
    const result: Record<string, unknown> = {}
    for (const key of keys.slice(0, maxKeys)) {
      result[key] = compressValue(obj[key], relevantKeys, depth + 1)
    }
    if (keys.length > maxKeys) result["..."] = `${keys.length - maxKeys} more keys omitted`
    return result
  }
  if (typeof value === "string" && value.length > 200) {
    return `${value.slice(0, 200)}... (${value.length} chars)`
  }
  return value
}

/**
 * Compress JSON text using semantic extraction. Keeps relevant keys based on
 * command context, stubs arrays and deep structures. Returns the original
 * text when it isn't valid JSON or compression doesn't pay for itself.
 */
function compressJson(text: string, commandHint?: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return text
  }
  const relevantKeys = extractKeyHints(commandHint)
  const result = JSON.stringify(compressValue(parsed, relevantKeys, 0), null, 2)
  const originalLines = text.split("\n").length
  const resultLines = result.split("\n").length
  if (resultLines >= originalLines * 0.6) return text
  const retainedInfo =
    relevantKeys.size > 0 ? `Keys retained: ${[...relevantKeys].join(", ")}` : "Top-level keys retained"
  return `${result}\n\n[JSON compressed: ${resultLines} of ${originalLines} lines. ${retainedInfo}]`
}

/** Compress XML by stripping xmlns boilerplate and collapsing repeated sibling elements. */
function compressXml(text: string): string {
  const lines = text.split("\n")
  const originalCount = lines.length
  const result: string[] = []
  let repetitionCount = 0
  let lastTagName = ""
  let skipping = false
  for (const line of lines) {
    const cleaned = line.replace(/\s+xmlns(?::\w+)?="[^"]*"/g, "")
    const tagMatch = cleaned.match(/^\s*<(\w+)[\s>]/)
    if (tagMatch) {
      const tagName = tagMatch[1]
      if (tagName === lastTagName) {
        repetitionCount++
        if (repetitionCount > 3) {
          if (!skipping) {
            result.push(`    ... (repeated <${tagName}> elements)`)
            skipping = true
          }
          continue
        }
      } else {
        if (skipping) {
          result.push(`    [${repetitionCount} total <${lastTagName}> elements]`)
          skipping = false
        }
        lastTagName = tagName
        repetitionCount = 1
      }
    }
    result.push(cleaned)
  }
  if (skipping) result.push(`    [${repetitionCount} total <${lastTagName}> elements]`)
  if (result.length >= originalCount * 0.6) return text
  return `${result.join("\n")}\n\n[XML compressed: ${result.length} of ${originalCount} lines]`
}

/**
 * Structured compression entry point. Only bash output is considered — other
 * tools have domain-specific formats better served by the budget pass.
 */
function compressStructuredOutput(text: string, toolName: string, commandHint?: string): string {
  if (toolName !== "bash") return text
  switch (detectOutputFormat(text)) {
    case "json":
      return compressJson(text, commandHint)
    case "xml":
      return compressXml(text)
    default:
      return text
  }
}

// ── Read deduplication (ported from caveman-code, MIT) ───────────────────────

/**
 * Content fingerprint: length + a hash of the whole text. Upstream's length +
 * first 256 chars stubbed a same-length edit past char 256 as "unchanged".
 */
function fingerprint(text: string): string {
  return `${text.length}:${Bun.hash(text)}`
}

// The session-scoped read cache itself lives in the plugin's setup closure,
// keyed by `${sessionID}:${absolute path}`. When the model re-reads an
// unchanged file, the full content is replaced with a one-line stub.
// Invalidated when the same path is edited, written or patched.
// ecomono: hard cap with oldest-entry eviction (Map preserves insertion order).
// Upgrade path if this ever shows pressure on a long-running server: real LRU
// (bump-to-recent on access) or a per-session TTL sweep.
const READ_CACHE_CAP = 500
// Same FIFO cap for the in-flight Code Mode `execute` call ids.
// ecomono: an `execute` that a later plugin's before hook rejects (loop-breaker
// sorts after this file), or that is interrupted, never fires `execute.after`,
// so its key stays until FIFO eviction. Harmless while call ids are unique: no
// later call in the session reuses it. Upgrade path: drop a session's keys on
// `session.prompt`; that adds a hook, so update test 1's registration set too.
const INNER_CAP = 500

const READ_TOOLS = new Set(["read"])
const WRITE_TOOLS = new Set(["edit", "write", "patch"])

// File headers of a patch's text, used when the patch failed and reported no
// `applied` list: a failed patch may still have written some of its files.
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

// ── Savings metrics (on by default, opt-out) ────────────────────────────────

// Every marker/summary this file splices into compressed output. All of them
// are bracketed annotations with a fixed shape, so scanning the final text for
// these exact patterns measures — rather than guesses — how many of the chars
// in `after` are overhead the mechanism itself added back, as opposed to real
// content that survived compression. Mirrors claude/hooks/ecomono-compress.js.
const OVERHEAD_PATTERNS = [
  /\[\.\.\. \d+ lines omitted \([^)]*\) \.\.\.\]/g, // truncateWithToolBudget / truncateLongOutput
  /\[\.\.\. \d+ chars omitted \(cave mode char cap\) \.\.\.\]/g, // truncateByChars
  /\[JSON compressed: [^\]]*\]/g, // compressJson
  /\[XML compressed: [^\]]*\]/g, // compressXml summary line
  /\[\d+ total <\w+> elements\]/g, // compressXml repeated-sibling collapse
  /\.\.\. \(repeated <\w+> elements\)/g, // compressXml repeated-sibling collapse
  /\[Array\(\d+\)\]/g, // compressValue depth-limit stub (array)
  /\{Object\(\d+ keys\)\}/g, // compressValue depth-limit stub (object)
  /\.\.\. \d+ more items \(\d+ total\)/g, // compressValue array truncation
  /\d+ keys omitted: [^"\n]*/g, // compressValue key-hint omission list
  /\d+ more keys omitted/g, // compressValue key-count truncation
  /\.\.\. \(\d+ chars\)/g, // compressValue string truncation suffix
]

function measureOverheadChars(text: string): number {
  let total = 0
  for (const re of OVERHEAD_PATTERNS) {
    const matches = text.match(re)
    if (matches) for (const m of matches) total += m.length
  }
  return total
}

// On by default; set ECOMONO_COMPRESS_STATS=off to disable — same convention
// as the Claude-side hook (claude/hooks/ecomono-compress.js). Appends one JSONL
// record per compressed tool result to ~/.cache/ecomono-compress/stats.jsonl —
// the same file the Claude-side hook writes, so savings across both harnesses
// accumulate in one place. Local file only — never enters the model context,
// so it costs zero tokens.
//
// gross = before - after (the naive reduction, which silently counts the
// hook's own markers as "saved" chars since they're baked into `after`).
// overhead = measureOverheadChars(after) - measureOverheadChars(before),
// floored at 0: a marker-shaped run already present in the input appears on
// both sides and cancels, so only NET-NEW marker text counts as overhead — the
// naive measureOverheadChars(after) alone double-counts a pre-existing
// look-alike as overhead the hook added. net = gross - overhead: the honest
// number, negative when the markers added cost more than the truncation
// saved. Logged on every change now, not just size decreases, so net-negative
// runs show up instead of being silently dropped.
// ecomono: this still under-counts one case — a pre-existing look-alike that
// the truncation ITSELF removes (so it's absent from `after` but present in
// `before`) skews the subtraction negative and gets floored away, hiding real
// overhead elsewhere in the same string. Only provenance-tracking from the
// compression functions themselves (mark spans as they're inserted) closes
// that gap; not worth it for a best-effort metrics file. Summarize:
//   node -e 'let g=0,n=0;require("fs").readFileSync(process.env.HOME+"/.cache/ecomono-compress/stats.jsonl","utf8").trim().split("\n").forEach(l=>{let r=JSON.parse(l);g+=r.gross;n+=r.net});console.log(`gross ${g} chars, net ${n} chars (overhead ${g-n})`)'
const STATS_FILE = process.env.ECOMONO_COMPRESS_STATS === "off"
  ? null
  : `${process.env.XDG_CACHE_HOME ?? `${process.env.HOME}/.cache`}/ecomono-compress/stats.jsonl`
let statsDirReady: Promise<unknown> | null = null

async function logStats(tool: string, beforeText: string, afterText: string): Promise<void> {
  if (!STATS_FILE) return
  try {
    const before = beforeText.length
    const after = afterText.length
    const overhead = Math.max(0, measureOverheadChars(afterText) - measureOverheadChars(beforeText))
    const gross = before - after
    const net = gross - overhead
    if (!statsDirReady) {
      statsDirReady = mkdir(STATS_FILE.slice(0, STATS_FILE.lastIndexOf("/")), { recursive: true })
    }
    await statsDirReady
    await appendFile(
      STATS_FILE,
      `${JSON.stringify({ t: Date.now(), tool, in: before, out: after, gross, overhead, net })}\n`,
    )
  } catch {
    // Metrics are best-effort — never let a logging failure break the tool.
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

// Compaction summaries persist for the rest of the session and are re-sent
// every turn, so compressing their *style* pays off on every subsequent
// request. We only tighten style — substance (decisions, active files, task
// state, identifiers) must survive verbatim or session continuity breaks.
// v2 has no slot in the summary prompt itself (opencode appends it after the
// hooks run, packages/core/src/session/compaction.ts:283-292), so this goes in
// as a system part ahead of the transcript and weighs less than v1's prompt
// context did. It is additive: setting `event.result` instead would replace
// the native summary and its required section template.
const STYLE =
  "Write the summary in compressed ecomono style: drop articles, filler, and " +
  "hedging; fragments are fine; use short synonyms. Preserve ALL substance " +
  "verbatim — decisions made, files being worked on, task state, open problems, " +
  "and exact identifiers/paths/error strings. Compress the prose, never the facts. " +
  "Keep the required section headings unchanged."

export default {
  id: "cave-compress",
  async setup(ctx: any) {
    // Per-instance state: v2 runs one setup per opened location.
    const readCache = new Map<string, { fingerprint: string; readIndex: number }>()
    let readCount = 0
    // In-flight Code Mode `execute` calls. Their inner tool calls fire the
    // hooks with the outer call's sessionID and id.
    const inner = new Set<string>()
    const k = (e: any) => `${e.sessionID}\0${e.id}`
    const base: string = ctx.location.directory
    // ecomono: mirrors resolvePath in packages/core/src/file-access.ts:67-77 for
    // `~` and `~/` only, without its Windows path normalization. Upgrade path:
    // import the host helper if @opencode/plugin ever exports it.
    const abs = (p: string) =>
      resolve(base, p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p)
    const forget = (sessionID: string, p: unknown) => {
      if (typeof p === "string" && p !== "") readCache.delete(`${sessionID}:${abs(p)}`)
    }

    await ctx.tool.hook("execute.before", (e: any) => {
      if (e.tool !== "execute") return
      inner.add(k(e))
      if (inner.size > INNER_CAP) inner.delete(inner.values().next().value)
    })

    await ctx.tool.hook("execute.after", (e: any) => {
      // A throw here fails the tool call ("unexpected tool defect"), so
      // compression errors are swallowed and the result passes through.
      try {
        if (e.tool === "execute") inner.delete(k(e))
        else if (inner.has(k(e))) return // compressed once, as part of the outer `execute` result
        if (process.env.ECOMONO_COMPRESS === "off") return

        let tool = String(e.tool).toLowerCase()
        if (tool === "shell") tool = "bash"

        // Editing/writing/patching a file invalidates its cached read, on any
        // status: a failed patch may still have written some of its files.
        if (WRITE_TOOLS.has(tool)) {
          if (tool !== "patch") forget(e.sessionID, e.input?.path)
          for (const a of e.result?.output?.applied ?? []) forget(e.sessionID, a?.target)
          if (e.status === "error" && typeof e.input?.patchText === "string")
            for (const m of e.input.patchText.matchAll(PATCH_FILE_RE)) forget(e.sessionID, m[1].trim())
          return
        }
        if (e.status !== "completed" || tool === "skill") return

        const content = e.result?.content
        if (!Array.isArray(content)) return
        const nonText = content.filter((p: any) => p?.type !== "text")
        const originalText = content
          .filter((p: any) => p?.type === "text")
          .map((p: any) => p.text)
          .join("\n")
        if (originalText.length === 0) return
        const rewrite = (text: string) => {
          e.result.content = [{ type: "text", text }, ...nonText]
          void logStats(tool, originalText, text)
        }

        // v2 `read` also reads directories: give those the old `list` budget
        // and never deduplicate them.
        if (tool === "read" && originalText.startsWith("Read directory ")) tool = "list"

        // Re-reading an unchanged file → replace content with a stub. Only
        // text-only results: an image or PDF read keeps its file part. The key
        // is the absolute path so any spelling of it invalidates, while the
        // fingerprint covers the read header, which embeds the path as given:
        // a relative and an absolute read of one file never stub each other.
        const path = e.input?.path
        if (READ_TOOLS.has(tool) && typeof path === "string" && nonText.length === 0) {
          const key = `${e.sessionID}:${abs(path)}`
          const fp = fingerprint(originalText)
          const prev = readCache.get(key)
          if (prev && prev.fingerprint === fp) {
            rewrite(
              `[File unchanged since read #${prev.readIndex}. Content identical to a prior read this session — reference that context.]`,
            )
            return
          }
          readCount++
          if (!readCache.has(key) && readCache.size >= READ_CACHE_CAP) {
            const oldest = readCache.keys().next().value
            if (oldest !== undefined) readCache.delete(oldest)
          }
          readCache.set(key, { fingerprint: fp, readIndex: readCount })
        }

        // Structured (JSON/XML) semantic compression first — it needs the intact
        // output to parse — then per-tool budget truncation, then the general
        // compression pipeline.
        const command = e.input?.command
        const structured = compressStructuredOutput(
          originalText,
          tool,
          typeof command === "string" ? command : undefined,
        )
        const compressed = compressCaveToolOutput(truncateWithToolBudget(structured, tool))
        if (compressed !== originalText) rewrite(compressed)
      } catch {}
    })

    await ctx.session.hook("compaction", (ev: any) => {
      try {
        // The summary replaces the earlier reads, so a stub would point at
        // context the model no longer has.
        for (const key of readCache.keys()) if (key.startsWith(`${ev.sessionID}:`)) readCache.delete(key)
        if (process.env.ECOMONO_COMPRESS !== "off") ev.system.push({ type: "text", text: STYLE })
      } catch {}
    })
  },
}
