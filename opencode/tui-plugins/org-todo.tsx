// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// Node builtins: the Bun plugin runtime rejects top-level ESM imports of them.
const { execFile } = require("node:child_process")
const { homedir } = require("node:os")

const POLL_MS = 3000
const MAX_ROWS = 12
const MAX_CHARS = 48
const ORG = /^(\*+) (TODO|BLOCKED) (.*)$/
const MD = /^(\s*[-*] )\[ \] (.*)$/
const PATTERN = "^\\*+ (TODO|BLOCKED) |^[[:space:]]*[-*] \\[ \\] "

type Todo = { file: string; line: number; text: string; kind: "org" | "md"; src: string }

// Same parser as the Claude Code mod (claude/plugins/org-todo): the two runtimes share no module.
function parse(stdout: string, roots: string[]): Todo[] {
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

// ecomono: one grep per poll; a missing docs/ dir is silenced by -s.
function scan(dirs: string[]): Promise<Todo[]> {
  return new Promise((resolve) => {
    execFile(
      "grep",
      ["-rnHsE", "--include=*.org", "--include=*.md", PATTERN, ...dirs],
      { maxBuffer: 4 << 20 },
      (_err, stdout) => resolve(parse(String(stdout ?? ""), dirs)),
    )
  })
}

const Panel = (props: { api: any; dirs: string[] }) => {
  const [items, setItems] = createSignal<Todo[]>([])
  const tick = () => void scan(props.dirs).then(setItems)
  tick()
  const timer = setInterval(tick, POLL_MS)
  onCleanup(() => clearInterval(timer))
  const theme = () => props.api.theme.current
  const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS - 1) + "…" : s)

  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={theme().textMuted}>
        {items().length === 0 ? "no pending todos" : `todo ${items().length}`}
      </text>
      <For each={items().slice(0, MAX_ROWS)}>
        {(t) => (
          <box flexDirection="row" gap={1}>
            <text fg={theme().text}>{clip(t.text)}</text>
            <text fg={theme().textMuted}>{t.src}</text>
          </box>
        )}
      </For>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const orgDir = String(options?.orgDir ?? `${homedir()}/work/org`)
  const dirs = [`${process.cwd()}/docs`, orgDir]
  api.slots.register({
    order: 50,
    slots: {
      sidebar_content() {
        return <Panel api={api} dirs={dirs} />
      },
    },
  })
}

// ecomono: read-only here; completion lives in the Claude Code pane.
// Upgrade path: a `/todo-done <n>` command through api.command.
const plugin: TuiPluginModule & { id: string } = { id: "org-todo", tui }
export default plugin
