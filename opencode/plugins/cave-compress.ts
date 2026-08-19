/**
 * cave-compress — tool-output token compression for opencode.
 *
 * Replicates caveman-code's tool-output compression layer inside opencode via
 * the `tool.execute.after` hook: opencode runs this hook AFTER a tool executes
 * and BEFORE the result is returned to the model, mutating `output.output` in
 * place. Every large tool result (bash/read/grep/…) is trimmed before it ever
 * costs context tokens — the single highest-impact layer of caveman-code's
 * ~50% savings, brought to opencode without leaving your host runtime.
 *
 * Layers implemented here:
 *   1. Per-tool head+tail budget truncation
 *   2. Structured (JSON/XML) semantic compression for bash output
 *   3. ANSI stripping + blank-line collapse + hard line-count truncation
 *   4. Read deduplication (re-reading an unchanged file returns a stub)
 *
 * Compaction: handled natively by opencode's `compaction` config (auto +
 * prune drops old tool outputs). This plugin only styles the compaction
 * summary terse via the `experimental.session.compacting` hook below.
 *
 * Not ported: the messages-transform layer (experimental.chat.messages.transform).
 * Redundant here — tool outputs are already compressed on entry by the
 * tool.execute.after hook, and native prune drops old ones at compaction, so a
 * per-turn re-transform would cost latency for marginal gain.
 *
 * The pure compression functions below are ported from
 * @juliusbrussee/caveman-code (dist/core/cave-tool-compression.js and
 * cave-structured-compression.js), MIT licensed, © Julius Brussee. They are
 * self-contained (zero dependencies), so this plugin does NOT require
 * caveman-code to be installed. One deliberate ordering change from upstream:
 * structured compression runs BEFORE budget truncation (upstream runs it
 * after), because head+tail truncation makes JSON unparseable and would
 * reduce the structured pass to a no-op on exactly the large outputs where
 * it matters most.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { appendFile, mkdir } from "node:fs/promises"

// ── Compression logic (ported from caveman-code, MIT) ───────────────────────

interface ToolBudget {
  maxLines: number
  headLines: number
  tailLines: number
}

/** Hard ceiling for the general truncation pass (post per-tool budget). */
const MAX_LINES = 500
const HEAD_LINES = 200
const TAIL_LINES = 100

/**
 * Character-based safety cap (local addition beyond upstream). All the
 * line-based budgets above miss a large output that arrives on ONE line —
 * minified JSON, HTML, or base64 from curl/webfetch — which is exactly the
 * most token-heavy kind. This final head+tail char clamp catches those leaks
 * regardless of newline count.
 */
const MAX_CHARS = 16000
const HEAD_CHARS = 10000
const TAIL_CHARS = 4000

/**
 * Per-tool line budgets. Keys are opencode tool ids (lowercased). A tool with
 * no entry uses FALLBACK_BUDGET. Values mirror caveman-code's defaults, with
 * opencode's `glob`/`list` mapped onto the old `find`/`ls` budgets.
 */
const DEFAULT_TOOL_BUDGETS: Record<string, ToolBudget> = {
  bash: { maxLines: 80, headLines: 50, tailLines: 30 },
  read: { maxLines: 300, headLines: 200, tailLines: 100 },
  grep: { maxLines: 120, headLines: 80, tailLines: 40 },
  glob: { maxLines: 60, headLines: 40, tailLines: 20 },
  list: { maxLines: 60, headLines: 40, tailLines: 20 },
}
const FALLBACK_BUDGET: ToolBudget = { maxLines: 150, headLines: 100, tailLines: 50 }

function getToolBudget(toolName: string): ToolBudget {
  return DEFAULT_TOOL_BUDGETS[toolName] ?? FALLBACK_BUDGET
}

/** Truncate with head+tail preservation using the per-tool budget. */
function truncateWithToolBudget(text: string, toolName: string): string {
  const budget = getToolBudget(toolName)
  const lines = text.split("\n")
  if (lines.length <= budget.maxLines) return text
  const omitted = lines.length - budget.headLines - budget.tailLines
  const head = lines.slice(0, budget.headLines)
  const tail = lines.slice(lines.length - budget.tailLines)
  return [
    ...head,
    "",
    `[... ${omitted} lines omitted (${toolName} budget: ${budget.maxLines}) ...]`,
    "",
    ...tail,
  ].join("\n")
}

// Matches ESC-introduced ANSI/VT100 escape sequences (colors, cursor moves).
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~]|[@-_][0-9;]*[@-~]?|[@-_]|[0-9;]*m)/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "")
}

/** Collapse 3+ consecutive blank lines into a single blank line. */
function collapseBlankLines(text: string): string {
  return text.replace(/(\r?\n){3,}/g, "\n\n")
}

/** Hard truncate to MAX_LINES with head+tail preservation. */
function truncateLongOutput(text: string): string {
  const lines = text.split("\n")
  if (lines.length <= MAX_LINES) return text
  const omitted = lines.length - HEAD_LINES - TAIL_LINES
  const head = lines.slice(0, HEAD_LINES)
  const tail = lines.slice(lines.length - TAIL_LINES)
  return [...head, "", `[... ${omitted} lines omitted (cave mode truncation) ...]`, "", ...tail].join(
    "\n",
  )
}

/** Head+tail clamp by character count — the safety net for single-line blobs. */
function truncateByChars(text: string): string {
  if (text.length <= MAX_CHARS) return text
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS
  return `${text.slice(0, HEAD_CHARS)}\n\n[... ${omitted} chars omitted (cave mode char cap) ...]\n\n${text.slice(text.length - TAIL_CHARS)}`
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
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && !trimmed.startsWith("<!DOCTYPE html"))) {
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
 * Lightweight content fingerprint: length + first 256 chars. Fast, and enough
 * to detect an unchanged file across re-reads.
 */
function fingerprint(text: string): string {
  return `${text.length}:${text.slice(0, 256)}`
}

// Session-scoped read cache keyed by `${sessionID}:${path}`. When the model
// re-reads an unchanged file, the full content is replaced with a one-line
// stub. Invalidated when the same path is edited or written.
const readCache = new Map<string, { fingerprint: string; readIndex: number }>()
let readCount = 0

// ecomono: hard cap with oldest-entry eviction (Map preserves insertion order).
// Upgrade path if this ever shows pressure on a long-running server: real LRU
// (bump-to-recent on access) or a per-session TTL sweep.
const READ_CACHE_CAP = 500

const READ_TOOLS = new Set(["read"])
const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

function argPath(args: unknown): string | undefined {
  const a = args as Record<string, unknown> | undefined
  const p = a?.filePath ?? a?.path ?? a?.file
  return typeof p === "string" ? p : undefined
}

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

export const CaveCompress: Plugin = async () => ({
  // Compaction summaries persist for the rest of the session and are re-sent
  // every turn, so compressing their *style* pays off on every subsequent
  // request. We only tighten style — substance (decisions, active files, task
  // state, identifiers) must survive verbatim or session continuity breaks.
  // Additive via output.context; we deliberately do NOT replace output.prompt,
  // which would drop opencode's built-in preservation instructions.
  "experimental.session.compacting": async (_input, output) => {
    if (process.env.ECOMONO_COMPRESS === "off") return
    output.context.push(
      "Write the summary in compressed ecomono style: drop articles, filler, and " +
        "hedging; fragments are fine; use short synonyms. Preserve ALL substance " +
        "verbatim — decisions made, files being worked on, task state, open problems, " +
        "and exact identifiers/paths/error strings. Compress the prose, never the facts.",
    )
  },

  "tool.execute.after": async (input, output) => {
    if (process.env.ECOMONO_COMPRESS === "off") return
    if (typeof output.output !== "string" || output.output.length === 0) return

    const tool = input.tool.toLowerCase()
    const path = argPath(input.args)
    const originalText = output.output

    // Editing/writing a file invalidates its cached read.
    if (WRITE_TOOLS.has(tool) && path) {
      readCache.delete(`${input.sessionID}:${path}`)
      return
    }

    // Re-reading an unchanged file → replace content with a stub.
    if (READ_TOOLS.has(tool) && path) {
      const key = `${input.sessionID}:${path}`
      const fp = fingerprint(output.output)
      const prev = readCache.get(key)
      if (prev && prev.fingerprint === fp) {
        output.output = `[File unchanged since read #${prev.readIndex}. Content identical to a prior read this session — reference that context.]`
        await logStats(tool, originalText, output.output)
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
    const command = (input.args as Record<string, unknown> | undefined)?.command
    const structured = compressStructuredOutput(
      output.output,
      tool,
      typeof command === "string" ? command : undefined,
    )
    const compressed = compressCaveToolOutput(truncateWithToolBudget(structured, tool))
    if (compressed !== output.output) {
      output.output = compressed
      await logStats(tool, originalText, output.output)
    }
  },
})
