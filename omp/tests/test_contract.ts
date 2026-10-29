// Shared-asset contract of the omp extension. Plain assert script. The extension runs, parses or imports files that
// other targets own (Claude's hooks, agents and commands, OpenCode's cores and config); this suite fails when one
// of them moves, gains a hook omp does not classify, or stops being safe for the way omp loads it. It reads the
// repo tree only: no omp, no network, no process is started.
import "./fake-pi.ts"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { CLAUDE_HOOKS, REPO, TIER_ROLE } from "../extensions/ecomono/index.ts"

const text = (rel: string) => readFileSync(join(REPO, rel), "utf8")
const names = (rel: string, ext: string) => readdirSync(join(REPO, rel)).filter((f) => f.endsWith(ext)).sort()

// ---- (a) every repo path the extension reads exists ---------------------------------------------------------

/**
 * Modules the extension loads in its own process. Check (b) holds them to the import rule. Append here to cover a
 * new one: it joins REPO_READS below, so check (a) follows.
 */
export const IMPORTED_MODULES = [
  "opencode/plugins/hook-runner/core.ts",
  "opencode/plugins/cave-compress/core.ts",
  "claude/hooks/ecomono-compress.js",
  "opencode/tui-plugins/org-todo/core.ts",
  // Loaded lazily by prompt capture (design.md 5.9); db.ts is imported again at session_shutdown to close it.
  "opencode/plugins/storage/sessions.ts",
  "opencode/plugins/storage/prompts.ts",
  "opencode/plugins/storage/observations.ts",
  "opencode/plugins/storage/db.ts",
]

/** Every repo-relative path the extension executes, parses or imports. Append here when it reads a new one. */
export const REPO_READS = [
  "claude/hooks/secret-access-gate.sh",
  "claude/hooks/check-diff-size.sh",
  "claude/hooks/review-receipt-gate.sh",
  "claude/hooks/judge-standards-gate.sh",
  "claude/hooks/ecomono-skill-registry.js",
  "claude/settings.template.json",
  "opencode/opencode.json",
  "claude/agents",
  "omp/extensions/ecomono/org-todo.ts",
  ...IMPORTED_MODULES,
]

for (const p of REPO_READS) assert.ok(existsSync(join(REPO, p)), `${p}: the extension reads this path and it does not exist`)

// ---- (b) the modules it imports across trees stay self-contained --------------------------------------------

/**
 * Every module specifier on an import, export-from, dynamic import or require line. The pattern is deliberately
 * loose: a quoted word after `from` in a comment is reported too, and over-reporting only fails the suite.
 */
const specifiers = (src: string): string[] => [...src.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!)

// A Node builtin (with or without the node: prefix), bun:*, or a module in the same directory. Anything else would
// resolve against the other target's tree (its node_modules, its layout) and break where that tree is not there.
const selfContained = (spec: string): boolean =>
  spec.startsWith("node:") || spec.startsWith("bun:") || builtinModules.includes(spec) || /^\.\/[^/]+$/.test(spec)

for (const p of IMPORTED_MODULES) {
  const specs = specifiers(text(p))
  for (const s of specs) {
    assert.ok(selfContained(s), `${p}: imports "${s}"; cross-tree modules may import only a Node builtin, bun:* or a same-directory module`)
  }
}
// The shared org-todo parser is held to more than the rule above: OpenCode loads it with require() under a plugin
// runtime of its own, so it may not import or require anything at all, not even a Node builtin.
{
  const core = "opencode/tui-plugins/org-todo/core.ts"
  assert.ok(IMPORTED_MODULES.includes(core), `${core} is not in IMPORTED_MODULES`)
  assert.deepEqual(specifiers(text(core)), [], `${core}: it must have no import or require at all`)
  assert.ok(!/\b(?:import|require)\b/.test(text(core)), `${core}: the word import or require appears in it`)
}
// The pattern must see imports at all, or the loop above would pass on an unreadable file.
assert.ok(specifiers(text(IMPORTED_MODULES[0]!)).length > 0, "specifiers() found no import in hook-runner/core.ts")
assert.deepEqual(specifiers(`import { a } from "./x"\nconst c = require('child_process')\nimport "bun:sqlite"\nimport("../y")`), [
  "./x",
  "child_process",
  "bun:sqlite",
  "../y",
])
assert.ok(!selfContained("../y") && !selfContained("./a/b") && !selfContained("left-pad"), "selfContained accepts a foreign module")

// ---- (c) every hook the Claude template registers has an omp disposition ------------------------------------

/** Every `command` string in a parsed settings subtree, whatever the nesting. */
const commands = (node: unknown): string[] =>
  typeof node !== "object" || node === null
    ? []
    : Object.entries(node).flatMap(([k, v]) => (k === "command" && typeof v === "string" ? [v] : commands(v)))

/** Basenames of the `.claude/hooks/<x>` scripts the template's hooks and statusLine run. */
function referenced(templateText: string): string[] {
  const t = JSON.parse(templateText)
  const found = [...commands(t.hooks), ...commands(t.statusLine)].flatMap((c) =>
    [...c.matchAll(/\.claude\/hooks\/([\w.-]+)/g)].map((m) => m[1]!),
  )
  return [...new Set(found)]
}

/** The referenced scripts CLAUDE_HOOKS lacks. */
const unclassified = (templateText: string): string[] => referenced(templateText).filter((n) => !Object.hasOwn(CLAUDE_HOOKS, n))

{
  const template = text("claude/settings.template.json")
  assert.deepEqual(unclassified(template), [], "claude/settings.template.json registers a hook that CLAUDE_HOOKS (omp/extensions/ecomono/index.ts) does not classify")

  // Guard: the scan sees the real hooks, so an empty result above cannot mean it found nothing.
  assert.deepEqual(referenced(template).sort(), Object.keys(CLAUDE_HOOKS).sort(), "CLAUDE_HOOKS and the template's hook scripts differ")

  // A fixture with one extra hook entry is reported by its basename.
  const fixture = JSON.parse(template)
  fixture.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "$HOME/.claude/hooks/new-gate.sh" }] })
  assert.deepEqual(unclassified(JSON.stringify(fixture)), ["new-gate.sh"], "the fixture's extra hook is not reported")
}

// ---- (d) the commands stay safe for omp's template renderer -------------------------------------------------

{
  const commandFiles = names("claude/commands", ".md")
  assert.ok(commandFiles.length > 0, "claude/commands has no .md file")
  for (const f of commandFiles) {
    const body = text(`claude/commands/${f}`)
    assert.ok(!body.includes("{{"), `claude/commands/${f}: contains "{{", which omp's Handlebars renderer would evaluate`)
    assert.ok(!/\$\d/.test(body), `claude/commands/${f}: contains "$" followed by a digit, which omp expands as a positional argument`)
    assert.ok(!body.includes("$@"), `claude/commands/${f}: contains "$@", which omp expands as all arguments ($ARGUMENTS is allowed)`)
  }
}

// ---- (e) the agents stay safe for omp's frontmatter parser and tier routing ---------------------------------

/** Top-level frontmatter keys. A value runs over its indented continuation lines, so `description: >` blocks read whole. */
function frontmatter(src: string): Record<string, string> {
  const lines = src.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return {}
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
  const out: Record<string, string> = {}
  let key = ""
  for (const l of lines.slice(1, end < 0 ? undefined : end)) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(l)
    if (m) {
      key = m[1]!
      out[key] = m[2]!.replace(/^[>|][+-]?$/, "")
    } else if (key && /^\s/.test(l)) out[key] = `${out[key]} ${l.trim()}`
  }
  for (const k of Object.keys(out)) out[k] = out[k]!.trim()
  return out
}

// WebFetch and WebSearch are accepted but dropped by omp (omp: sdk.ts:4252); the agent just has no web tools there.
const OMP_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write"])
const DROPPED_TOOLS = new Set(["WebFetch", "WebSearch"])

{
  const agentFiles = names("claude/agents", ".md")
  assert.ok(agentFiles.length > 0, "claude/agents has no .md file")
  for (const f of agentFiles) {
    const rel = `claude/agents/${f}`
    const fm = frontmatter(text(rel))
    assert.ok(fm.name, `${rel}: frontmatter has no name`)
    assert.ok(fm.description, `${rel}: frontmatter has no description`)
    assert.ok(
      Object.hasOwn(TIER_ROLE, fm.model ?? ""),
      `${rel}: frontmatter model "${fm.model}" is not a key of TIER_ROLE (${Object.keys(TIER_ROLE).join(", ")}), so no omp role stands for it`,
    )
    for (const tool of (fm.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
      assert.ok(
        OMP_TOOLS.has(tool) || DROPPED_TOOLS.has(tool) || tool.startsWith("mcp__ecomono-memory__"),
        `${rel}: tools entry "${tool}" is not one omp maps (Read, Grep, Glob, Bash, Edit, Write, mcp__ecomono-memory__*, WebFetch, WebSearch)`,
      )
    }
  }
  // The parser reads real files: a folded description and a tools line come through.
  const explore = frontmatter(text("claude/agents/ecomono-explore.md"))
  assert.equal(explore.name, "ecomono-explore")
  assert.ok(explore.description!.startsWith("Read-only exploration agent"), "frontmatter() lost the folded description")
  assert.equal(explore.tools, "Read, Grep, Glob, Bash")
}

console.log("test_contract: all assertions passed")
