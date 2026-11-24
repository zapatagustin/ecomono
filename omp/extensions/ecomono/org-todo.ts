/**
 * Open TODOs in omp: a count in the status line, and the `todo` tab of the side panel (panel/panel.ts), the
 * omp counterpart of opencode/tui-plugins/org-todo.tsx (display only) and of the Claude Code pane's done
 * hotkeys (claude/plugins/org-todo).
 *
 * index.ts starts it from the main TUI session and hands in the parser (opencode/tui-plugins/org-todo/core.ts,
 * shared with the OpenCode plugin), so this file imports nothing across trees. One grep per tick over
 * `<cwd>/docs` and the org directory, the same command the OpenCode panel runs; a missing directory is silenced by
 * -s. core.rank orders the rows: the newest dated report of each directory only (from its listing), then the
 * most recently changed file first. The count goes to ctx.ui.setStatus as plain text: omp strips colors from
 * the `status` segment and draws it in the theme's accent.
 *
 * Nothing here imports @oh-my-pi/pi-tui: omp's loader would resolve it, the tests (plain Bun, no node_modules)
 * would not.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { readdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Action, Detail, DetailLine, Host, Row, Tab } from "./panel/model.ts"

type Todo = { file: string; line: number; text: string; kind: "org" | "md"; src: string }

/** What the extension takes from org-todo/core.ts. */
export interface OrgTodoCore {
  parse(stdout: string, roots: string[]): Todo[]
  rank(todos: Todo[], mtime: (file: string) => number, newest?: (dir: string) => string | undefined): Todo[]
  flipLine(cur: string, t: Pick<Todo, "kind" | "text">): string | null
  PATTERN: string
}

/** What the tab takes from a running scan: the last ranked list, and a rescan that updates the status line. */
export interface OrgTodoHandle {
  todos(): Todo[]
  /** The latest scan was killed by its timeout: todos() still holds the older list, which is not current. */
  timedOut(): boolean
  refresh(): Promise<void>
}

const KEY = "org-todo"
const POLL_MS = 3000
/** Lines of the file shown on each side of the selected todo in the detail. */
const NEIGHBOURS = 3

/**
 * Tick once now, then every POLL_MS through ctx.setInterval (omp contains a throw there and clears the timer on
 * session_shutdown). Every failure leaves the previous status in place and is logged, once per kind and session;
 * nothing here rejects.
 * pi.exec resolves on a timeout instead of rejecting (omp: exec/exec.ts:34-56), with `killed` set and whatever
 * stdout came before the kill, so a killed grep is a failure too: its partial output is not the answer. The exit
 * code is not checked: `grep -s` exits 2 whenever one of the directories is missing, matches or not.
 * A file that cannot be stat'ed (gone between the grep and the stat) ranks as mtime 0, last.
 * ecomono: ticks are not deduplicated, so a grep slower than POLL_MS overlaps the next one; the exec timeout bounds
 * the pile-up. Any result newer than the last one applied is applied, so a slow scan still lands; only an older
 * one is dropped. Add an in-flight guard if a huge org directory ever makes that visible.
 */
export function startOrgTodo(pi: ExtensionAPI, ctx: any, core: OrgTodoCore): OrgTodoHandle {
  const orgDir = process.env.ECOMONO_ORG_DIR || join(homedir(), "work/org")
  const dirs = [`${ctx.cwd}/docs`, orgDir]
  // One warning per kind and session: a tick runs every POLL_MS, so a failure that repeats would otherwise flood the
  // log. Separate kinds, so a timeout does not hide a failure or the other way round.
  const warned = new Set<string>()
  const warnOnce = (kind: string, text: string): void => {
    if (warned.has(kind)) return
    warned.add(kind)
    pi.logger.warn(text)
  }
  const mtime = (file: string): number => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return 0
    }
  }
  /** The newest YYYY-MM-DD date among a directory's .md/.org files, open todo or not; a throw falls back in rank(). */
  const newest = (dir: string): string | undefined =>
    readdirSync(dir)
      .flatMap((name) => /^(\d{4}-\d{2}-\d{2})\.(md|org)$/.exec(name)?.[1] ?? [])
      .sort()
      .at(-1)
  let shown: Todo[] = []
  let timedOut = false
  // Scans are numbered: a result older than the last one applied (a slow grep that finished after a newer one) is
  // dropped; any newer one is applied, even while a later scan is still running.
  let latest = 0
  let applied = 0
  const tick = (): Promise<void> => {
    const mine = ++latest
    return pi.exec("grep", ["-rnHsE", "--include=*.org", "--include=*.md", core.PATTERN, ...dirs], {
      cwd: ctx.cwd,
      timeout: 10_000,
    })
      .then((result) => {
        if (mine < applied) return
        applied = mine
        if (result?.killed) {
          timedOut = true
          warnOnce("timeout", "ecomono: org-todo grep timed out; keeping the previous count")
          return
        }
        timedOut = false
        shown = core.rank(core.parse(String(result?.stdout ?? ""), dirs), mtime, newest)
        ctx.ui.setStatus(KEY, shown.length === 0 ? undefined : `todo ${shown.length}`)
      })
      .catch((e) => warnOnce("failure", `ecomono: org-todo tick failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  tick()
  ctx.setInterval(tick, POLL_MS)
  return { todos: () => shown, timedOut: () => timedOut, refresh: tick }
}

/**
 * Marks `t` done in its file, in place: writeFile follows a symlink and keeps the inode an editor is watching.
 * Refused, with the reason, when the file is not UTF-8 or the line no longer holds the todo the scan saw.
 * ecomono: an editor saving between the read and this write loses that save, the same window as the Claude
 * pane's flip. Compare the mtime before writing if that ever happens in practice.
 */
async function markDone(core: OrgTodoCore, t: Todo): Promise<string | null> {
  const body = await readFile(t.file, "utf8")
  // A decode that needed U+FFFD would write every such byte back as U+FFFD: refuse instead.
  if (body.includes("�")) return `org-todo: ${t.file} is not UTF-8; left unchanged`
  const lines = body.split("\n")
  const next = core.flipLine(lines[t.line - 1] ?? "", t)
  if (next === null) return `org-todo: ${t.src}:${t.line} changed on disk; rescanned`
  lines[t.line - 1] = next
  await writeFile(t.file, lines.join("\n"))
  return null
}

/**
 * The `todo` tab: the ranked todos grouped by source file, enter marks one done, e opens it in the editor. The
 * rows come from the scan's last list; a flip or a refusal rescans, so the rows follow the files.
 */
export function todoTab(core: OrgTodoCore, h: OrgTodoHandle, host: Host): Tab {
  const byId = (id: string): Todo | undefined => h.todos().find((t) => `${t.file}:${t.line}` === id)
  /** What `detail` shows before prefetch has read the file: the todo's own line, as the scan saw it. */
  const own = (t: Todo): DetailLine => ({ no: t.line, text: t.kind === "org" ? `* TODO ${t.text}` : `- [ ] ${t.text}`, kind: "hit" })
  const details = new Map<string, Detail>()
  return {
    name: "todo",
    title: () => (h.timedOut() ? "todo ?" : `todo ${h.todos().length}`),
    rows: (filter) => {
      // The old rows are not current once a scan was killed: say so instead of listing them.
      if (h.timedOut()) return [{ kind: "head", text: "búsqueda agotada (timeout)" }]
      const q = filter.toLowerCase()
      const rows: Row[] = []
      let last: string | undefined
      for (const t of h.todos()) {
        if (q && !t.text.toLowerCase().includes(q) && !t.src.toLowerCase().includes(q)) continue
        if (t.src !== last) {
          last = t.src
          rows.push({ kind: "head", text: t.src, right: String(h.todos().filter((x) => x.src === t.src).length) })
        }
        rows.push({ kind: "item", text: `○ ${t.text}`, right: `:${t.line}`, id: `${t.file}:${t.line}` })
      }
      return rows
    },
    detail: (id) => {
      const t = byId(id)
      return t ? (details.get(id) ?? { title: `${t.file}:${t.line}`, lines: [own(t)] }) : undefined
    },
    // The file's lines around the todo; a file that cannot be read keeps the todo's own line.
    prefetch: async (id) => {
      const t = byId(id)
      const body = t ? await readFile(t.file, "utf8").catch(() => undefined) : undefined
      if (!t || body === undefined) return
      const all = body.split("\n")
      // A final newline ends the last line; it does not start one more.
      if (all.at(-1) === "") all.pop()
      const lines: DetailLine[] = []
      for (let n = Math.max(1, t.line - NEIGHBOURS); n <= Math.min(all.length, t.line + NEIGHBOURS); n++) {
        lines.push(n === t.line ? own(t) : { no: n, text: all[n - 1]!.replace(/\r$/, "") })
      }
      details.set(id, { title: `${t.file}:${t.line}`, lines })
    },
    keys: [
      ["enter", "hecho"],
      ["e", "nvim"],
    ],
    act: async (key, id): Promise<Action> => {
      const t = byId(id)
      if (!t) return { kind: "refresh" }
      if (key === "e") {
        await host.openEditor(t.file, t.line)
        return { kind: "close" }
      }
      const refused = await markDone(core, t)
      // Either way the panel's `refresh` runs load(), which rescans: a flip shows its row gone, a refusal (the
      // line changed on disk, not UTF-8) shows the rows as they are now, with the reason said first.
      return refused ? { kind: "refresh", notice: refused } : { kind: "refresh" }
    },
    load: () => (details.clear(), h.refresh()),
  }
}
