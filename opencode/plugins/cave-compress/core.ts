// Pure compression helpers for ../cave-compress.ts (ported from caveman-code, MIT).
// Ported from @juliusbrussee/caveman-code (dist/core/cave-tool-compression.js),
// MIT licensed, Copyright (c) Julius Brussee.
// They live in a subdirectory because opencode calls EVERY export of a top-level
// plugin file as a plugin factory, so pure helpers must not be exported from cave-compress.ts.

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
export function truncateWithToolBudget(text: string, toolName: string): string {
  const budget = getToolBudget(toolName)
  const lines = text.split("\n")
  if (lines.length <= budget.maxLines) return text
  const omitted = lines.length - budget.headLines - budget.tailLines
  const head = lines.slice(0, budget.headLines)
  const tail = lines.slice(lines.length - budget.tailLines)
  // Same reasoning as truncateLongOutput below: only the synthesized lines
  // need a \r appended — real lines already carry theirs from the split.
  const cr = isCrlfDominant(text) ? "\r" : ""
  return [
    ...head,
    cr,
    `[... ${omitted} lines omitted (${toolName} budget: ${budget.maxLines}) ...]${cr}`,
    cr,
    ...tail,
  ].join("\n")
}

/** Collapse 3+ consecutive blank lines into a single blank line. */
export function collapseBlankLines(text: string): string {
  // Reuse the run's own matched line-ending style (g1) for the collapsed
  // replacement instead of hardcoding "\n\n" — a hardcoded LF silently mixes
  // bare-LF blank lines into an otherwise-CRLF document. No cross-run
  // decision needed here: each run supplies its own style from the bytes
  // already present at that spot.
  // ecomono: ceiling — a mixed CRLF/LF blank run collapses to the LAST
  // captured ending (g1 is the final iteration of the repeated group), not
  // the dominant one across the run. Upgrade path: fall back to
  // isCrlfDominant(text) when a run mixes styles instead of trusting g1.
  return text.replace(/(\r\n|\n){3,}/g, (_m, g1: string) => g1 + g1)
}

/**
 * Whether CRLF is this text's dominant line-ending style (majority vote: CRLF
 * count * 2 > total newline count, since every CRLF also counts as an LF).
 * Used only to pick the style for a synthesized line this file inserts —
 * real content is never rewritten, so a minority style elsewhere is left
 * exactly as found.
 */
export function isCrlfDominant(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const totalNewlines = (text.match(/\n/g) ?? []).length
  return crlf * 2 > totalNewlines
}

/** Hard truncate to MAX_LINES with head+tail preservation. */
export function truncateLongOutput(text: string): string {
  const lines = text.split("\n")
  if (lines.length <= MAX_LINES) return text
  const omitted = lines.length - HEAD_LINES - TAIL_LINES
  const head = lines.slice(0, HEAD_LINES)
  const tail = lines.slice(lines.length - TAIL_LINES)
  // Real lines already carry their own trailing \r (split("\n") leaves it in
  // place) — only the synthesized separator/marker lines are new content, so
  // only they need a \r appended to match the file's dominant style. Without
  // this a CRLF file gets bare-LF lines spliced into the middle of it.
  const cr = isCrlfDominant(text) ? "\r" : ""
  return [
    ...head,
    cr,
    `[... ${omitted} lines omitted (cave mode truncation) ...]${cr}`,
    cr,
    ...tail,
  ].join("\n")
}

/** Head+tail clamp by character count — the safety net for single-line blobs. */
export function truncateByChars(text: string): string {
  if (text.length <= MAX_CHARS) return text
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS
  // Same reasoning as truncateLongOutput/truncateWithToolBudget: a hardcoded
  // \n\n splices bare-LF separators into an otherwise-CRLF blob.
  // ecomono: ceiling — raw char slicing can split a CRLF pair at the
  // boundary (the cut lands between \r and \n), leaving a bare \r or \n
  // dangling at the edge. Upgrade path: nudge the HEAD_CHARS/TAIL_CHARS
  // slice points to the nearest line boundary.
  const nl = isCrlfDominant(text) ? "\r\n\r\n" : "\n\n"
  return `${text.slice(0, HEAD_CHARS)}${nl}[... ${omitted} chars omitted (cave mode char cap) ...]${nl}${text.slice(text.length - TAIL_CHARS)}`
}
