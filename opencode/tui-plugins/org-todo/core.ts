// Pure todo parser shared by OpenCode's TUI plugin (../org-todo.tsx) and the omp extension
// (omp/extensions/ecomono/org-todo.ts). It has no module dependencies at all, so either runtime can load it
// from this tree; omp/tests/test_contract.ts fails when one is added. Do not put a plugin in this directory:
// cli.json lists TUI plugins by file, and nothing here is one.

export const ORG = /^(\*+) (TODO|BLOCKED) (.*)$/
export const MD = /^(\s*[-*] )\[ \] (.*)$/
export const PATTERN = "^\\*+ (TODO|BLOCKED) |^[[:space:]]*[-*] \\[ \\] "

export type Todo = { file: string; line: number; text: string; kind: "org" | "md"; src: string }

// OpenCode and omp share this parser (org-todo/core.ts); the Claude Code mod (claude/plugins/org-todo) keeps its own copy.
export function parse(stdout: string, roots: string[]): Todo[] {
  const out: Todo[] = []
  for (const line of stdout.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line)
    if (!m) continue
    const [, file, n, raw] = m
    const org = ORG.exec(raw)
    const md = org ? null : MD.exec(raw)
    if (!org && !md) continue
    const root = roots.find((r) => file.startsWith(r + "/")) ?? ""
    const text = org ? (org[2] === "BLOCKED" ? `BLOCKED: ${org[3]}` : org[3]) : md[2]
    out.push({
      file,
      line: Number(n),
      text: text.trim(),
      kind: org ? "org" : "md",
      src: root ? file.slice(root.length + 1) : file,
    })
  }
  return out
}
