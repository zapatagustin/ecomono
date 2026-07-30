#!/usr/bin/env node
// ecomono-compress — Claude Code PostToolUse hook: compress large tool output (forked from ecomono-compress, MIT)
// before it costs context tokens.
//
// Ports the pure compression functions from the opencode cave-compress plugin
// (itself ported from @juliusbrussee/ecomono-code, MIT © Julius Brussee). The
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

// ── Compression logic (ported from ecomono-code, MIT) ───────────────────────

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
  return [
    ...head,
    "",
    `[... ${omitted} lines omitted (${toolName} budget: ${budget.maxLines}) ...]`,
    "",
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
  return text.replace(/(\r?\n){3,}/g, "\n\n");
}

/** Hard truncate to MAX_LINES with head+tail preservation. */
function truncateLongOutput(text) {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  return [...head, "", `[... ${omitted} lines omitted (cave mode truncation) ...]`, "", ...tail].join("\n");
}

/** Head+tail clamp by character count — the safety net for single-line blobs. */
function truncateByChars(text) {
  if (text.length <= MAX_CHARS) return text;
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n\n[... ${omitted} chars omitted (cave mode char cap) ...]\n\n${text.slice(text.length - TAIL_CHARS)}`;
}

/** Full general pipeline: strip ANSI, collapse blanks, hard truncate by lines then chars. */
function compressCaveToolOutput(text) {
  return truncateByChars(truncateLongOutput(collapseBlankLines(stripAnsi(text))));
}

// ── Structured (JSON/XML) compression (ported from ecomono-code, MIT) ───────

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

// Best-effort savings log: one JSON line per compressed stream. Lets you measure
// real impact and tune the per-tool budgets from data instead of guesswork.
// Synchronous so the write flushes before the short-lived hook process exits.
// Records char counts + tool + timestamp — never content. ECOMONO_COMPRESS_STATS=off
// disables. Read with:
//   node -e 'let i=0,o=0;require("fs").readFileSync(process.env.HOME+"/.cache/ecomono-compress/stats.jsonl","utf8").trim().split("\n").forEach(l=>{let r=JSON.parse(l);i+=r.in;o+=r.out});console.log(`saved ${Math.round(100-100*o/i)}% (${i}->${o} chars)`)'
const fs = require("fs");

function logStats(tool, before, after) {
  if (process.env.ECOMONO_COMPRESS_STATS === "off" || after >= before) return;
  try {
    const base = process.env.XDG_CACHE_HOME || `${process.env.HOME}/.cache`;
    const dir = `${base}/ecomono-compress`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(`${dir}/stats.jsonl`, `${JSON.stringify({ t: Date.now(), tool, in: before, out: after })}\n`);
  } catch {
    // Metrics are best-effort — never let a logging failure break the tool.
  }
}

// ── PostToolUse hook I/O ─────────────────────────────────────────────────────

// Emit nothing = safe passthrough (original tool result stays 100% intact).
function passthrough() {
  process.exit(0);
}

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

    if (outChanged) logStats("Bash.stdout", stdout.length, cOut.length);
    if (errChanged) logStats("Bash.stderr", stderr.length, cErr.length);

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
