/**
 * Tests for the pure compression functions in ../cave-compress.ts.
 *
 * Scope: the CRLF-dominant handling added this session — isCrlfDominant itself,
 * and the three truncation/collapse functions that use it to pick a synthesized
 * separator's line-ending style instead of hardcoding LF. The JS hook
 * (claude/hooks/ecomono-compress.js) is the source these were ported from and
 * carries the equivalent assertions in its own `--selftest`; this file is the
 * TS-side twin so JS/TS parity stops being manual-only.
 */

import assert from "node:assert"

import {
  isCrlfDominant,
  collapseBlankLines,
  truncateWithToolBudget,
  truncateByChars,
  truncateLongOutput,
} from "../cave-compress"

// ── isCrlfDominant ───────────────────────────────────────────────────────────

assert.strictEqual(isCrlfDominant("a\r\nb\r\nc"), true, "all-CRLF text is CRLF-dominant")
assert.strictEqual(isCrlfDominant("a\nb\nc"), false, "all-LF text is not CRLF-dominant")
assert.strictEqual(isCrlfDominant("a\r\nb\nc\nd"), false, "minority CRLF is not dominant (1 of 3 newlines)")
assert.strictEqual(isCrlfDominant(""), false, "empty text is not CRLF-dominant")

// ── collapseBlankLines ───────────────────────────────────────────────────────

assert.strictEqual(collapseBlankLines("a\n\n\n\nb"), "a\n\nb", "LF: 3+ blank lines collapse to one")
assert.strictEqual(
  collapseBlankLines("a\r\n\r\n\r\n\r\nb"),
  "a\r\n\r\nb",
  "CRLF: collapsed separator reuses the run's own CRLF style, not hardcoded LF",
)

// ── truncateWithToolBudget ───────────────────────────────────────────────────

const longLf = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
const truncatedLf = truncateWithToolBudget(longLf, "bash")
assert.ok(truncatedLf.length < longLf.length, "budget truncation must shrink LF output")
assert.ok(
  truncatedLf.includes("\n\n[... 120 lines omitted (bash budget: 80) ...]\n\n"),
  "LF-dominant input gets a bare-LF marker and separators",
)

const longCrlf = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n")
const truncatedCrlf = truncateWithToolBudget(longCrlf, "bash")
assert.ok(truncatedCrlf.length < longCrlf.length, "budget truncation must shrink CRLF output")
assert.ok(
  truncatedCrlf.includes("\r\n\r\n[... 120 lines omitted (bash budget: 80) ...]\r\n\r\n"),
  "CRLF-dominant input: marker line and its blank separators carry \\r",
)

// ── truncateLongOutput ───────────────────────────────────────────────────────
// The only one of the four CRLF-fixed functions with no coverage until now.

const longOutputCrlf = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\r\n")
const truncatedOutputCrlf = truncateLongOutput(longOutputCrlf)
assert.ok(truncatedOutputCrlf.length < longOutputCrlf.length, "hard truncation must shrink CRLF output")
assert.ok(
  truncatedOutputCrlf.includes("\r\n\r\n[... 400 lines omitted (cave mode truncation) ...]\r\n\r\n"),
  "CRLF-dominant input: cave-mode truncation marker and its blank separators carry \\r",
)

// ── truncateByChars ──────────────────────────────────────────────────────────

const shortText = "x".repeat(100)
assert.strictEqual(truncateByChars(shortText), shortText, "text under MAX_CHARS passes through untouched")

const longLfChars = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n")
const truncatedLfChars = truncateByChars(longLfChars)
assert.ok(truncatedLfChars.length < longLfChars.length, "char-cap truncation must shrink LF output")
assert.ok(
  /\n\n\[\.\.\. \d+ chars omitted \(cave mode char cap\) \.\.\.\]\n\n/.test(truncatedLfChars),
  "LF-dominant input gets a bare-LF chars marker",
)

const longCrlfChars = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\r\n")
const truncatedCrlfChars = truncateByChars(longCrlfChars)
assert.ok(truncatedCrlfChars.length < longCrlfChars.length, "char-cap truncation must shrink CRLF output")
assert.ok(
  /\r\n\r\n\[\.\.\. \d+ chars omitted \(cave mode char cap\) \.\.\.\]\r\n\r\n/.test(truncatedCrlfChars),
  "CRLF-dominant input: chars marker and its blank separators carry \\r — this is the fix for the bug " +
    "where truncateByChars hardcoded a bare \\n\\n even into CRLF-dominant text",
)

console.log("test_cave_compress: all assertions passed")
