/**
 * Open TODOs below the omp editor, and a picker to act on them: the omp counterpart of
 * opencode/tui-plugins/org-todo.tsx (display only) and of the Claude Code pane's done hotkeys
 * (claude/plugins/org-todo).
 *
 * index.ts starts it from the main TUI session and hands in the parser (opencode/tui-plugins/org-todo/core.ts,
 * shared with the OpenCode plugin), so this file imports nothing across trees. One grep per tick over
 * `<cwd>/docs` and the org directory, the same command the OpenCode panel runs; a missing directory is silenced by
 * -s. core.rank orders the rows: the newest dated report of each directory (from its listing) only, then the most recently changed
 * file first. The widget is a `todo N` header and the first nine rows, the 10 lines omp gives a string widget.
 * A widget never gets keyboard focus in omp, so acting on a todo is the picker's job (openPicker, an overlay).
 *
 * Nothing here imports @oh-my-pi/pi-tui: omp's loader would resolve it, the tests (plain Bun, no node_modules)
 * would not. Bun.stringWidth and Intl.Segmenter measure, and the keybindings omp hands the overlay match keys.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { readdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

type Todo = { file: string; line: number; text: string; kind: "org" | "md"; src: string }

/** What the extension takes from org-todo/core.ts. */
export interface OrgTodoCore {
  parse(stdout: string, roots: string[]): Todo[]
  rank(todos: Todo[], mtime: (file: string) => number, newest: (dir: string) => string | undefined): Todo[]
  flipLine(cur: string, t: Pick<Todo, "kind" | "text">): string | null
  PATTERN: string
}

/** What the picker takes from a running widget: the last ranked list, and a rescan that redraws the widget. */
export interface OrgTodoHandle {
  todos(): Todo[]
  refresh(): Promise<void>
}

/** The omp theme methods drawn with (tui/src/theme/theme-class.ts). */
type Theme = { fg(color: string, text: string): string }
/** Measures what a themed string occupies: the same text, no escape codes. */
const PLAIN: Theme = { fg: (_color, text) => text }

const KEY = "org-todo"
const POLL_MS = 3000
const MAX_ROWS = 9
/** The key that opens the picker, shown in the widget header; index.ts registers the same key. */
const SHORTCUT = "alt+t"
/** Below this many columns for the text, a row drops its ` · source` instead of cutting the text to nothing. */
const MIN_TEXT = 10
/** Rows the picker shows at once; it scrolls past them. */
const VIEW = 12

const width = (s: string): number => Bun.stringWidth(s)

/** `s` cut to `cols` terminal columns, "…" last when cut; a grapheme cluster (an emoji sequence) is never split. */
const fit = (s: string, cols: number): string => {
  if (width(s) <= cols) return s
  if (cols <= 0) return ""
  let out = ""
  for (const { segment } of new Intl.Segmenter().segment(s)) {
    if (width(out + segment) > cols - 1) break
    out += segment
  }
  return `${out}…`
}

/** One todo as `text · source` in `cols` columns: the text in `text`, the source in `dim`. */
const row = (t: Todo, cols: number, theme: Theme): string => {
  const src = ` · ${t.src}`
  const room = cols - width(src)
  if (room < MIN_TEXT) return theme.fg("text", fit(t.text, cols))
  return theme.fg("text", fit(t.text, room)) + theme.fg("dim", src)
}

/** The widget: a component, so each row fits the width omp draws it at. */
const widget = (todos: Todo[]) => (_tui: unknown, theme: Theme) => ({
  render: (cols: number): string[] => {
    const count = `todo ${todos.length}`
    const hint = ` · ${SHORTCUT}`
    const header =
      width(count + hint) <= cols ? theme.fg("accent", count) + theme.fg("dim", hint) : theme.fg("accent", fit(count + hint, cols))
    return [header, ...todos.slice(0, MAX_ROWS).map((t) => row(t, cols, theme))]
  },
  invalidate() {},
})

/**
 * Tick once now, then every POLL_MS through ctx.setInterval (omp contains a throw there and clears the timer on
 * session_shutdown). Every failure leaves the previous widget in place and is logged, once per kind and session;
 * nothing here rejects.
 * pi.exec resolves on a timeout instead of rejecting (omp: exec/exec.ts:34-56), with `killed` set and whatever
 * stdout came before the kill, so a killed grep is a failure too: its partial output is not the answer. The exit
 * code is not checked: `grep -s` exits 2 whenever one of the directories is missing, matches or not.
 * A file that cannot be stat'ed (gone between the grep and the stat) ranks as mtime 0, last.
 * ecomono: ticks are not deduplicated, so a grep slower than POLL_MS overlaps the next one; the exec timeout bounds
 * the pile-up. Add an in-flight guard if a huge org directory ever makes that visible.
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
  const tick = (): Promise<void> =>
    pi.exec("grep", ["-rnHsE", "--include=*.org", "--include=*.md", core.PATTERN, ...dirs], {
      cwd: ctx.cwd,
      timeout: 10_000,
    })
      .then((result) => {
        if (result?.killed) {
          warnOnce("timeout", "ecomono: org-todo grep timed out; keeping the previous widget")
          return
        }
        shown = core.rank(core.parse(String(result?.stdout ?? ""), dirs), mtime, newest)
        if (shown.length === 0) ctx.ui.setWidget(KEY, undefined)
        else ctx.ui.setWidget(KEY, widget(shown), { placement: "belowEditor" })
      })
      .catch((e) => warnOnce("failure", `ecomono: org-todo tick failed: ${e instanceof Error ? e.message : String(e)}`))
  tick()
  ctx.setInterval(tick, POLL_MS)
  return { todos: () => shown, refresh: tick }
}

/**
 * The picker: an overlay over the ranked todos. j / k and the select keys move, enter marks the todo done in its
 * file, e opens it in $EDITOR at its line in a Zellij pane, q or escape closes. Every failure is a notice; nothing
 * here rejects.
 * The list is the snapshot taken on open, minus each todo marked done: a flip rewrites one line and moves no other,
 * so the rest keep their line numbers, and a rescan would reorder the rows under the cursor (the flipped file is now
 * the newest). A todo whose line no longer matches what the scan saw is never written; the picker takes the
 * rescanned list instead.
 */
export async function openPicker(ctx: any, core: OrgTodoCore, h: OrgTodoHandle): Promise<void> {
  const say = (text: string): void => {
    try {
      ctx.ui.notify(text, "warning")
    } catch {
      // A notice that cannot be shown changes nothing on disk.
    }
  }
  let todos = [...h.todos()]
  if (todos.length === 0) return say("org-todo: no open todos")

  /** Marks `t` done in place: writeFile follows a symlink and keeps the inode an editor is watching. */
  const markDone = async (t: Todo): Promise<boolean> => {
    const body = await readFile(t.file, "utf8")
    // A decode that needed U+FFFD would write every such byte back as U+FFFD: refuse instead.
    if (body.includes("�")) {
      say(`org-todo: ${t.file} is not UTF-8; left unchanged`)
      return false
    }
    const lines = body.split("\n")
    const next = core.flipLine(lines[t.line - 1] ?? "", t)
    if (next === null) {
      say(`org-todo: ${t.src}:${t.line} changed on disk; rescanned`)
      return false
    }
    lines[t.line - 1] = next
    // ecomono: an editor saving between the read and this write loses that save, the same window as the Claude
    // pane's flip. Compare the mtime before writing if that ever happens in practice.
    await writeFile(t.file, lines.join("\n"))
    return true
  }

  /** $EDITOR (split on whitespace, no shell) at the todo's line, in a Zellij pane next to omp. */
  const edit = async (t: Todo): Promise<void> => {
    const where = `${t.file}:${t.line}`
    if (typeof ctx.ui.openTerminal !== "function") return say(`org-todo: no terminal pane here; open ${where}`)
    const editor = (process.env.EDITOR || "nvim").split(/\s+/).filter(Boolean)
    try {
      await ctx.ui.openTerminal({ multiplexer: "zellij", placement: "pane", command: [...editor, `+${t.line}`, t.file], cwd: ctx.cwd })
    } catch (e) {
      say(`org-todo: could not open ${where}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await ctx.ui.custom(
    (tui: any, theme: Theme, keybindings: any, done: (result?: unknown) => void) => {
      let sel = 0
      let top = 0
      let busy = false
      const is = (data: string, id: string): boolean => {
        try {
          return Boolean(keybindings?.matches?.(data, id))
        } catch {
          return false
        }
      }
      const move = (by: number): void => {
        sel = Math.max(0, Math.min(todos.length - 1, sel + by))
        if (sel < top) top = sel
        if (sel >= top + VIEW) top = sel - VIEW + 1
      }
      const settle = (): void => {
        move(0)
        if (todos.length === 0) done()
        else tui.requestRender()
      }
      // The widget rescans either way; the picker takes the rescan only when its snapshot was wrong.
      const enter = async (t: Todo): Promise<void> => {
        const flipped = await markDone(t)
        await h.refresh()
        todos = flipped ? todos.filter((x) => x !== t) : [...h.todos()]
      }
      const run = (job: Promise<void>): void => {
        busy = true
        job
          .catch((e) => say(`org-todo: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            busy = false
            settle()
          })
      }
      return {
        render(cols: number): string[] {
          const inner = Math.max(0, cols - 4)
          const rule = (label: string): string => {
            const l = fit(`─ ${label} `, Math.max(0, cols - 2))
            return `${l}${"─".repeat(Math.max(0, cols - 2 - width(l)))}`
          }
          // Every line is padded to the full width, so the overlay hides what is under it.
          const body = todos.slice(top, top + VIEW).map((t, i) => {
            const mark = top + i === sel ? theme.fg("accent", "> ") : "  "
            const pad = " ".repeat(Math.max(0, inner - 2 - width(row(t, inner - 2, PLAIN))))
            return `${theme.fg("border", "│")} ${mark}${row(t, inner - 2, theme)}${pad} ${theme.fg("border", "│")}`
          })
          return [
            theme.fg("border", `┌${rule(`todo ${sel + 1}/${todos.length}`)}┐`),
            ...body,
            theme.fg("border", `└${rule("j/k move · enter done · e edit · q close")}┘`),
          ]
        },
        handleInput(data: string): void {
          if (busy) return
          const t = todos[sel]
          if (data === "q" || is(data, "tui.select.cancel")) return done()
          if (data === "j" || is(data, "tui.select.down")) move(1)
          else if (data === "k" || is(data, "tui.select.up")) move(-1)
          else if (is(data, "tui.select.pageDown")) move(VIEW)
          else if (is(data, "tui.select.pageUp")) move(-VIEW)
          else if (t && is(data, "tui.select.confirm")) return run(enter(t))
          else if (t && data === "e") {
            busy = true
            void edit(t).finally(() => done())
            return
          }
          tui.requestRender()
        },
        invalidate() {},
      }
    },
    { overlay: true },
  )
}
