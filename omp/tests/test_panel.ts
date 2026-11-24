// The omp side panel (omp/extensions/ecomono/panel/panel.ts) driven through fake-pi's ctx.ui.custom with a fake
// tab. Plain assert script: no omp, no git, no process. Also the key decoder and openEditor (panel/editor.ts).
import { FAKE_KEYS, FAKE_THEME, makeCtx, makeTheme, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import type { Action, Detail, Row, Tab } from "../extensions/ecomono/panel/model.ts"
import { keyOf } from "../extensions/ecomono/panel/keys.ts"
import { openPanel } from "../extensions/ecomono/panel/panel.ts"
import { fitPath, fitWords } from "../extensions/ecomono/panel/text.ts"

/** A tab over `n` items in two groups, recording every act; `acted` resolves what act returns. */
const fakeTab = (name: string, n: number, over: Partial<Tab> = {}) => {
  const acts: Array<[string, string]> = []
  let loads = 0
  let next: Action = { kind: "none" }
  let gate: (() => void) | undefined
  const tab: Tab & { acts: typeof acts; loads: () => number; answer: (a: Action) => void; hold: () => () => void } = {
    name,
    title: () => `${name} ${n}`,
    rows: (filter) => {
      const rows: Row[] = []
      for (let i = 1; i <= n; i++) {
        const text = `${name} item ${i}`
        if (filter && !text.includes(filter)) continue
        if (i === 1 || i === Math.ceil(n / 2) + 1) rows.push({ kind: "head", text: i === 1 ? "first half" : "second half", right: "x" })
        rows.push({ kind: "item", text, right: `:${i}`, id: `${name}-${i}` })
      }
      return rows
    },
    detail: (id) => ({ title: id, lines: [{ text: `detail of ${id}` }, { text: "second line" }] }),
    keys: [["enter", "do it"], ["e", "edit"]],
    act: async (key, id) => {
      acts.push([key, id])
      if (gate) await new Promise<void>((r) => (gate = r))
      return next
    },
    load: async () => void loads++,
    acts,
    loads: () => loads,
    answer: (a) => void (next = a),
    hold: () => {
      gate = () => {}
      return () => {
        const g = gate
        gate = undefined
        g?.()
      }
    },
    ...over,
  }
  return tab
}

const open = async (tabs: Tab[], initial = 0, size = { rows: 24, columns: 100 }) => {
  const ctx = makeCtx({ mode: "tui", hasUI: true, terminal: size })
  const closed = openPanel(ctx, tabs, initial)
  await tick()
  const entry = ctx.recorded.custom.at(-1)!
  return { ctx, entry, closed }
}
const press = async (entry: any, ...keys: string[]) => {
  for (const key of keys) {
    entry.component.handleInput(key)
    await tick()
  }
}
/** Every content row sits behind the left border: `│ ` then 38 columns at width 40. */
const B = "│ "
const row = (body: string): string => B + body.padEnd(38)
/** The filter line at 40 columns: `> ` + text; the position is in the strip row, see `counter`. */
const filterLine = (text: string): string => row(`> ${text}`)
/** The selection counter, drawn at the right of the tab strip (the first line). */
const counter = (ls: string[]): string | undefined => ls[0]!.match(/\d+ \/ \d+$/)?.[0]
const HAIRLINE = B + "─".repeat(38)
/** The key bar at 40 columns for a tab with `enter` and `e`: the tab's keys on the first row, the panel's after,
 *  wrapped onto rows of their own, nothing dropped. */
const KEYS = [row(" enter  do it    e  edit"), row(" /  filtrar    j/k  mover"), row(" tab  pestaña    esc  cerrar")]
/** Reverse video (SGR 7 ... 27) is how a solid accent block is drawn: the plain view drops it, `raw` keeps it. */
const SGR_REVERSE = /\x1b\[(?:7|27)m/g
const raw = (entry: any, width = 40): string[] => entry.component.render(width)
const lines = (entry: any, width = 40): string[] => raw(entry, width).map((l: string) => l.replace(SGR_REVERSE, ""))
/** The selected row: the `│ > ` line below the filter line (which starts the same way). */
const selected = (entry: any): string => lines(entry).slice(3).find((l: string) => l.startsWith(B + "> "))!

// ---- cutting: paths from the start on a directory, free text from the end on a word -------------------------------

{
  assert.equal(fitPath("omp/extensions/ecomono/index.ts", 31), "omp/extensions/ecomono/index.ts", "a path that fits is left alone")
  assert.equal(fitPath("omp/extensions/ecomono/index.ts", 20), "…/ecomono/index.ts")
  assert.equal(fitPath("omp/extensions/ecomono/index.ts", 12), "…/index.ts")
  assert.equal(fitPath("omp/extensions/ecomono/index.ts", 6), "…ex.ts", "a name wider than the room is cut inside, from its start")
  assert.equal(fitWords("decide the foot fallback with a long title", 24), "decide the foot…", "cut on a word")
  assert.equal(fitWords("decide the foot fallback", 40), "decide the foot fallback")
  assert.equal(fitWords("unbrokenwordthatistoolong", 10), "unbrokenw…", "no space to cut at: cut in the word")
  for (const [s, n] of [["漢字漢字漢字 and more 漢字", 9], ["a b c d e f g h", 5]] as const) assert.ok(Bun.stringWidth(fitWords(s, n)) <= n)
}

// ---- keyOf: raw bytes and the kitty CSI-u forms --------------------------------------------------------------

{
  assert.equal(keyOf("\t"), "tab")
  assert.equal(keyOf("\x1b[9u"), "tab")
  assert.equal(keyOf("\x1b[9;1u"), "tab")
  assert.equal(keyOf("\x1b[Z"), "shift+tab")
  assert.equal(keyOf("\x1b[9;2u"), "shift+tab")
  assert.equal(keyOf("\x1b"), "escape")
  assert.equal(keyOf("\r"), "enter")
  assert.equal(keyOf("\x7f"), "backspace")
  assert.equal(keyOf("\b"), "backspace")
  assert.equal(keyOf("j"), "j")
  assert.equal(keyOf("é"), "é")
  assert.equal(keyOf("\x1b[A"), undefined, "an unknown escape sequence is not a key")
  assert.equal(keyOf("ab"), undefined, "a paste is not a key")
}

// ---- layout at 40x24: strip, filter, rows, detail, free rows, key bar -----------------------------------------

{
  const todo = fakeTab("todo", 3)
  const files = fakeTab("files", 2)
  const { entry } = await open([todo, files])
  assert.equal(entry.options.overlay, true)
  assert.equal(entry.options.overlayOptions.anchor, "right-center")
  assert.equal(entry.options.overlayOptions.width, "38%")
  assert.equal(todo.loads(), 1, "the initial tab loads on open")
  assert.equal(files.loads(), 1, "an inactive tab loads on open too, so the strip shows its count")
  const out = lines(entry)
  assert.equal(out.length, 24, "exactly the terminal height")
  assert.equal(out[0], row(" todo 3 │ files 2                1 / 3"), "every tab with its count, the selection counter at the right")
  assert.equal(out[1], filterLine(""))
  assert.equal(out[2], HAIRLINE, "a hairline under the filter")
  assert.equal(out[3], row("first half                           x"))
  assert.equal(out[4], row("> todo item 1                       :1"))
  assert.equal(out[5], row("  todo item 2                       :2"))
  assert.equal(out[6], row(""), "one blank row before a section that is not the first")
  assert.equal(out[7], row("second half                          x"))
  assert.equal(out[8], row("  todo item 3                       :3"))
  // The detail sits right under the list: a hairline, the title, a blank row, the lines; free rows, then the key bar.
  assert.equal(out[9], HAIRLINE)
  assert.equal(out[10], row("todo-1"))
  assert.equal(out[11], row(""))
  assert.equal(out[12], row("detail of todo-1"))
  assert.equal(out[13], row("second line"))
  assert.ok(out.slice(14, 21).every((l: string) => l === row("")), "free rows go between the detail and the key bar")
  assert.deepEqual(out.slice(21), KEYS)
  assert.ok(out.every((l: string) => l.startsWith(B)), "every row sits behind the left border")
  assert.ok(raw(entry).every((l: string) => Bun.stringWidth(l) === 40), "every line fills the width, escapes not counted")
  // The active tab and the selected row are solid blocks (reverse video over accent text); nothing else is.
  assert.deepEqual(raw(entry).flatMap((l: string, i: number) => (l.includes("\x1b[7m") ? [i] : [])), [0, 4])
  assert.ok(raw(entry)[4]!.startsWith("│ \x1b[7m> todo item 1") && raw(entry)[4]!.endsWith(":1\x1b[27m"), "the block spans the whole row")
}

// ---- scroll past the rows area keeps the selection visible ---------------------------------------------------

{
  const { entry } = await open([fakeTab("todo", 30)], 0, { rows: 12, columns: 60 })
  const out = lines(entry, 40)
  assert.equal(out.length, 12)
  assert.deepEqual(out.slice(-3), KEYS, "the key bar is never cropped")
  assert.equal(out[3], row("first half                           x"))
  assert.equal(out[4], row("> todo item 1                       :1"))
  // 12 rows - strip - filter - hairline - 3 key rows = 6 row lines, no room for a detail: head + 5 items.
  assert.ok(!out.some((l: string) => l.includes("item 6")), "item 6 is past the rows area")
  await press(entry, "j", "j", "j", "j", "j", "j")
  assert.equal(selected(entry), row("> todo item 7                       :7"))
  assert.ok(!lines(entry, 40).some((l: string) => l.includes("item 1 ")), "the window scrolled")
  await press(entry, FAKE_KEYS["tui.select.pageDown"]!)
  // One page = the row lines the last draw had (6): from item 7 to item 13.
  assert.ok(selected(entry).includes("item 13"), selected(entry))
  await press(entry, FAKE_KEYS["tui.select.pageUp"]!, FAKE_KEYS["tui.select.pageUp"]!, "k")
  assert.equal(selected(entry), row("> todo item 1                       :1"), "k and pageUp clamp at the first item")
  await press(entry, FAKE_KEYS["tui.select.down"]!)
  assert.ok(selected(entry).includes("item 2"))
}

// ---- tab and shift+tab switch and reset ----------------------------------------------------------------------

{
  const todo = fakeTab("todo", 3)
  const files = fakeTab("files", 2)
  const log = fakeTab("log", 1)
  const { entry } = await open([todo, files, log], 0)
  await press(entry, "j", "/", "x")
  assert.ok(lines(entry)[1]!.startsWith(B + "> x█ "), "typing in the filter shows the cursor")
  await press(entry, "\x1b", "\t")
  assert.equal(files.loads(), 2, "the tab loads again when it becomes active (it also loaded on open)")
  assert.equal(lines(entry)[0]!.includes("files 2"), true)
  assert.equal(lines(entry)[1], filterLine(""), "filter and selection reset")
  assert.equal(counter(lines(entry)), "1 / 2")
  await press(entry, "\x1b[Z")
  assert.ok(selected(entry).includes("todo item 1"))
  await press(entry, "\x1b[Z")
  assert.ok(selected(entry).includes("log item 1"), "shift+tab wraps")
  await press(entry, "\x1b[9u")
  assert.ok(selected(entry).includes("todo item 1"), "tab wraps and the kitty form counts")
}

// ---- the filter is a mode: `/` enters, printable keys type, enter and esc leave, esc then clears, then closes --

{
  const tab = fakeTab("todo", 12)
  const { entry, closed } = await open([tab])
  // Outside the filter a printable key the tab does not list is ignored, and backspace does nothing.
  await press(entry, "x", "\x7f")
  assert.equal(lines(entry)[1], filterLine(""))
  assert.equal(counter(lines(entry)), "1 / 12")
  await press(entry, "/")
  assert.equal(lines(entry)[1], filterLine("█"), "the filter line shows the cursor")
  assert.equal(counter(lines(entry)), "1 / 12")
  await press(entry, "1")
  const out = lines(entry)
  assert.equal(out[1], filterLine("1█"))
  assert.equal(counter(out), "1 / 4")
  assert.ok(out.some((l: string) => l.includes("item 12")) && !out.some((l: string) => l.includes("item 2 ")))
  await press(entry, "\x7f")
  assert.equal(lines(entry)[1], filterLine("█"))
  assert.equal(counter(lines(entry)), "1 / 12")
  // Letters the tab lists (e), the panel's own (j k q) and tab keys do not act while typing: letters type.
  await press(entry, "e", "j", "k", "q", "\t", "\x1b[Z")
  assert.equal(tab.acts.length, 0, "no tab key acts while typing")
  assert.equal(entry.closed, false, "q does not close while typing")
  assert.ok(lines(entry)[1]!.startsWith(B + "> ejkq█ "), lines(entry)[2])
  await press(entry, "\r")
  assert.ok(lines(entry)[1]!.startsWith(B + "> ejkq "), "enter left the filter and kept the text")
  // Outside the filter again: esc clears, then closes.
  await press(entry, "\x1b")
  assert.equal(entry.closed, false, "esc with a filter clears it")
  assert.equal(lines(entry)[1], filterLine(""))
  assert.equal(counter(lines(entry)), "1 / 12")
  await press(entry, "/", "2", "\x1b")
  assert.equal(entry.closed, false, "esc in the filter leaves it and keeps the text")
  assert.equal(lines(entry)[1], filterLine("2"))
  assert.equal(counter(lines(entry)), "1 / 2")
  await press(entry, "e")
  assert.deepEqual(tab.acts, [["e", "todo-2"]], "outside the filter the tab's key acts again")
  await press(entry, "/", "\x7f", "\x1b")
  assert.equal(entry.closed, true, "esc on an empty filter closes")
  await closed
}

// ---- typing "sds" in the filter never acts: the same letters outside the filter do ------------------------------

{
  const tab = fakeTab("files", 3, { keys: [["enter", "open"], ["s", "stage"], ["d", "diff"]] })
  const { entry } = await open([tab])
  await press(entry, "/", "s", "d", "s")
  assert.equal(tab.acts.length, 0)
  assert.ok(lines(entry)[1]!.startsWith(B + "> sds█"))
  await press(entry, "\r", "s")
  assert.equal(tab.acts.length, 0, "no row matches sds, so s has nothing to act on")
  await press(entry, "\x1b", "s")
  assert.deepEqual(tab.acts, [["s", "files-1"]])
}

// ---- a filter change prefetches the new selection's detail --------------------------------------------------------

{
  const asked: string[] = []
  const tab = fakeTab("todo", 3, { prefetch: async (id: string) => void asked.push(id) })
  const { entry } = await open([tab])
  assert.deepEqual(asked, ["todo-1"])
  await press(entry, "/", "3")
  assert.deepEqual(asked, ["todo-1", "todo-3"], "the filtered selection's detail is asked for at once")
}

// ---- a short terminal gives up the detail first, then the blank rows; never the key bar or the selected row ------

{
  const eight = (id: string): Detail => ({ title: id, lines: Array.from({ length: 12 }, (_, i) => ({ text: `${id} line ${i + 1}` })) })
  const hasDetail = (out: string[]) => out.some((l: string) => l.includes("line 1"))
  // todo has 5 items in two sections: 8 lines with the blank row between them, 7 without.
  const at = async (rows: number, tab = fakeTab("todo", 5, { detail: eight })) => lines((await open([tab], 0, { rows, columns: 60 })).entry, 40)
  const tall = await at(40)
  assert.ok(hasDetail(tall) && tall.includes(row("")), "plenty of height: the detail and the blank rows")
  assert.ok(tall.includes(row("… 3 más")), "a detail cut at ten lines says how many it left out")
  assert.equal(tall.filter((l: string) => l.includes("line ")).length, 9, "nine lines and the marker fill the ten")
  // Taller than the list but short of the detail's smallest form: the list keeps its blank row, the detail goes.
  const mid = await at(14)
  assert.ok(!hasDetail(mid), "the detail goes first")
  assert.equal(mid.filter((l: string) => l === row("")).length, 1, "the blank row between sections stays")
  assert.deepEqual(mid.slice(-3), KEYS)
  // Too short for the blank row: it goes, then rows scroll; the selection stays in view.
  const short = await at(13)
  assert.ok(!hasDetail(short) && !short.slice(3, -3).includes(row("")), "then the blank rows go")
  assert.equal(short.slice(3, -3).filter((l: string) => l.startsWith(B + "  ") || l.startsWith(B + "> ")).length, 5)
  for (const rows of [12, 10, 8, 7]) {
    const out = await at(rows)
    assert.equal(out.length, rows)
    assert.deepEqual(out.slice(-3), KEYS, `${rows} rows: the whole key bar`)
    assert.ok(out.some((l: string) => l.startsWith(B + "> todo item 1")), `${rows} rows: the selected row`)
    assert.ok(!hasDetail(out))
  }
  // Moving down on a short list keeps the selected row on screen.
  const scroll = await open([fakeTab("todo", 5, { detail: eight })], 0, { rows: 8, columns: 60 })
  await press(scroll.entry, "j", "j", "j", "j")
  assert.ok(selected(scroll.entry).includes("item 5"))
  assert.deepEqual(lines(scroll.entry, 40).slice(-3), KEYS)
}

// ---- the key bar wraps and drops nothing, at 40, 46 and 61 cells --------------------------------------------------

{
  const all = ["enter", "do it", "e", "edit", "/", "filtrar", "j/k", "mover", "tab", "pestaña", "esc", "cerrar"]
  for (const [cols, kbRows] of [[40, 3], [46, 3], [61, 2], [100, 2]] as const) {
    const { entry } = await open([fakeTab("todo", 3)], 0, { rows: 30, columns: cols })
    const out = lines(entry, cols)
    const bar = out.slice(-kbRows)
    assert.ok(out[out.length - kbRows - 1]!.trim() === "│", `${cols}: ${kbRows} key rows exactly`)
    const text = bar.join(" ")
    for (const word of all) assert.ok(text.includes(word), `${cols}: ${word} is on the key bar`)
    assert.ok(bar[0]!.includes("enter") && bar[0]!.includes("edit"), `${cols}: the tab's keys start the first row`)
    assert.ok(!bar[0]!.includes("filtrar"), "the panel's keys come after, on a row of their own")
    assert.ok(raw(entry, cols).every((l: string) => Bun.stringWidth(l) === cols), `${cols}: every line is as wide as the panel`)
  }
  // A tab with many keys wraps its own too.
  const many = fakeTab("files", 1, { keys: [["enter", "nvim"], ["s", "stage"], ["d", "diff"], ["x", "one more key here"], ["y", "and another"]] })
  const { entry } = await open([many], 0, { rows: 30, columns: 40 })
  const out = lines(entry, 40)
  const text = out.slice(-6).join(" ")
  for (const word of ["nvim", "stage", "diff", "one more key here", "and another", "filtrar", "mover", "pestaña", "cerrar"]) assert.ok(text.includes(word), word)
}

// ---- the theme: only omp's names, the row marker colored, the filter key listed ---------------------------------

{
  assert.throws(() => FAKE_THEME.fg("background", "x"), /Unknown theme color background/)
  assert.throws(() => FAKE_THEME.bg("accent", "x"), /Unknown theme background color accent/)
  const tab = fakeTab("files", 2, {
    rows: () => [{ kind: "item", text: "A x", right: "+1", id: "a" }, { kind: "item", text: "M y", id: "b", color: "success" }],
  })
  const ctx = makeCtx({ mode: "tui", hasUI: true, theme: makeTheme(true) })
  void openPanel(ctx, [tab], 0)
  await tick()
  const out = ctx.recorded.custom.at(-1)!.component.render(60)
  assert.ok(out.some((l: string) => l.startsWith("<border>│</border>   <success>M</success> y")), "an unselected row's marker is its first grapheme, colored; the rest is plain")
  // The panel keys, on the last key row at a width that fits them, list the filter key; the frame is drawn in `border`.
  assert.ok(out.at(-1)!.includes("filtrar"), out.at(-1))
  assert.ok(out.every((l: string) => l.startsWith("<border>│</border> ")), "the left border on every row, no top or bottom rule")
  assert.ok(out.some((l: string) => l.startsWith("<border>│</border> <borderMuted>──")), "the hairlines are borderMuted")
}

// ---- act: notice, refresh, close; q closes ---------------------------------------------------------------------

{
  const tab = fakeTab("todo", 3)
  const { ctx, entry, closed } = await open([tab])
  tab.answer({ kind: "notice", text: "hello" })
  await press(entry, "e")
  assert.deepEqual(tab.acts, [["e", "todo-1"]])
  assert.deepEqual(ctx.recorded.notify.at(-1), ["hello", "warning"])
  tab.answer({ kind: "refresh" })
  await press(entry, "j", "\r")
  assert.deepEqual(tab.acts.at(-1), ["enter", "todo-2"])
  assert.equal(tab.loads(), 2, "refresh reloads the tab")
  assert.ok(selected(entry).includes("item 2"), "the selection is kept by id")
  // A refresh with a notice says it first, then reloads: the rows are not left stale under it.
  tab.answer({ kind: "refresh", notice: "changed on disk" })
  await press(entry, "\r")
  assert.deepEqual(ctx.recorded.notify.at(-1), ["changed on disk", "warning"])
  assert.equal(tab.loads(), 3, "a refresh with a notice reloads too")
  assert.ok(selected(entry).includes("item 2"), "the selection is kept by id")
  // A key the tab does not list is ignored outside the filter: not sent to act(), not typed.
  await press(entry, "z")
  assert.equal(tab.acts.length, 3, "a key the tab does not list is not sent")
  assert.equal(lines(entry)[1], filterLine(""))
  assert.equal(counter(lines(entry)), "2 / 3")
  await press(entry, "j")
  tab.answer({ kind: "close" })
  await press(entry, "\r")
  assert.equal(entry.closed, true)
  await closed
  const again = await open([fakeTab("todo", 1)])
  await press(again.entry, "q")
  assert.equal(again.entry.closed, true)
  await again.closed
}

// ---- esc during a running action closes; other keys wait ------------------------------------------------------

{
  const tab = fakeTab("todo", 3)
  const release = tab.hold()
  const { ctx, entry, closed } = await open([tab])
  await press(entry, "\r", "j", "j")
  assert.ok(selected(entry).includes("item 1"), "keys are ignored while the action runs")
  assert.equal(tab.acts.length, 1)
  await press(entry, "\x1b")
  assert.equal(entry.closed, true, "esc closes at once")
  tab.answer({ kind: "notice", text: "late" })
  release()
  await tick()
  assert.ok(!ctx.recorded.notify.some(([t]: [string]) => t === "late"), "a notice after close is dropped")
  await closed
}

// ---- openEditor: zellij pane request; foot argv outside zellij; no foot -> notice -------------------------------

{
  const { openEditor } = await import("../extensions/ecomono/panel/editor.ts")
  const spawned: Array<[string[], any]> = []
  const spawn = (argv: string[], opts: any) => (spawned.push([argv, opts]), { unref: () => void (opts.unrefed = true) })
  const which = (name: string) => (name === "foot" ? "/bin/foot" : null)
  const mk = (over: Record<string, any> = {}) => makeCtx({ mode: "tui", hasUI: true, cwd: "/w", ...over })

  // Inside zellij: a pane next to omp, $EDITOR split on whitespace, +line first.
  await withEnv({ ZELLIJ: "0", EDITOR: "nvim -u NONE" }, async () => {
    const ctx = mk()
    await openEditor(ctx, "/w/docs/a.md", 7, { spawn, which })
    assert.deepEqual(ctx.recorded.openTerminal, [{ multiplexer: "zellij", placement: "pane", command: ["nvim", "-u", "NONE", "+7", "/w/docs/a.md"], cwd: "/w" }])
    assert.equal(spawned.length, 0)
  })
  // Outside zellij: a detached foot window with omp's stdio kept out of it; $EDITOR unset -> nvim.
  await withEnv({ ZELLIJ: undefined, EDITOR: undefined }, async () => {
    const ctx = mk()
    await openEditor(ctx, "/w/docs/a.md", 7, { spawn, which })
    assert.equal(ctx.recorded.openTerminal.length, 0)
    assert.deepEqual(spawned[0]![0], ["/bin/foot", "--working-directory=/w", "nvim", "+7", "/w/docs/a.md"])
    assert.deepEqual(spawned[0]![1].stdio, ["ignore", "ignore", "ignore"])
    assert.equal(spawned[0]![1].unrefed, true, "the window outlives omp and never blocks it")
    assert.equal(ctx.recorded.notify.length, 0)
  })
  // No foot either: the notice names the place to open by hand. A pane request that throws does the same.
  await withEnv({ ZELLIJ: undefined }, async () => {
    const ctx = mk()
    await openEditor(ctx, "/w/docs/a.md", 7, { spawn, which: () => null })
    assert.ok(ctx.recorded.notify.at(-1)![0].includes("/w/docs/a.md:7"), JSON.stringify(ctx.recorded.notify))
  })
  await withEnv({ ZELLIJ: "0" }, async () => {
    const ctx = mk()
    ctx.ui.openTerminal = () => Promise.reject(new Error("zellij launch requires an active Zellij session"))
    await openEditor(ctx, "/w/docs/a.md", 7, { spawn, which })
    const said = ctx.recorded.notify.at(-1)![0]
    assert.ok(said.includes("/w/docs/a.md:7") && said.includes("active Zellij session"), said)
  })
}

// ---- a tab whose load fails shows why in place of its rows; the panel stays open ---------------------------------

{
  const good = fakeTab("todo", 2)
  const bad = fakeTab("files", 2, { load: async () => { throw new Error("git rev-parse: fatal: not a git repository") } })
  const { ctx, entry } = await open([good, bad], 1)
  const out = lines(entry)
  assert.equal(out.length, 24)
  // Wrapped, not cut: the second line holds the end of git's reason.
  assert.equal(out[3], row("  git rev-parse: fatal: not a git"))
  assert.equal(out[4], row("  repository"))
  assert.equal(lines(entry)[1], filterLine(""))
  assert.equal(counter(lines(entry)), "0 / 0")
  assert.equal(ctx.recorded.notify.length, 0, "the failure is drawn, not notified")
  assert.equal(entry.closed, false)
  // shift+tab to the working tab: its rows draw, the failure is gone; back again, it is shown again.
  await press(entry, "\x1b[Z")
  assert.ok(selected(entry).includes("todo item 1"))
  assert.ok(!lines(entry).some((l: string) => l.includes("not a git")))
  await press(entry, "\t")
  assert.ok(lines(entry)[3]!.includes("not a git"))
}

// ---- an error never outlives its tab, and never pushes the frame out -----------------------------------------------

{
  // (a) tab A fails, tab B loads: B's rows show, no error text.
  const a = fakeTab("files", 2, { load: async () => { throw new Error("boom in files") } })
  const b = fakeTab("todo", 2)
  const { entry } = await open([a, b], 0)
  assert.ok(lines(entry).some((l: string) => l.includes("boom in files")))
  await press(entry, "\t")
  assert.ok(selected(entry).includes("todo item 1"))
  assert.ok(!lines(entry).some((l: string) => l.includes("boom")))
  // Before B's load settles the error is already gone: activate() clears it.
  const slow = fakeTab("slow", 2, { load: () => new Promise<void>(() => {}) })
  const c = await open([a, slow], 0)
  c.entry.component.handleInput("\t")
  assert.ok(!lines(c.entry).some((l: string) => l.includes("boom")), "the previous tab's error is cleared on switch")
}

{
  // (b) a tab that loaded once, then its refresh load throws: typing and backspace keep the rows empty.
  let fail = false
  const tab = fakeTab("todo", 3, { load: async () => { if (fail) throw new Error("refresh broke") } })
  const { entry } = await open([tab])
  assert.ok(selected(entry).includes("todo item 1"))
  tab.answer({ kind: "refresh" })
  fail = true
  await press(entry, "\r")
  for (const keys of [["/", "t"], ["\x7f"]]) {
    await press(entry, ...keys)
    const out = lines(entry)
    assert.equal(out.length, 24)
    assert.ok(out.some((l: string) => l.includes("refresh broke")))
    assert.ok(!out.some((l: string) => l.includes("todo item")), "stale rows stay out")
    assert.deepEqual(out.slice(-3), KEYS)
  }
}

{
  // (c) a slow failing load: keys (a tab switch among them) are held while it runs, so its failure lands on
  // its own tab; the load-generation guard in panel.ts is the second line for any outcome that arrives late.
  let release!: () => void
  const slowBad = fakeTab("files", 2, { load: () => new Promise<void>((_, rej) => (release = () => rej(new Error("late failure")))) })
  const good = fakeTab("todo", 2)
  const { entry } = await open([slowBad, good], 0)
  await press(entry, "\t")
  assert.ok(!lines(entry).some((l: string) => l.includes("todo item")), "no tab switch while a load runs")
  release()
  await tick()
  assert.ok(lines(entry).some((l: string) => l.includes("late failure")))
  await press(entry, "\t")
  assert.ok(selected(entry).includes("todo item 1"))
  assert.ok(!lines(entry).some((l: string) => l.includes("late failure")))
}

// ---- the strip and the key bar never nest a bg span inside another ---------------------------------------------

{
  const ctx = makeCtx({ mode: "tui", hasUI: true, terminal: { rows: 24, columns: 60 }, theme: makeTheme(false, true) })
  void openPanel(ctx, [fakeTab("todo", 2), fakeTab("files", 2)], 0)
  await tick()
  const out = ctx.recorded.custom.at(-1)!.component.render(60)
  assert.equal(out.length, 24)
  for (const l of out) {
    assert.equal(Bun.stringWidth(Bun.stripANSI(l)), 60, JSON.stringify(l))
    // A stack scan: a bg open while another is open means the inner closer resets the outer's background.
    let open = false
    for (const m of l.matchAll(/\x1b\[(48;5;2|49)m/g)) {
      if (m[1] === "49") {
        assert.ok(open, "a bg close without an open")
        open = false
      } else {
        assert.ok(!open, `nested bg span: ${JSON.stringify(l)}`)
        open = true
      }
    }
    assert.ok(!open, "a bg span is never closed")
    // Reverse video, the accent block, is opened and closed in pairs on a line, so it never leaks into the next one.
    assert.equal((l.match(/\x1b\[7m/g) ?? []).length, (l.match(/\x1b\[27m/g) ?? []).length)
  }
}

// ---- every line is exactly as wide as the panel, whatever the width, height and text ---------------------------------

{
  const wide = fakeTab("todo", 6, {
    rows: () => [
      { kind: "head", text: "漢字 head that is much too long to fit in any of the widths tried here", right: "9" },
      { kind: "item", text: "○ 漢字漢字 and a 😀 emoji in a title long enough to need a cut", right: ":123", id: "a" },
      { kind: "item", text: "M some/very/long/directory/path/to/a/file-with-a-long-name.ts", right: "", add: 12, del: 3, id: "b", cut: "start" },
      { kind: "item", text: "a-single-word-that-is-wider-than-every-budget-we-try-here-x", id: "c" },
    ],
    detail: () => ({ title: "漢字/dir/with/a/very/long/path/and-a-name.ts", tail: "@@ -1,3 +1,4 @@ 漢字", note: "漢字 · 2 days ago", lines: [{ text: "+漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字", no: 1, kind: "add" }, { text: "-x", no: 1234, kind: "del" }, { text: " ctx" }] }),
  })
  for (const cols of [40, 46, 61]) {
    for (const rows of [6, 9, 12, 16, 24, 40]) {
      const { entry } = await open([wide, fakeTab("files", 1)], 0, { rows, columns: cols })
      const out = raw(entry, cols)
      assert.equal(out.length, rows, `${cols}x${rows}`)
      for (const l of out) assert.equal(Bun.stringWidth(l), cols, `${cols}x${rows}: ${JSON.stringify(l)}`)
      assert.deepEqual(out.slice(-2).map((l: string) => l.replace(SGR_REVERSE, "")).join("").includes("cerrar"), true, `${cols}x${rows}: the key bar`)
      assert.ok(out.some((l: string) => l.includes("\x1b[7m>")), `${cols}x${rows}: the selected row`)
    }
  }
}

// ---- an open-time load of an inactive tab is one load: activating the tab joins it ------------------------------

{
  let loads = 0
  let release!: () => void
  const cache = new Map<string, Detail>()
  const slow = fakeTab("files", 2, {
    load: async () => {
      loads++
      await new Promise<void>((r) => (release = r))
      cache.clear()
    },
    prefetch: async (id) => void cache.set(id, { title: id, lines: [{ text: `fetched ${id}` }] }),
    detail: (id) => cache.get(id),
  })
  const { entry } = await open([fakeTab("todo", 2), slow], 0)
  await press(entry, "\t") // the open-time load of `files` is still in flight
  assert.equal(loads, 1, "the activation joins the open-time load")
  release()
  await tick()
  await tick()
  assert.equal(loads, 1, "one load in all")
  assert.ok(selected(entry).includes("files item 1"), "the rows are there")
  assert.ok(lines(entry).some((l: string) => l.includes("fetched files-1")), "the selected row's detail is present")
}

{
  // A synchronous throw of an open-time load does not stop the panel from opening; the error stays on its tab.
  const bad = fakeTab("files", 2, { load: () => { throw new Error("sync boom") } })
  const { entry } = await open([fakeTab("todo", 2), bad], 0)
  assert.ok(selected(entry).includes("todo item 1"), "the panel opened")
  assert.ok(!lines(entry).some((l: string) => l.includes("sync boom")), "the active tab does not show another tab's error")
  await press(entry, "\t")
  assert.ok(lines(entry).some((l: string) => l.includes("sync boom")), "the error shows on its own tab")
}

// ---- a newline in a row's text is one line of exactly the panel width ---------------------------------------------

{
  const nl = fakeTab("files", 1, {
    rows: () => [{ kind: "item", text: "M dir/na\nme.ts", id: "x", add: 1 }],
    detail: () => ({ title: "dir/na\nme.ts", lines: [{ text: "a\nb" }] }),
  })
  const { entry } = await open([nl], 0)
  const out = raw(entry, 40)
  assert.equal(out.length, 24)
  for (const l of out) assert.ok(!l.includes("\n") && Bun.stringWidth(l) === 40, JSON.stringify(l))
  assert.ok(out.some((l: string) => l.includes("na me.ts")), "a newline is a space")
}

console.log("test_panel: all assertions passed")
