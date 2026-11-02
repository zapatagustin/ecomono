// Pure todo parser shared by OpenCode's TUI plugin (../org-todo.tsx) and the omp extension
// (omp/extensions/ecomono/org-todo.ts). It has no module dependencies at all, so either runtime can load it
// from this tree; omp/tests/test_contract.ts fails when one is added. Do not put a plugin in this directory:
// cli.json lists TUI plugins by file, and nothing here is one.

const ORG = /^(\*+) (TODO|BLOCKED) (.*)$/
const MD = /^(\s*[-*] )\[ \] (.*)$/
export const PATTERN = "^\\*+ (TODO|BLOCKED) |^[[:space:]]*[-*] \\[ \\] "

export type Todo = { file: string; line: number; text: string; kind: "org" | "md"; src: string }

/** The kind and text of an open todo line, as parse() reports them, or null when the line is not one. The "\r" of
 *  a CRLF file is not part of the line: `.` does not match it, so a `(.*)$` pattern misses every line of such a
 *  file (parse()'s location pattern takes it off with `\r?`). */
function classify(raw: string): Pick<Todo, "kind" | "text"> | null {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
  const org = ORG.exec(line)
  if (org) return { kind: "org", text: (org[2] === "BLOCKED" ? `BLOCKED: ${org[3]}` : org[3]).trim() }
  const md = MD.exec(line)
  return md ? { kind: "md", text: md[2].trim() } : null
}

// OpenCode and omp share this parser (org-todo/core.ts); the Claude Code mod (claude/plugins/org-todo) keeps its own copy.
export function parse(stdout: string, roots: string[]): Todo[] {
  const out: Todo[] = []
  for (const line of stdout.split("\n")) {
    const m = /^(.+?):(\d+):(.*)\r?$/.exec(line)
    if (!m) continue
    const [, file, n, raw] = m
    const todo = classify(raw)
    if (!todo) continue
    const root = roots.find((r) => file.startsWith(r + "/")) ?? ""
    out.push({ file, line: Number(n), ...todo, src: root ? file.slice(root.length + 1) : file })
  }
  return out
}

/** A dated file: a daily report or journal, superseded by the next one in its directory. */
const DATED = /^(\d{4}-\d{2}-\d{2})\.(md|org)$/

/** Dirname and basename on "/", without node:path: this file imports nothing (see the header). */
const split = (file: string): [string, string] => {
  const i = file.lastIndexOf("/")
  return [file.slice(0, i), file.slice(i + 1)]
}

/**
 * The todos worth showing first. A dated file (YYYY-MM-DD.md|org) counts only when no later date exists in its
 * directory, then the most recently changed file comes first; a tie keeps the input order (grep's). mtime is
 * asked once per file and may say 0 for a file it cannot stat. Undated files are never dropped.
 * `newest(dir)` is the newest date among the dated files the directory lists, whether or not they hold an open
 * todo, so a finished report hides the older ones; it is asked once per directory. A listing that throws or
 * finds no dated file leaves that directory to the dates of the todos themselves.
 */
export function rank(
  todos: Todo[],
  mtime: (file: string) => number,
  newest: (dir: string) => string | undefined = () => undefined,
): Todo[] {
  const latest = new Map<string, string>()
  const listed = new Set<string>()
  for (const { file } of todos) {
    const [dir, base] = split(file)
    if (!listed.has(dir)) {
      listed.add(dir)
      let date: string | undefined
      try {
        date = newest(dir)
      } catch {}
      if (date) latest.set(dir, date)
    }
    const own = DATED.exec(base)?.[1]
    if (own && own > (latest.get(dir) ?? "")) latest.set(dir, own)
  }
  const kept = todos.filter(({ file }) => {
    const [dir, base] = split(file)
    const date = DATED.exec(base)?.[1]
    return !date || date === latest.get(dir)
  })
  const at = new Map<string, number>()
  for (const { file } of kept) if (!at.has(file)) at.set(file, mtime(file))
  // Array.prototype.sort is stable, so equal mtimes keep grep's order.
  return kept.sort((a, b) => at.get(b.file)! - at.get(a.file)!)
}

/**
 * `cur` with its todo marked done (`* TODO x` and `* BLOCKED x` -> `* DONE x`, `- [ ] x` -> `- [x] x`), or null
 * when `cur` is no longer the open todo the scan saw: another kind, another text, already done, or gone. The guard
 * goes through classify(), so it compares exactly what parse() reported. A CRLF line keeps its "\r".
 */
export function flipLine(cur: string, t: Pick<Todo, "kind" | "text">): string | null {
  const now = classify(cur)
  if (!now || now.kind !== t.kind || now.text !== t.text) return null
  const cr = cur.endsWith("\r") ? "\r" : ""
  const line = cr ? cur.slice(0, -1) : cur
  return (t.kind === "org" ? line.replace(ORG, "$1 DONE $3") : line.replace(MD, "$1[x] $2")) + cr
}
