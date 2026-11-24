/**
 * The side panel: one overlay (ctx.ui.custom, anchored right-center, 38% wide, the terminal's full height)
 * over the tabs it is given (panel/model.ts). Layout, top to bottom, every row behind a left border: the tab
 * strip (every tab with its count, the active one a solid block, the selection counter at the right), the filter
 * line and a hairline, the rows (head rows group, item rows select, one blank row before each section but the
 * first), a hairline and the selected item's detail (accent title, blank row, numbered lines, a cut marker),
 * free rows, and the key bar, which wraps onto as many rows as it needs.
 * omp crops an overlay to the terminal height from the bottom, so this returns exactly `tui.terminal.rows`
 * lines and scrolls the rows itself. When the height runs short the panel gives up the detail first, then the
 * blank rows between sections, then the filter row and its hairline, then key bar rows from the bottom; the tab
 * strip always stays and the selected row from two rows up. The panel is modal: omp focuses
 * the overlay until done() is called.
 * Keys, outside the filter: j k, the select keys, tab / shift+tab and the tab's own keys act, q closes, `/`
 * starts the filter, esc clears a filter and then closes; any other printable key is ignored. In the filter
 * (the filter line shows a cursor): every printable key is typed, backspace deletes, enter or esc leaves it
 * keeping the text (esc on an empty filter closes), and no tab key acts.
 * Colors are omp theme names only (tui/src/theme/schema.ts): Theme.fg and Theme.bg throw on any other, and omp
 * has no background token in the accent, so a solid accent block is reverse video (SGR 7 ... 27, as omp's own
 * editor cursor) over accent-colored text.
 */

import { keyOf } from "./keys.ts"
import type { Action, Detail, Row, Span, Tab } from "./model.ts"
import { fit, fitPath, fitTail, fitWords, pad, plain, sides, width, wrap } from "./text.ts"

/** The omp theme methods drawn with (tui/src/theme/theme-class.ts). */
type Theme = {
  fg(color: string, text: string): string
  bg(color: string, text: string): string
  /** The sharp box glyphs (tui/src/theme/theme-class.ts `boxSharp`); a theme without them gets the defaults. */
  boxSharp?: { topLeft: string; bottomLeft: string; horizontal: string; vertical: string; teeRight: string }
}

const WIDTH = "38%"
const MIN_WIDTH = 40
/** Lines of a detail's content shown at most, besides its title and cut marker. */
const CONTENT_MAX = 10
/** Rows the list keeps before the detail is made smaller. */
const LIST_FLOOR = 6
/** Lines above the rows: the strip, the filter, its hairline. */
const HEAD = 3
/** Rows a detail spends besides its content: the hairline, the title and one blank row. */
const FRAME = 3
/** Columns between a detail's title and its tail. */
const TAIL_GAP = 3
/** The panel's own keys, after the tab's: the filter, moving, the tab strip, closing. */
const PANEL_KEYS: Array<[string, string]> = [["/", "filter"], ["j/k", "move"], ["tab", "next tab"], ["esc", "close"]]

export function openPanel(ctx: any, tabs: Tab[], initial: number): Promise<void> {
  const say = (text: string): void => {
    try {
      ctx.ui.notify(plain(text), "warning")
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
      /** How many list rows the last draw had room for: what a page key moves by. */
      let lastArea = 1

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
        void load(true)
      }
      /** The open-time loads of the inactive tabs that still run, by tab: activating one joins it, so a tab never
       *  has two loads at once (its git commands would run twice, and the late one would clear what the early one
       *  prefetched). A refresh does not join: it must read what an action just changed. */
      const opening = new Map<number, Promise<void>>()
      /** The tabs whose last load failed: the strip marks the inactive ones, as it cannot show their error. */
      const lost = new Set<number>()
      /** The newest load's number: an older one (another tab's, or one a refresh replaced) settles unheard. */
      let loadGen = 0
      const load = async (join = false): Promise<void> => {
        const which = active
        const gen = ++loadGen
        busy = true
        try {
          await ((join ? opening.get(which) : undefined) ?? tabs[which]!.load())
          if (active !== which || gen !== loadGen) return
          // A load replaces what the tab knows, so every detail is asked again.
          fetched.clear()
          failed = undefined
          lost.delete(which)
          reload(current()?.id)
          prefetch()
        } catch (e) {
          if (active !== which || gen !== loadGen) return
          // The tab's source is not there (no git repository, a missing directory): the panel says so where the
          // rows would be, and stays open so the other tabs work.
          failed = e instanceof Error ? e.message : String(e)
          lost.add(which)
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
      // Every tab loads on open so the strip shows each count; a failure here marks the tab in the strip with a `!`,
      // and opening the tab loads it again (the retry), its error shown on that tab. A tab has no rows before its
      // load settles and keys do nothing during a load, so nothing of it is cached when this one settles. A
      // synchronous throw is a failed load of that tab, never the panel's.
      tabs.forEach((t, i) => {
        if (i === active) return
        const p = (async () => t.load())()
        opening.set(i, p)
        const settle = (): void => {
          opening.delete(i)
          redraw()
        }
        p.then(settle, () => (lost.add(i), settle()))
      })

      return {
        render(cols: number): string[] {
          const H = Math.max(1, Number(tui?.terminal?.rows) || 24)
          const W = Math.max(1, cols)
          // The frame: a left border on every row (the panel's right edge is the terminal's). omp's own overlays
          // draw their box the same way (tui/src/overlays/hook-selector.ts).
          const box = theme.boxSharp ?? { topLeft: "┌", bottomLeft: "└", horizontal: "─", vertical: "│", teeRight: "├" }
          const edge = theme.fg("border", box.vertical)
          const I = Math.max(1, W - 2)
          const line = (body: string): string => `${edge} ${body}`
          const blank = line(" ".repeat(I))
          const hairline = line(theme.fg("borderMuted", box.horizontal.repeat(I)))
          // A solid accent block: reverse video over accent text (the theme has no accent background). The reverse
          // wraps the fg span and is undone after it, so no background span is ever nested.
          const block = (text: string): string => `\x1b[7m${theme.fg("accent", text)}\x1b[27m`
          const tab = tabs[active]!
          const out: string[] = []

          // The tab strip: every tab with its count, the active one a solid block, the others plain, a border glyph
          // between them; the selection counter sits at the right when it fits. Built from plain pieces first, so a
          // width is never measured over colored text.
          const idx = items()
          const at = idx.indexOf(sel)
          const pos = `${idx.length === 0 ? 0 : at + 1} / ${idx.length}`
          const marked = (i: number): boolean => lost.has(i) && i !== active
          const cells = tabs.map((t, i) => ` ${t.title()}${marked(i) ? " !" : ""} `)
          const stripWidth = cells.reduce((n, c) => n + width(c), 0) + (cells.length - 1)
          // A failed tab's `!` is the warning color; the cell ends `! `, so the plain width is unchanged.
          const strip = cells.map((c, i) => (i === active ? block(c) : marked(i) ? c.slice(0, -2) + theme.fg("warning", "!") + " " : c)).join(theme.fg("border", box.vertical))
          out.push(
            line(
              stripWidth + 1 + width(pos) <= I
                ? strip + " ".repeat(I - stripWidth - width(pos)) + theme.fg("dim", pos)
                : stripWidth <= I
                  ? strip + " ".repeat(I - stripWidth)
                  : pad(cells.join(box.vertical), I),
            ),
          )

          // The filter line, then a hairline.
          out.push(line(theme.fg("accent", "> ") + pad(fitTail(`${filter}${filtering ? "█" : ""}`, I - 2), I - 2)))
          out.push(hairline)

          // The key bar, wrapped: the tab's keys start the first row, the panel's keys the next one; each key is a
          // chip followed by its label, and a pair that does not fit starts a new row. Nothing is dropped.
          const keyRows: string[] = []
          for (const group of [tab.keys, PANEL_KEYS]) {
            let drawn = ""
            let used = 0
            for (const [key, what] of group) {
              const chip = ` ${key} `
              const label = fit(what, Math.max(1, I - width(chip) - 1))
              const piece = width(chip) + 1 + width(label)
              if (used > 0 && used + 3 + piece > I) {
                keyRows.push(line(drawn + " ".repeat(Math.max(0, I - used))))
                drawn = ""
                used = 0
              }
              if (used > 0) [drawn, used] = [drawn + "   ", used + 3]
              drawn += theme.bg("selectedBg", theme.fg("accent", chip)) + " " + theme.fg("dim", label)
              used += piece
            }
            keyRows.push(line(drawn + " ".repeat(Math.max(0, I - used))))
          }

          // The detail, as lines of exactly I columns, for `room` rows (0 when it does not fit): the hairline, the
          // accent title (path cut at its start, tail kept), a dim note, one blank row, the numbered lines and a
          // cut marker. A detail shorter than its smallest form (title, blank, a line, a marker) is dropped.
          const d: Detail | undefined = failed !== undefined || current()?.id === undefined ? undefined : tab.detail(current()!.id!)
          const fixed = d ? FRAME + (d.note ? 1 : 0) : 0
          const count = d ? d.lines.length + (d.more ? 1 : 0) : 0
          const wants = d ? fixed + Math.min(CONTENT_MAX, count) : 0
          const smallest = d ? Math.min(wants, fixed + 2) : 0
          const detailBlock = (room: number): string[] => {
            if (!d || room < smallest) return []
            const content = Math.min(CONTENT_MAX, room - fixed)
            const cut = count > content
            const shown = d.more || cut ? Math.min(d.lines.length, content - 1) : d.lines.length
            const hidden = d.lines.length - shown
            const title = plain(d.title)
            const tail = d.tail ? plain(d.tail) : ""
            // The path keeps its file name over the tail: the tail gets what the whole title leaves, or nothing.
            let t = fitPath(title, Math.max(1, I - TAIL_GAP - width(tail)))
            if (t.startsWith("…") && !t.startsWith("…/")) t = fitPath(title, I)
            const tl = tail && width(tail) <= I - width(t) - TAIL_GAP ? tail : ""
            const body = [theme.fg("accent", pad(tl ? `${t}${" ".repeat(TAIL_GAP)}${tl}` : t, I))]
            if (d.note) body.push(theme.fg("dim", pad(plain(d.note), I)))
            body.push(" ".repeat(I))
            const numbered = d.lines.some((l) => l.no !== undefined)
            const noW = Math.max(3, String(Math.max(0, ...d.lines.map((l) => l.no ?? 0))).length)
            const gutterW = numbered ? noW + 4 : 0
            for (const l of d.lines.slice(0, shown)) {
              const gutter = numbered ? theme.fg("dim", ` ${l.no === undefined ? " ".repeat(noW) : String(l.no).padStart(noW)} │ `) : ""
              const text = pad(plain(l.text), I - gutterW)
              body.push(gutter + (l.kind === "add" ? theme.fg("toolDiffAdded", text) : l.kind === "del" ? theme.fg("toolDiffRemoved", text) : l.kind === "hit" ? block(text) : text))
            }
            if (hidden > 0 || d.more) body.push(theme.fg("dim", pad(`… ${[hidden > 0 ? `${hidden} more` : "", d.more ?? ""].filter(Boolean).join(" · ")}`, I)))
            return [hairline, ...body.map(line)].slice(0, room)
          }

          // The display list: the rows, one blank row before each section but the first. `blanks` false drops them.
          type Entry = { i: number } | undefined
          const entries = (blanks: boolean): Entry[] =>
            rows.flatMap((r, i): Entry[] => (blanks && i > 0 && r.kind === "head" && !r.tight ? [undefined, { i }] : [{ i }]))
          // The rows area: what the key bar and the strip leave; the detail takes what the list does not need, down
          // to its smallest form, and below that it is dropped; only then do the blank rows go.
          const R = Math.max(1, H - HEAD - keyRows.length)
          let list = entries(true)
          let room = 0
          if (failed === undefined && list.length + wants > R) {
            const give = Math.min(wants, R - Math.min(list.length, LIST_FLOOR))
            if (give >= smallest && d) room = give
          } else if (failed === undefined) room = wants
          if (room === 0 && list.length > R) list = entries(false)
          const area = room > 0 && list.length + room > R ? R - room : room > 0 ? list.length : R
          lastArea = area
          const dsel = list.findIndex((e) => e?.i === sel)
          if (dsel !== -1) {
            if (dsel < top) top = dsel
            if (dsel >= top + area) top = dsel - area + 1
          }
          top = Math.max(0, Math.min(top, Math.max(0, list.length - area)))

          // A failure is wrapped, not cut: git's reason is the whole point of showing it.
          const why = failed === undefined ? [] : wrap(plain(failed), I - 2).slice(0, area)
          for (const text of why) out.push(line(theme.fg("warning", pad(`  ${text}`, I))))
          // Right-aligned columns shared by every row: `+N` and `-N` each in its own, a zero or missing side blank.
          const addW = Math.max(0, ...rows.map((r) => (r.add ? width(`+${r.add}`) : 0)))
          const delW = Math.max(0, ...rows.map((r) => (r.del ? width(`-${r.del}`) : 0)))
          const counts = (r: Row): { text: string; drawn: string } => {
            const a = r.add ? `+${r.add}` : ""
            const dl = r.del ? `-${r.del}` : ""
            const gap = addW && delW ? "  " : ""
            return {
              text: a.padStart(addW) + gap + dl.padStart(delW),
              drawn: " ".repeat(addW - a.length) + (a ? theme.fg("toolDiffAdded", a) : "") + gap + " ".repeat(delW - dl.length) + (dl ? theme.fg("toolDiffRemoved", dl) : ""),
            }
          }
          for (const e of list.slice(top, top + area - why.length)) {
            if (!e) {
              out.push(blank)
              continue
            }
            const row = rows[e.i]!
            const chosen = e.i === sel
            if (row.kind === "head" && !row.spans) {
              out.push(line(theme.fg("dim", sides(plain(row.text), plain(row.right ?? ""), I))))
              continue
            }
            // The indent is two cells; the selected row's holds the `>` marker.
            const avail = I - 2
            if (row.spans) {
              const text = (s: Span): string => (s.chip ? ` ${plain(s.text)} ` : plain(s.text))
              const lead = row.spans.slice(0, -1).reduce((n, s) => n + width(text(s)), 0)
              const last = row.spans.at(-1)!
              // The last span (the subject) gives way; when the graph and chips alone are too wide, the plain text is cut.
              const fits = lead + width(text(last)) <= avail
              const spans: Span[] | undefined = fits ? row.spans : lead < avail ? [...row.spans.slice(0, -1), { ...last, text: fitWords(plain(last.text), avail - lead) }] : undefined
              const flat = (spans ?? []).map(text).join("")
              if (chosen) out.push(line(block(pad(`> ${spans ? flat : fit(plain(row.spans.map(text).join("")), avail)}`, I))))
              else if (!spans) out.push(line("  " + pad(fit(plain(row.spans.map(text).join("")), avail), avail)))
              else {
                const drawn = spans.map((s) => (s.chip ? theme.bg("statusLineBg", theme.fg(s.color ?? "text", text(s))) : s.color ? theme.fg(s.color, text(s)) : text(s))).join("")
                out.push(line("  " + drawn + " ".repeat(Math.max(0, avail - width(flat)))))
              }
              continue
            }
            // An item: marker, text cut to what the right-hand columns leave, then the columns (or the plain suffix).
            const raw = plain(row.text)
            const mark = new Intl.Segmenter().segment(raw)[Symbol.iterator]().next().value?.segment ?? ""
            const lead = mark + (raw.startsWith(" ", mark.length) ? " " : "")
            const c = counts(row)
            const right = row.right ? { text: plain(row.right), drawn: plain(row.right) } : c
            const budget = avail - width(right.text) - (right.text.trim() ? 1 : 0) - width(lead)
            const rest = raw.slice(lead.length)
            const body = row.cut === "start" ? fitPath(rest, budget) : fitWords(rest, budget)
            const gap = " ".repeat(Math.max(0, avail - width(lead) - width(body) - width(right.text)))
            if (chosen) out.push(line(block(pad(`> ${lead}${body}${gap}${right.text}`, I))))
            else out.push(line("  " + (row.color && mark ? theme.fg(row.color, mark) + lead.slice(mark.length) : lead) + body + gap + right.drawn))
          }
          while (out.length < HEAD + area) out.push(blank)

          out.push(...detailBlock(room))
          // Free rows sit between the detail and the key bar, so the detail stays under the list.
          while (out.length < H - keyRows.length) out.push(blank)
          out.push(...keyRows)
          if (out.length <= H) return out
          // ecomono: reached only when H < HEAD + 1 + key rows (the detail and the free rows are already gone, the
          // list is one row): the hairline and the filter row go, then key rows from the bottom; the strip stays
          // always and the selected row from H = 2. A terminal that short is rare; upgrade by scrolling the key bar.
          const body = out.slice(HEAD, out.length - keyRows.length)
          const spare = Math.max(0, H - 1 - body.length)
          const bar = Math.min(spare, keyRows.length)
          return [out[0]!, ...out.slice(1, HEAD).slice(0, spare - bar), ...body.slice(0, H - 1), ...keyRows.slice(0, bar)]
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
      /** A page is the rows the last draw showed (the detail and key bar already taken out). */
      function rowsPerPage(): number {
        return Math.max(1, lastArea)
      }
    },
    { overlay: true, overlayOptions: { anchor: "right-center", width: WIDTH, minWidth: MIN_WIDTH, maxHeight: "100%" } },
  )
}
