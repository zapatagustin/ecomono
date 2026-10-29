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
  // Loaded lazily by prompt capture; db.ts is imported again at session_shutdown to close it.
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

  // Every hook entry is a command that runs a script under .claude/hooks, so referenced() cannot skip one in
  // silence: an entry without a string command (type prompt, say) or a command with another spelling would
  // otherwise be classified by nobody.
  const parsed = JSON.parse(template)
  for (const [event, groups] of Object.entries<any>(parsed.hooks)) {
    for (const [g, group] of groups.entries()) {
      for (const [h, entry] of (group?.hooks ?? []).entries()) {
        const where = `hooks.${event}[${g}].hooks[${h}] (${JSON.stringify(entry)})`
        assert.equal(typeof entry?.command, "string", `claude/settings.template.json ${where}: no string command, so no omp disposition can be checked`)
        assert.ok(entry.command.includes(".claude/hooks/"), `claude/settings.template.json ${where}: the command does not run a script under .claude/hooks`)
      }
    }
  }
  const status = parsed.statusLine?.command
  assert.ok(typeof status !== "string" || status.includes(".claude/hooks/"), `claude/settings.template.json statusLine (${status}): the command does not run a script under .claude/hooks`)

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

/**
 * The frontmatter of an agent file, parsed the way omp parses it (pi-utils frontmatter.ts: Bun.YAML.parse on the
 * block between the first two `---` lines), so a file omp cannot parse fails here, and a YAML list for `tools:`,
 * which omp accepts, does not.
 */
function frontmatter(src: string, rel: string): Record<string, unknown> {
  const lines = src.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return {}
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
  if (end < 0) return {}
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(lines.slice(1, end).join("\n"))
  } catch (e) {
    throw new Error(`${rel}: omp's frontmatter parser (Bun.YAML.parse) rejects it: ${e instanceof Error ? e.message : e}`)
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

/** A `tools:` value as omp's parseArrayOrCSV reads it: a comma-separated string or an array. */
const toolList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : []).map((t) => t.trim()).filter(Boolean)

// WebFetch and WebSearch are accepted but dropped by omp (omp: sdk.ts:4252); the agent just has no web tools there.
const OMP_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write"])
const DROPPED_TOOLS = new Set(["WebFetch", "WebSearch"])

{
  const agentFiles = names("claude/agents", ".md")
  assert.ok(agentFiles.length > 0, "claude/agents has no .md file")
  for (const f of agentFiles) {
    const rel = `claude/agents/${f}`
    const fm = frontmatter(text(rel), rel)
    assert.ok(fm.name && typeof fm.name === "string", `${rel}: frontmatter has no name`)
    assert.ok(fm.description, `${rel}: frontmatter has no description`)
    // memoryAllowed reads claude/agents/<omp's agent.name>.md, so a name that differs from the file silently turns
    // the memory guard off for that agent; omp reserves main and sub for its own sessions.
    assert.equal(fm.name, f.replace(/\.md$/, ""), `${rel}: frontmatter name "${fm.name}" differs from the file name, so the memory guard would not find this file`)
    assert.ok(!["main", "sub"].includes(fm.name.toLowerCase()), `${rel}: frontmatter name "${fm.name}" is reserved by omp`)
    assert.ok(
      typeof fm.model === "string" && Object.hasOwn(TIER_ROLE, fm.model),
      `${rel}: frontmatter model "${fm.model}" is not a key of TIER_ROLE (${Object.keys(TIER_ROLE).join(", ")}), so no omp role stands for it`,
    )
    for (const tool of toolList(fm.tools)) {
      assert.ok(
        OMP_TOOLS.has(tool) || DROPPED_TOOLS.has(tool) || tool.startsWith("mcp__ecomono-memory__"),
        `${rel}: tools entry "${tool}" is not one omp maps (Read, Grep, Glob, Bash, Edit, Write, mcp__ecomono-memory__*, WebFetch, WebSearch)`,
      )
    }
  }
  // The parser reads real files: a folded description and a tools line come through.
  const explore = frontmatter(text("claude/agents/ecomono-explore.md"), "claude/agents/ecomono-explore.md")
  assert.equal(explore.name, "ecomono-explore")
  assert.ok(String(explore.description).startsWith("Read-only exploration agent"), "frontmatter() lost the folded description")
  assert.deepEqual(toolList(explore.tools), ["Read", "Grep", "Glob", "Bash"])
  // Both spellings of tools: omp accepts, as one list.
  assert.deepEqual(toolList(frontmatter("---\nname: x\ntools:\n  - Read\n  - Grep\n---\n", "fixture").tools), ["Read", "Grep"])
  assert.throws(() => frontmatter("---\nname: [unclosed\n---\n", "fixture"), /Bun\.YAML\.parse/)
}

console.log("test_contract: all assertions passed")
