/**
 * The side panel: one overlay (ctx.ui.custom, anchored right-center, 38% wide, the terminal's full height)
 * over the tabs it is given (panel/model.ts). Layout, top to bottom, every row behind a left border: a top
 * rule, the tab strip band, the filter line, the rows (head rows group, item rows select), a rule and the
 * selected item's detail, blank fill, two key-bar bands, a bottom rule.
 * omp crops an overlay to the terminal height from the bottom, so this returns exactly `tui.terminal.rows`
 * lines and scrolls the rows itself; the detail is capped so one row and the key bar always fit. The panel is
 * modal: omp focuses the overlay until done() is called.
 * Keys, outside the filter: j k, the select keys, tab / shift+tab and the tab's own keys act, q closes, `/`
 * starts the filter, esc clears a filter and then closes; any other printable key is ignored. In the filter
 * (the filter line shows a cursor): every printable key is typed, backspace deletes, enter or esc leaves it
 * keeping the text (esc on an empty filter closes), and no tab key acts.
 * Colors are omp theme names only (tui/src/theme/schema.ts): Theme.fg and Theme.bg throw on any other.
 */

import { keyOf } from "./keys.ts"
import type { Action, Row, Tab } from "./model.ts"
import { fit, pad, plain, sides, width, wrap } from "./text.ts"

/** The omp theme methods drawn with (tui/src/theme/theme-class.ts). */
type Theme = {
  fg(color: string, text: string): string
  bg(color: string, text: string): string
  /** The sharp box glyphs (tui/src/theme/theme-class.ts `boxSharp`); a theme without them gets the defaults. */
  boxSharp?: { topLeft: string; bottomLeft: string; horizontal: string; vertical: string; teeRight: string }
}

const WIDTH = "38%"
const MIN_WIDTH = 40
const DETAIL_MAX = 8
const KEY_BAR = 2
/** Lines that are not rows: the top rule, the strip, the filter, the rule before the detail, the key bar, the
 *  bottom rule. */
const CHROME = 5 + KEY_BAR

export function openPanel(ctx: any, tabs: Tab[], initial: number): Promise<void> {
  const say = (text: string): void => {
    try {
      ctx.ui.notify(text, "warning")
    } catch {
      // A notice that cannot be shown changes nothing.
    }
  }
  return ctx.ui.custom(
    (tui: any, theme: Theme, keybindings: any, done: (result?: unknown) => void) => {
      let active = Math.max(0, Math.min(tabs.length - 1, initial))
      let filter = ""
      let rows: Row[] = []
      let sel = 0
      let top = 0
      let busy = false
      let closed = false
      let filtering = false
      /** What the active tab's last load failed with: drawn in place of its rows, cleared by a load that works. */
      let failed: string | undefined

      const is = (data: string, id: string): boolean => {
        try {
          return Boolean(keybindings?.matches?.(data, id))
        } catch {
          return false
        }
      }
      const items = (): number[] => rows.flatMap((r, i) => (r.kind === "item" ? [i] : []))
      const current = (): Row | undefined => rows[sel]
      const redraw = (): void => {
        if (!closed) tui.requestRender()
      }
      /** Re-reads the rows and keeps the selection on `keepId`, else on the nearest item. */
      const reload = (keepId?: string): void => {
        // A failed tab has no rows: its stale data would push the failure lines past the frame.
        rows = failed !== undefined ? [] : tabs[active]!.rows(filter)
        const idx = items()
        const kept = keepId === undefined ? -1 : rows.findIndex((r) => r.kind === "item" && r.id === keepId)
        sel = kept !== -1 ? kept : (idx.find((i) => i >= sel) ?? idx.at(-1) ?? 0)
        top = Math.min(top, sel)
        prefetch()
      }
      const move = (by: number): void => {
        const idx = items()
        if (idx.length === 0) return
        const at = idx.indexOf(sel)
        sel = idx[Math.max(0, Math.min(idx.length - 1, (at === -1 ? 0 : at) + by))]!
        prefetch()
      }
      /** Asks the tab for the selected item's detail, once per item, and redraws when it arrives. */
      const fetched = new Set<string>()
      const prefetch = (): void => {
        const row = current()
        const tab = tabs[active]!
        if (!row?.id || !tab.prefetch || fetched.has(`${active}:${row.id}`)) return
        fetched.add(`${active}:${row.id}`)
        tab.prefetch(row.id).then(redraw, (e) => say(`panel: ${e instanceof Error ? e.message : String(e)}`))
      }
      const activate = (i: number): void => {
        active = (i + tabs.length) % tabs.length
        filter = ""
        filtering = false
        sel = 0
        top = 0
        rows = []
        failed = undefined
        void load()
      }
      /** The newest load's number: an older one (another tab's, or one a refresh replaced) settles unheard. */
      let loadGen = 0
      const load = async (): Promise<void> => {
        const which = active
        const gen = ++loadGen
        busy = true
        try {
          await tabs[which]!.load()
          if (active !== which || gen !== loadGen) return
          // A load replaces what the tab knows, so every detail is asked again.
          fetched.clear()
          failed = undefined
          reload(current()?.id)
          prefetch()
        } catch (e) {
          if (active !== which || gen !== loadGen) return
          // The tab's source is not there (no git repository, a missing directory): the panel says so where the
          // rows would be, and stays open so the other tabs work.
          failed = e instanceof Error ? e.message : String(e)
          rows = []
        } finally {
          if (gen === loadGen) busy = false
          redraw()
        }
      }
      const run = async (key: string, row: Row): Promise<void> => {
        busy = true
        let action: Action = { kind: "none" }
        try {
          action = await tabs[active]!.act(key, row.id!)
        } catch (e) {
          action = { kind: "notice", text: `panel: ${e instanceof Error ? e.message : String(e)}` }
        }
        busy = false
        // esc closed the panel while the action ran: its outcome has nowhere to go.
        if (closed) return
        if (action.kind === "notice") say(action.text)
        else if (action.kind === "close") return close()
        else if (action.kind === "refresh") {
          if (action.notice) say(action.notice)
          return void load()
        }
        redraw()
      }
      const close = (): void => {
        if (closed) return
        closed = true
        done()
      }

      void load()

      return {
        render(cols: number): string[] {
          const H = Math.max(CHROME + 1, Number(tui?.terminal?.rows) || 24)
          const W = Math.max(1, cols)
          // The frame: a left border on every row (the panel's right edge is the terminal's), a top and a
          // bottom rule with sharp corners, a tee where the detail rule meets the border. omp's own overlays
          // draw their box the same way (tui/src/overlays/hook-selector.ts).
          const box = theme.boxSharp ?? { topLeft: "┌", bottomLeft: "└", horizontal: "─", vertical: "│", teeRight: "├" }
          const edge = theme.fg("border", box.vertical)
          const I = Math.max(1, W - 2)
          const line = (body: string): string => `${edge} ${body}`
          const tab = tabs[active]!
          const out: string[] = []

          out.push(theme.fg("border", box.topLeft + box.horizontal.repeat(W - 1)))

          // The tab strip, a band: the active tab as a solid accent block, the others on the band's background.
          // omp's bg() ends with a reset to the default background, so the segments are side by side, never nested.
          const strip = tabs.map((t, i) =>
            i === active ? theme.bg("selectedBg", theme.fg("accent", ` ${t.title()} `)) : theme.bg("statusLineBg", theme.fg("muted", ` ${t.title()} `)),
          )
          const stripPlain = tabs.map((t) => ` ${t.title()} `)
          const hint = "tab cambia"
          const stripWidth = stripPlain.reduce((n, s) => n + width(s), 0)
          const gap = Math.max(1, I - stripWidth - width(hint))
          // Too narrow for the hint: the plain titles, cut; never `fit` over colored text (it would split an escape).
          const band =
            stripWidth + 1 + width(hint) <= I
              ? strip.join("") + theme.bg("statusLineBg", " ".repeat(gap)) + theme.bg("statusLineBg", theme.fg("dim", hint))
              : theme.bg("statusLineBg", pad(stripPlain.join(""), I))
          out.push(line(band))

          // The filter line, with the position at the right.
          const idx = items()
          const at = idx.indexOf(sel)
          const pos = `${idx.length === 0 ? 0 : at + 1} / ${idx.length}`
          out.push(line(theme.fg("accent", "> ") + sides(filtering ? `${filter}█` : filter, pos, I - 2)))

          // The rows area: what is left after the detail (capped) and the chrome.
          const cap = Math.min(DETAIL_MAX, Math.max(0, H - CHROME - 1))
          const detail = current()?.id === undefined ? [] : tab.detail(current()!.id!).slice(0, cap).map(plain)
          const area = Math.max(1, H - CHROME - detail.length)
          if (sel < top) top = sel
          if (sel >= top + area) top = sel - area + 1
          top = Math.max(0, Math.min(top, Math.max(0, rows.length - area)))
          // A failure is wrapped, not cut: git's reason is the whole point of showing it.
          const why = failed === undefined ? [] : wrap(plain(failed), I - 2).slice(0, area)
          for (const text of why) out.push(line(theme.fg("warning", pad(`  ${text}`, I))))
          for (let i = top; i < Math.min(rows.length, top + area - why.length); i++) {
            const row = rows[i]!
            const right = row.right ?? ""
            if (row.kind === "head") {
              out.push(line(theme.fg("dim", sides(plain(row.text), right, I))))
            } else if (i === sel) {
              out.push(line(theme.bg("selectedBg", theme.fg("accent", sides(`> ${plain(row.text)}`, right, I)))))
            } else {
              // The leading marker (a status letter, a graph glyph) is the first grapheme cluster; the rest is plain.
              const text = plain(row.text)
              const body = sides(text, right, I - 2)
              const first = new Intl.Segmenter().segment(text)[Symbol.iterator]().next().value?.segment ?? ""
              out.push(line("  " + (row.color && first && body.startsWith(first) ? theme.fg(row.color, first) + body.slice(first.length) : body)))
            }
          }
          while (out.length < 3 + area) out.push(line(" ".repeat(I)))

          // The detail block: a rule off the border, then the lines; blank fill up to the key bar.
          out.push(theme.fg("border", box.teeRight + box.horizontal.repeat(W - 1)))
          for (const text of detail) out.push(line(pad(text, I)))
          // The bands and the bottom rule take the last KEY_BAR + 1 lines.
          while (out.length < H - KEY_BAR - 1) out.push(line(" ".repeat(I)))

          // The key bar, a band: the tab's keys, then the panel's own, as `key description` pairs.
          const bar = (pairs: Array<[string, string]>): string => {
            let plainText = ""
            let drawn = ""
            for (const [key, what] of pairs) {
              const piece = ` ${key} ${what}  `
              if (width(plainText + piece) > I) break
              plainText += piece
              drawn += theme.bg("selectedBg", theme.fg("accent", ` ${key} `)) + theme.bg("statusLineBg", theme.fg("dim", `${what}  `))
            }
            return line(drawn + theme.bg("statusLineBg", " ".repeat(Math.max(0, I - width(plainText)))))
          }
          out.push(bar(tab.keys))
          out.push(bar([["/", "filtrar"], ["esc", "cerrar"], ["j/k", "mover"], ["tab", "pestaña"]]))
          out.push(theme.fg("border", box.bottomLeft + box.horizontal.repeat(W - 1)))
          return out.slice(0, H)
        },
        handleInput(data: string): void {
          const key = keyOf(data)
          // esc always closes, except that it first leaves the filter and then clears it; nothing else is read
          // while an action runs.
          if (key === "escape" || is(data, "tui.select.cancel")) {
            if (!busy && filtering && filter) {
              filtering = false
              return redraw()
            }
            if (!busy && !filtering && filter) {
              filter = ""
              sel = 0
              reload()
              return redraw()
            }
            return close()
          }
          if (busy) return
          /** The filter changed: the set of rows did, so the selection restarts. */
          const edit = (text: string): void => {
            filter = text
            sel = 0
            reload()
          }
          const navigate = (): boolean => {
            if (is(data, "tui.select.down")) move(1)
            else if (is(data, "tui.select.up")) move(-1)
            else if (is(data, "tui.select.pageDown")) move(rowsPerPage())
            else if (is(data, "tui.select.pageUp")) move(-rowsPerPage())
            else return false
            return true
          }
          if (filtering) {
            if (key === "enter" || is(data, "tui.select.confirm")) filtering = false
            else if (key === "backspace") edit(filter.slice(0, -1))
            else if (key === "tab" || key === "shift+tab") return
            else if (key !== undefined) edit(filter + key)
            else if (!navigate()) return
            return redraw()
          }
          if (key === "q") return close()
          if (key === "/") filtering = true
          else if (key === "tab") activate(active + 1)
          else if (key === "shift+tab") activate(active - 1)
          else if (key === "j") move(1)
          else if (key === "k") move(-1)
          else if (navigate()) return redraw()
          else if (key === "enter" || is(data, "tui.select.confirm")) {
            const row = current()
            if (row?.kind === "item" && tabs[active]!.keys.some(([k]) => k === "enter")) return void run("enter", row)
          } else if (key !== undefined && key.length === 1) {
            const row = current()
            if (row?.kind === "item" && tabs[active]!.keys.some(([k]) => k === key)) return void run(key, row)
          }
          redraw()
        },
        invalidate() {},
      }
      function rowsPerPage(): number {
        const H = Math.max(CHROME + 1, Number(tui?.terminal?.rows) || 24)
        return Math.max(1, H - CHROME - Math.min(DETAIL_MAX, 2))
      }
    },
    { overlay: true, overlayOptions: { anchor: "right-center", width: WIDTH, minWidth: MIN_WIDTH, maxHeight: "100%" } },
  )
}
