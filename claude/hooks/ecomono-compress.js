#!/usr/bin/env node
// ecomono-compress — Claude Code PostToolUse hook: compress large tool output
// before it costs context tokens.
//
// Ports the pure compression functions from the opencode cave-compress plugin
// (itself ported from @juliusbrussee/caveman-code, MIT © Julius Brussee). The
// functions are self-contained (zero dependencies).
//
// BASH ONLY. Bash is the one built-in tool whose PostToolUse `tool_response`
// shape is documented ({ stdout, stderr, interrupted, isImage }), so we can
// safely emit `updatedToolOutput` mirroring it. Every other tool passes
// through untouched:
//   - Read/Grep/Glob/etc: PostToolUse Output schema is NOT documented. A wrong
//     shape on a built-in is silently ignored (original stands), but there's
//     no point emitting a guess.
//   - MCP tools: replacements are NOT schema-validated — a wrong shape would
//     corrupt what the model sees. We never touch them.
//
// Safe passthrough on ANY error or non-Bash tool: exit 0 emitting nothing,
// which leaves the original result 100% intact. Set ECOMONO_COMPRESS=off to
// disable entirely.

// ── Compression logic (ported from caveman-code, MIT) ───────────────────────

const MAX_LINES = 500;
const HEAD_LINES = 200;
const TAIL_LINES = 100;

const MAX_CHARS = 16000;
const HEAD_CHARS = 10000;
const TAIL_CHARS = 4000;

// Per-tool line budgets. Keys are lowercased tool ids. bash is the only one
// wired today; the rest are kept for faithful parity / future extension.
const DEFAULT_TOOL_BUDGETS = {
  bash: { maxLines: 80, headLines: 50, tailLines: 30 },
  read: { maxLines: 300, headLines: 200, tailLines: 100 },
  grep: { maxLines: 120, headLines: 80, tailLines: 40 },
  glob: { maxLines: 60, headLines: 40, tailLines: 20 },
  list: { maxLines: 60, headLines: 40, tailLines: 20 },
};
const FALLBACK_BUDGET = { maxLines: 150, headLines: 100, tailLines: 50 };

function getToolBudget(toolName) {
  return DEFAULT_TOOL_BUDGETS[toolName] ?? FALLBACK_BUDGET;
}

/** Truncate with head+tail preservation using the per-tool budget. */
function truncateWithToolBudget(text, toolName) {
  const budget = getToolBudget(toolName);
  const lines = text.split("\n");
  if (lines.length <= budget.maxLines) return text;
  const omitted = lines.length - budget.headLines - budget.tailLines;
  const head = lines.slice(0, budget.headLines);
  const tail = lines.slice(lines.length - budget.tailLines);
  // Same reasoning as truncateLongOutput below: only the synthesized lines
  // need a \r appended — real lines already carry theirs from the split.
  const cr = isCrlfDominant(text) ? "\r" : "";
  return [
    ...head,
    cr,
    `[... ${omitted} lines omitted (${toolName} budget: ${budget.maxLines}) ...]${cr}`,
    cr,
    ...tail,
  ].join("\n");
}

// Matches ESC-introduced ANSI/VT100 escape sequences (colors, cursor moves).
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;]*[ -/]*[@-~]|[@-Z\\-_]|[@-_][0-9;]*[@-~]?|[@-_]|[0-9;]*m)/g;

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Collapse 3+ consecutive blank lines into a single blank line. */
function collapseBlankLines(text) {
  // Reuse the run's own matched line-ending style (g1) for the collapsed
  // replacement instead of hardcoding "\n\n" — a hardcoded LF silently mixes
  // bare-LF blank lines into an otherwise-CRLF document. No cross-run
  // decision needed here: each run supplies its own style from the bytes
  // already present at that spot.
  // ecomono: ceiling — a mixed CRLF/LF blank run collapses to the LAST
  // captured ending (g1 is the final iteration of the repeated group), not
  // the dominant one across the run. Upgrade path: fall back to
  // isCrlfDominant(text) when a run mixes styles instead of trusting g1.
  return text.replace(/(\r\n|\n){3,}/g, (_m, g1) => g1 + g1);
}

/**
 * Whether CRLF is this text's dominant line-ending style (majority vote: CRLF
 * count * 2 > total newline count, since every CRLF also counts as an LF).
 * Used only to pick the style for a synthesized line this file inserts —
 * real content is never rewritten, so a minority style elsewhere is left
 * exactly as found.
 */
function isCrlfDominant(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const totalNewlines = (text.match(/\n/g) ?? []).length;
  return crlf * 2 > totalNewlines;
}

/** Hard truncate to MAX_LINES with head+tail preservation. */
function truncateLongOutput(text) {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  // Real lines already carry their own trailing \r (split("\n") leaves it in
  // place) — only the synthesized separator/marker lines are new content, so
  // only they need a \r appended to match the file's dominant style. Without
  // this a CRLF file gets bare-LF lines spliced into the middle of it.
  const cr = isCrlfDominant(text) ? "\r" : "";
  return [...head, cr, `[... ${omitted} lines omitted (cave mode truncation) ...]${cr}`, cr, ...tail].join("\n");
}

/** Head+tail clamp by character count — the safety net for single-line blobs. */
function truncateByChars(text) {
  if (text.length <= MAX_CHARS) return text;
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  // Same reasoning as truncateLongOutput/truncateWithToolBudget: a hardcoded
  // \n\n splices bare-LF separators into an otherwise-CRLF blob.
  // ecomono: ceiling — raw char slicing can split a CRLF pair at the
  // boundary (the cut lands between \r and \n), leaving a bare \r or \n
  // dangling at the edge. Upgrade path: nudge the HEAD_CHARS/TAIL_CHARS
  // slice points to the nearest line boundary.
  const nl = isCrlfDominant(text) ? "\r\n\r\n" : "\n\n";
  return `${text.slice(0, HEAD_CHARS)}${nl}[... ${omitted} chars omitted (cave mode char cap) ...]${nl}${text.slice(text.length - TAIL_CHARS)}`;
}

/** Full general pipeline: strip ANSI, collapse blanks, hard truncate by lines then chars. */
function compressCaveToolOutput(text) {
  return truncateByChars(truncateLongOutput(collapseBlankLines(stripAnsi(text))));
}

// ── Structured (JSON/XML) compression (ported from caveman-code, MIT) ───────

/**
 * Detect whether text is JSON, XML, or plain text.
 * Only triggers on outputs > 50 lines to avoid compressing small results.
 */
function detectOutputFormat(text) {
  const lines = text.split("\n");
  if (lines.length <= 50 && text.length <= 4000) return "text";
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      if (/^\s*[[{]/.test(trimmed) && /[}\]]\s*$/.test(text.trimEnd())) return "json";
    }
  }
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && !trimmed.startsWith("<!DOCTYPE html"))) {
    if (trimmed.includes("</") || trimmed.includes("/>")) return "xml";
  }
  return "text";
}

/** Keywords commonly associated with specific JSON keys in CLI output. */
const COMMAND_KEY_HINTS = {
  "docker inspect": ["State", "Config", "NetworkSettings", "Mounts", "HostConfig"],
  "docker ps": ["Names", "Status", "Ports", "Image"],
  "npm ls": ["name", "version", "dependencies"],
  "package.json": ["name", "version", "scripts", "dependencies", "devDependencies"],
  tsconfig: ["compilerOptions", "include", "exclude"],
  kubectl: ["metadata", "spec", "status"],
  "aws ": ["Arn", "Name", "Status", "State", "Id"],
};

/** Extract likely relevant key names from the command that produced the output. */
function extractKeyHints(commandHint) {
  const hints = new Set();
  if (!commandHint) return hints;
  const lower = commandHint.toLowerCase();
  for (const [pattern, keys] of Object.entries(COMMAND_KEY_HINTS)) {
    if (lower.includes(pattern.toLowerCase())) for (const key of keys) hints.add(key);
  }
  return hints;
}

const MAX_DEPTH = 4;
const MAX_ARRAY_ELEMENTS = 3;

/** Compress a parsed JSON value, keeping relevant keys and stubbing deep/large structures. */
function compressValue(value, relevantKeys, depth) {
  if (depth > MAX_DEPTH) {
    if (Array.isArray(value)) return `[Array(${value.length})]`;
    if (typeof value === "object" && value !== null) return `{Object(${Object.keys(value).length} keys)}`;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY_ELEMENTS) {
      return value.map((item) => compressValue(item, relevantKeys, depth + 1));
    }
    const kept = value.slice(0, MAX_ARRAY_ELEMENTS).map((item) => compressValue(item, relevantKeys, depth + 1));
    return [...kept, `... ${value.length - MAX_ARRAY_ELEMENTS} more items (${value.length} total)`];
  }
  if (typeof value === "object" && value !== null) {
    const obj = value;
    const keys = Object.keys(obj);
    if (relevantKeys.size > 0 && depth <= 1) {
      const result = {};
      let kept = 0;
      const omitted = [];
      for (const key of keys) {
        if (relevantKeys.has(key)) {
          result[key] = compressValue(obj[key], relevantKeys, depth + 1);
          kept++;
        } else {
          omitted.push(key);
        }
      }
      if (kept === 0) {
        for (const key of keys.slice(0, 5)) {
          result[key] = compressValue(obj[key], relevantKeys, depth + 1);
        }
        if (keys.length > 5) result["..."] = `${keys.length - 5} more keys omitted`;
      } else if (omitted.length > 0) {
        result["..."] = `${omitted.length} keys omitted: ${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? "..." : ""}`;
      }
      return result;
    }
    const maxKeys = 8;
    const result = {};
    for (const key of keys.slice(0, maxKeys)) {
      result[key] = compressValue(obj[key], relevantKeys, depth + 1);
    }
    if (keys.length > maxKeys) result["..."] = `${keys.length - maxKeys} more keys omitted`;
    return result;
  }
  if (typeof value === "string" && value.length > 200) {
    return `${value.slice(0, 200)}... (${value.length} chars)`;
  }
  return value;
}

/**
 * Compress JSON text using semantic extraction. Returns the original text when
 * it isn't valid JSON or compression doesn't pay for itself.
 */
function compressJson(text, commandHint) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return text;
  }
  const relevantKeys = extractKeyHints(commandHint);
  const result = JSON.stringify(compressValue(parsed, relevantKeys, 0), null, 2);
  const originalLines = text.split("\n").length;
  const resultLines = result.split("\n").length;
  if (resultLines >= originalLines * 0.6) return text;
  const retainedInfo =
    relevantKeys.size > 0 ? `Keys retained: ${[...relevantKeys].join(", ")}` : "Top-level keys retained";
  return `${result}\n\n[JSON compressed: ${resultLines} of ${originalLines} lines. ${retainedInfo}]`;
}

/** Compress XML by stripping xmlns boilerplate and collapsing repeated sibling elements. */
function compressXml(text) {
  const lines = text.split("\n");
  const originalCount = lines.length;
  const result = [];
  let repetitionCount = 0;
  let lastTagName = "";
  let skipping = false;
  for (const line of lines) {
    const cleaned = line.replace(/\s+xmlns(?::\w+)?="[^"]*"/g, "");
    const tagMatch = cleaned.match(/^\s*<(\w+)[\s>]/);
    if (tagMatch) {
      const tagName = tagMatch[1];
      if (tagName === lastTagName) {
        repetitionCount++;
        if (repetitionCount > 3) {
          if (!skipping) {
            result.push(`    ... (repeated <${tagName}> elements)`);
            skipping = true;
          }
          continue;
        }
      } else {
        if (skipping) {
          result.push(`    [${repetitionCount} total <${lastTagName}> elements]`);
          skipping = false;
        }
        lastTagName = tagName;
        repetitionCount = 1;
      }
    }
    result.push(cleaned);
  }
  if (skipping) result.push(`    [${repetitionCount} total <${lastTagName}> elements]`);
  if (result.length >= originalCount * 0.6) return text;
  return `${result.join("\n")}\n\n[XML compressed: ${result.length} of ${originalCount} lines]`;
}

/** Structured compression entry point. Only bash output is considered. */
function compressStructuredOutput(text, toolName, commandHint) {
  if (toolName !== "bash") return text;
  switch (detectOutputFormat(text)) {
    case "json":
      return compressJson(text, commandHint);
    case "xml":
      return compressXml(text);
    default:
      return text;
  }
}

/** Full Bash pipeline: structured first (needs intact text to parse), then budget, then general. */
function compressBash(text, commandHint) {
  const structured = compressStructuredOutput(text, "bash", commandHint);
  return compressCaveToolOutput(truncateWithToolBudget(structured, "bash"));
}

// ── Stats ────────────────────────────────────────────────────────────────────

// Every marker/summary this file splices into compressed output. All of them
// are bracketed annotations with a fixed shape, so scanning the final text for
// these exact patterns measures — rather than guesses — how many of the chars
// in `after` are overhead the mechanism itself added back, as opposed to real
// content that survived compression.
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
];

/** Sum the char length of every overhead marker found in the final text. */
function measureOverheadChars(text) {
  let total = 0;
  for (const re of OVERHEAD_PATTERNS) {
    const matches = text.match(re);
    if (matches) for (const m of matches) total += m.length;
  }
  return total;
}

// Best-effort savings log: one JSON line per compressed stream. Lets you measure
// real impact and tune the per-tool budgets from data instead of guesswork.
// Synchronous so the write flushes before the short-lived hook process exits.
// Records char counts + tool + timestamp — never content. ECOMONO_COMPRESS_STATS=off
// disables.
//
// gross = before - after (the naive reduction the old version reported, which
// silently counts the hook's own markers as "saved" chars since they're baked
// into `after`). overhead = measureOverheadChars(after) - measureOverheadChars(before),
// floored at 0: a marker-shaped run already present in the input appears on
// both sides and cancels, so only NET-NEW marker text counts as overhead — the
// naive measureOverheadChars(after) alone double-counts a pre-existing
// look-alike as overhead the hook added. net = gross - overhead: the honest
// number, which goes negative on a workload where the markers the hook adds
// cost more than the truncation it does. Logged on EVERY change now (not just
// size decreases), so net-negative runs show up instead of being silently
// dropped.
// ecomono: this still under-counts one case — a pre-existing look-alike that
// the truncation ITSELF removes (so it's absent from `after` but present in
// `before`) skews the subtraction negative and gets floored away, hiding real
// overhead elsewhere in the same string. Only provenance-tracking from the
// compression functions themselves (mark spans as they're inserted) closes
// that gap; not worth it for a best-effort metrics file. Read with:
//   node -e 'let g=0,n=0;require("fs").readFileSync(process.env.HOME+"/.cache/ecomono-compress/stats.jsonl","utf8").trim().split("\n").forEach(l=>{let r=JSON.parse(l);g+=r.gross;n+=r.net});console.log(`gross ${g} chars, net ${n} chars (overhead ${g-n})`)'
const fs = require("fs");

function logStats(tool, beforeText, afterText) {
  if (process.env.ECOMONO_COMPRESS_STATS === "off") return;
  try {
    const before = beforeText.length;
    const after = afterText.length;
    const overhead = Math.max(0, measureOverheadChars(afterText) - measureOverheadChars(beforeText));
    const gross = before - after;
    const net = gross - overhead;
    const base = process.env.XDG_CACHE_HOME || `${process.env.HOME}/.cache`;
    const dir = `${base}/ecomono-compress`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      `${dir}/stats.jsonl`,
      `${JSON.stringify({ t: Date.now(), tool, in: before, out: after, gross, overhead, net })}\n`,
    );
  } catch {
    // Metrics are best-effort — never let a logging failure break the tool.
  }
}

// ── PostToolUse hook I/O ─────────────────────────────────────────────────────

// Emit nothing = safe passthrough (original tool result stays 100% intact).
function passthrough() {
  process.exit(0);
}

function runHook() {
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    try {
    if (process.env.ECOMONO_COMPRESS === "off") return passthrough();

    const data = JSON.parse(input);

    // Bash only — the sole built-in with a documented PostToolUse output shape.
    if (data.tool_name !== "Bash") return passthrough();

    const resp = data.tool_response;
    if (!resp || typeof resp !== "object") return passthrough();

    const command =
      data.tool_input && typeof data.tool_input.command === "string" ? data.tool_input.command : undefined;

    // Compress both streams: builds, test runners, stacktraces and `curl -v`
    // dump their bulk to stderr, so stdout-only would miss the heaviest output.
    const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
    const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
    if (!stdout && !stderr) return passthrough();

    const cOut = stdout ? compressBash(stdout, command) : stdout;
    const cErr = stderr ? compressBash(stderr, command) : stderr;

    const outChanged = cOut !== stdout;
    const errChanged = cErr !== stderr;
    if (!outChanged && !errChanged) return passthrough();

    if (outChanged) logStats("Bash.stdout", stdout, cOut);
    if (errChanged) logStats("Bash.stderr", stderr, cErr);

    // Mirror the original tool_response shape exactly; only replace what changed.
    const updated = { ...resp };
    if (outChanged) updated.stdout = cOut;
    if (errChanged) updated.stderr = cErr;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: updated,
        },
      }),
    );
    process.exit(0);
  } catch {
    // Never break a tool result — any failure is a silent passthrough.
    passthrough();
  }
  });
}

// ── runnable check ──────────────────────────────────────────────────────────
function selftest() {
  const assert = require("assert");

  // No markers in plain text: overhead must be zero, so net collapses to gross.
  assert.strictEqual(measureOverheadChars("plain output, nothing truncated"), 0);

  // Each marker type this file can inject is measured for its exact length.
  const budgetMarker = "[... 42 lines omitted (bash budget: 80) ...]";
  assert.strictEqual(measureOverheadChars(`head\n\n${budgetMarker}\n\ntail`), budgetMarker.length);

  const charsMarker = "[... 7 chars omitted (cave mode char cap) ...]";
  assert.strictEqual(measureOverheadChars(charsMarker), charsMarker.length);

  const jsonMarker = "[JSON compressed: 3 of 10 lines. Top-level keys retained]";
  assert.strictEqual(measureOverheadChars(jsonMarker), jsonMarker.length);

  // compressJson splices its own stub text (e.g. an array-truncation marker)
  // in addition to its trailing summary line — both are overhead the hook
  // added, and measureOverheadChars must count the stub too, not just the
  // summary marker checked above.
  const jsonInput = JSON.stringify(
    { items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item-${i}-${"x".repeat(20)}` })) },
    null,
    2,
  );
  const jsonCompressed = compressJson(jsonInput, undefined);
  assert.notStrictEqual(jsonCompressed, jsonInput, "sanity: compressJson must actually compress this input");
  const itemsStubMatch = jsonCompressed.match(/\.\.\. \d+ more items \(\d+ total\)/);
  assert.ok(itemsStubMatch, "expected compressJson to splice an array-truncation stub");
  const summaryMatch = jsonCompressed.match(/\[JSON compressed: [^\]]*\]/);
  assert.ok(summaryMatch, "expected compressJson to splice its summary marker");
  assert.strictEqual(
    measureOverheadChars(jsonCompressed),
    itemsStubMatch[0].length + summaryMatch[0].length,
    "measureOverheadChars must count compressJson's own stub splices, not just its summary line",
  );

  const xmlSummary = "[XML compressed: 5 of 20 lines]";
  const xmlRepeat = "... (repeated <item> elements)";
  const xmlTotal = "[12 total <item> elements]";
  assert.strictEqual(
    measureOverheadChars(`${xmlSummary}\n    ${xmlRepeat}\n    ${xmlTotal}`),
    xmlSummary.length + xmlRepeat.length + xmlTotal.length,
  );

  // compressValue's key-omission stub is embedded inside a JSON string value
  // (quoted), so the regex intentionally stops at the closing quote rather
  // than matching past it — this locks in that current, deliberate behavior.
  const keysOmittedJson = `{"...":"3 keys omitted: foo, bar, baz"}`;
  const keysOmittedMarker = "3 keys omitted: foo, bar, baz";
  assert.strictEqual(measureOverheadChars(keysOmittedJson), keysOmittedMarker.length);

  // End-to-end: truncating 200 lines through the real bash budget must insert
  // exactly the marker measureOverheadChars detects — proving the measurement
  // tracks the actual pipeline, not just the synthetic strings above.
  const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const truncated = truncateWithToolBudget(longOutput, "bash");
  assert.ok(truncated.length < longOutput.length, "budget truncation must shrink output");
  const found = truncated.match(/\[\.\.\. \d+ lines omitted \(bash budget: 80\) \.\.\.\]/);
  assert.ok(found, "expected a budget-omission marker in truncated output");
  assert.strictEqual(measureOverheadChars(truncated), found[0].length);

  // Line-ending bug: the synthesized marker/blank lines used to hardcode a
  // bare "\n" join, splicing bare-LF lines into an otherwise-CRLF document.
  // In a CRLF-dominant input, the blank separators and the marker line
  // itself must all carry \r, matching the surrounding real lines.
  const crlfLongOutput = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n");
  const crlfTruncated = truncateWithToolBudget(crlfLongOutput, "bash");
  assert.ok(
    crlfTruncated.includes("\r\n\r\n[... 120 lines omitted (bash budget: 80) ...]\r\n\r\n"),
    "expected the marker line and its blank separators to carry \\r in a CRLF-dominant document",
  );
  const crlfCollapsed = collapseBlankLines("a\r\n\r\n\r\n\r\nb");
  assert.strictEqual(
    crlfCollapsed,
    "a\r\n\r\nb",
    "expected collapseBlankLines to reuse the run's own CRLF style, not hardcode LF",
  );

  // Same bug, truncateLongOutput: the only one of the four CRLF-fixed
  // functions with no coverage until now.
  const crlfLongOutputHard = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\r\n");
  const crlfTruncatedHard = truncateLongOutput(crlfLongOutputHard);
  assert.ok(crlfTruncatedHard.length < crlfLongOutputHard.length, "hard truncation must shrink CRLF output");
  assert.ok(
    crlfTruncatedHard.includes("\r\n\r\n[... 400 lines omitted (cave mode truncation) ...]\r\n\r\n"),
    "CRLF-dominant input: cave-mode truncation marker and its blank separators carry \\r",
  );

  // Same bug, truncateByChars: a CRLF-dominant blob over MAX_CHARS used to get
  // the synthesized "[... N chars omitted ...]" marker spliced with a bare
  // "\n\n" separator either side, even though every real newline around it is
  // "\r\n".
  const crlfCharsInput = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\r\n");
  const crlfCharsTruncated = truncateByChars(crlfCharsInput);
  assert.ok(crlfCharsTruncated.length < crlfCharsInput.length, "char-cap truncation must shrink output");
  assert.ok(
    /\r\n\r\n\[\.\.\. \d+ chars omitted \(cave mode char cap\) \.\.\.\]\r\n\r\n/.test(crlfCharsTruncated),
    "expected the chars marker and its blank separators to carry \\r in a CRLF-dominant document",
  );

  // gross/net honesty: net must equal gross minus the measured overhead, and
  // (net == gross) exactly when the hook added no markers at all.
  const before = "x".repeat(1000);
  const grossWithMarker = before.length - truncated.length;
  const netWithMarker = grossWithMarker - measureOverheadChars(truncated);
  assert.ok(netWithMarker < grossWithMarker, "net must be strictly less than gross when overhead > 0");

  const afterNoMarker = "y".repeat(50);
  const grossNoMarker = before.length - afterNoMarker.length;
  const netNoMarker = grossNoMarker - measureOverheadChars(afterNoMarker);
  assert.strictEqual(netNoMarker, grossNoMarker, "net must equal gross when the hook adds nothing");

  // A marker-shaped run already present in the INPUT (e.g. re-compressing
  // output that was already compressed once) must not be double-counted as
  // overhead the hook added: it appears on both sides of the subtraction and
  // cancels. Naive measureOverheadChars(after) alone would wrongly count it.
  const alreadyMarked = `${jsonMarker}\n${"a".repeat(50)}`;
  const passedThrough = compressBash(alreadyMarked, undefined);
  assert.strictEqual(
    passedThrough,
    alreadyMarked,
    "sanity: this small input must pass through the pipeline unchanged",
  );
  assert.strictEqual(
    measureOverheadChars(passedThrough),
    jsonMarker.length,
    "sanity: the naive measurement counts the pre-existing marker",
  );
  const netNewOverhead = Math.max(
    0,
    measureOverheadChars(passedThrough) - measureOverheadChars(alreadyMarked),
  );
  assert.strictEqual(netNewOverhead, 0, "net-new overhead must be 0 when the marker was already in the input");

  // Parity guard: the JS hook and the TS opencode plugin carry independent
  // copies of OVERHEAD_PATTERNS with no shared source. A future edit to one
  // that forgets the other silently desyncs overhead accounting between the
  // two harnesses. Skip (don't fail) when the sibling file isn't found — the
  // installed hook lives outside the repo and has no sibling to compare.
  const path = require("path");
  const tsPath = path.join(__dirname, "..", "..", "opencode", "plugins", "cave-compress.ts");
  if (fs.existsSync(tsPath)) {
    const tsBlock = extractOverheadPatternsBlock(fs.readFileSync(tsPath, "utf8"));
    const jsBlock = extractOverheadPatternsBlock(fs.readFileSync(__filename, "utf8"));
    assert.ok(tsBlock, "could not locate OVERHEAD_PATTERNS in cave-compress.ts");
    assert.ok(jsBlock, "could not locate OVERHEAD_PATTERNS in this file");
    assert.strictEqual(
      tsBlock,
      jsBlock,
      "OVERHEAD_PATTERNS has drifted between claude/hooks/ecomono-compress.js and opencode/plugins/cave-compress.ts — update both",
    );
  } else {
    console.log(
      "ecomono-compress selftest: skipping OVERHEAD_PATTERNS parity check (cave-compress.ts not found next to this repo checkout)",
    );
  }

  console.log("ecomono-compress selftest: all assertions passed");
}

// Extract the OVERHEAD_PATTERNS array body (one regex literal + comment per
// line) as whitespace-normalized text, so two independent copies of the array
// can be compared for drift regardless of incidental formatting differences.
function extractOverheadPatternsBlock(source) {
  const lines = source.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("const OVERHEAD_PATTERNS = ["));
  if (startIdx === -1) return null;
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "]" || trimmed === "];") return body.join("\n");
    body.push(trimmed.replace(/\s+/g, " "));
  }
  return null; // never closed — malformed, treat as not found
}

if (require.main === module) {
  if (process.argv.includes("--selftest")) selftest();
  else runHook();
}
