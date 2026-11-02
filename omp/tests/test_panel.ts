// The omp side panel (omp/extensions/ecomono/panel/panel.ts) driven through fake-pi's ctx.ui.custom with a fake
// tab. Plain assert script: no omp, no git, no process. Also the key decoder and openEditor (panel/editor.ts).
import { FAKE_KEYS, FAKE_THEME, makeCtx, makeTheme, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import type { Action, Row, Tab } from "../extensions/ecomono/panel/model.ts"
import { keyOf } from "../extensions/ecomono/panel/keys.ts"
import { openPanel } from "../extensions/ecomono/panel/panel.ts"

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
    detail: (id) => [`detail of ${id}`, "second line"],
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
/** The filter line at 40 columns: `> ` + text, the position right-aligned in the 36 that remain. */
const filterLine = (text: string, pos: string): string => row(`> ${text}${" ".repeat(36 - Bun.stringWidth(text) - pos.length)}${pos}`)
/** The key bar's second row at 40 columns: `tab pestaña` is the one that is cropped, never `/ filtrar` or `esc cerrar`. */
const KEYS2 = row(" / filtrar   esc cerrar   j/k mover")
const TOP = "┌" + "─".repeat(39)
const BOTTOM = "└" + "─".repeat(39)
const lines = (entry: any, width = 40): string[] => entry.component.render(width)
/** The selected row: the `│ > ` line below the filter line (which starts the same way). */
const selected = (entry: any): string => lines(entry).slice(3).find((l: string) => l.startsWith(B + "> "))!

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

// ---- layout at 40x24: strip, filter, rows, detail, key bar ----------------------------------------------------

{
  const todo = fakeTab("todo", 3)
  const files = fakeTab("files", 2)
  const { entry } = await open([todo, files])
  assert.equal(entry.options.overlay, true)
  assert.equal(entry.options.overlayOptions.anchor, "right-center")
  assert.equal(entry.options.overlayOptions.width, "38%")
  assert.equal(todo.loads(), 1, "the initial tab loads on open")
  assert.equal(files.loads(), 0, "an inactive tab does not load")
  const out = lines(entry)
  assert.equal(out.length, 24, "exactly the terminal height")
  assert.equal(out[0], TOP, "a top rule with a sharp corner")
  assert.equal(out[1], row(" todo 3  files 2            tab cambia"), "the hint sits at the right edge of the band")
  assert.equal(out[2], filterLine("", "1 / 3"))
  assert.equal(out[3], row("first half                           x"))
  assert.equal(out[4], row("> todo item 1                       :1"))
  assert.equal(out[5], row("  todo item 2                       :2"))
  assert.equal(out[6], row("second half                          x"))
  assert.equal(out[7], row("  todo item 3                       :3"))
  // Detail block after a rule off the border, then blank fill, then the two key-bar rows and the bottom rule.
  const rule = out.findIndex((l: string) => l.startsWith("├"))
  assert.ok(rule > 7, "a rule precedes the detail")
  assert.equal(out[rule], "├" + "─".repeat(39))
  assert.equal(out[rule + 1], row("detail of todo-1"))
  assert.equal(out[rule + 2], row("second line"))
  assert.equal(out[21], row(" enter do it   e edit"))
  assert.equal(out[22], KEYS2)
  assert.equal(out[23], BOTTOM)
  assert.ok(out[22].includes("/ filtrar") && out[22].includes("esc cerrar"), "filter mode and close are discoverable at the narrowest width")
  assert.ok(out.slice(1, 23).every((l: string, i: number) => l.startsWith(i + 1 === rule ? "├" : B)), "every content row sits behind the left border")
  assert.ok(out.every((l: string) => Bun.stringWidth(l) === 40), "every line fills the width")
}

// ---- scroll past the rows area keeps the selection visible ---------------------------------------------------

{
  const { entry } = await open([fakeTab("todo", 30)], 0, { rows: 12, columns: 60 })
  const out = lines(entry, 40)
  assert.equal(out.length, 12)
  assert.equal(out.at(-2), KEYS2, "the key bar is never cropped")
  assert.equal(out.at(-1), BOTTOM)
  assert.equal(out[3], row("first half                           x"))
  assert.equal(out[4], row("> todo item 1                       :1"))
  // 12 rows - top rule - strip - filter - rule - 2 detail - 2 keys - bottom rule = 3 row lines: head + 2 items.
  assert.ok(!out.some((l: string) => l.includes("item 3")), "item 3 is past the rows area")
  await press(entry, "j", "j", "j", "j", "j")
  assert.equal(selected(entry), row("> todo item 6                       :6"))
  assert.ok(!lines(entry, 40).some((l: string) => l.includes("item 1 ")), "the window scrolled")
  await press(entry, FAKE_KEYS["tui.select.pageDown"]!)
  // One page = the row lines at 12 rows (3): from item 6 to item 9.
  assert.ok(selected(entry).includes("item 9"), selected(entry))
  await press(entry, FAKE_KEYS["tui.select.pageUp"]!, FAKE_KEYS["tui.select.pageUp"]!, FAKE_KEYS["tui.select.pageUp"]!, "k")
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
  assert.ok(lines(entry)[2]!.startsWith(B + "> x█ "), "typing in the filter shows the cursor")
  await press(entry, "\x1b", "\t")
  assert.equal(files.loads(), 1, "the tab loads when it becomes active")
  assert.equal(lines(entry)[1]!.includes("files 2"), true)
  assert.equal(lines(entry)[2], filterLine("", "1 / 2"), "filter and selection reset")
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
  assert.equal(lines(entry)[2], filterLine("", "1 / 12"))
  await press(entry, "/")
  assert.equal(lines(entry)[2], filterLine("█", "1 / 12"), "the filter line shows the cursor")
  await press(entry, "1")
  const out = lines(entry)
  assert.equal(out[2], filterLine("1█", "1 / 4"))
  assert.ok(out.some((l: string) => l.includes("item 12")) && !out.some((l: string) => l.includes("item 2 ")))
  await press(entry, "\x7f")
  assert.equal(lines(entry)[2], filterLine("█", "1 / 12"))
  // Letters the tab lists (e), the panel's own (j k q) and tab keys do not act while typing: letters type.
  await press(entry, "e", "j", "k", "q", "\t", "\x1b[Z")
  assert.equal(tab.acts.length, 0, "no tab key acts while typing")
  assert.equal(entry.closed, false, "q does not close while typing")
  assert.ok(lines(entry)[2]!.startsWith(B + "> ejkq█ "), lines(entry)[2])
  await press(entry, "\r")
  assert.ok(lines(entry)[2]!.startsWith(B + "> ejkq "), "enter left the filter and kept the text")
  // Outside the filter again: esc clears, then closes.
  await press(entry, "\x1b")
  assert.equal(entry.closed, false, "esc with a filter clears it")
  assert.equal(lines(entry)[2], filterLine("", "1 / 12"))
  await press(entry, "/", "2", "\x1b")
  assert.equal(entry.closed, false, "esc in the filter leaves it and keeps the text")
  assert.equal(lines(entry)[2], filterLine("2", "1 / 2"))
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
  assert.ok(lines(entry)[2]!.startsWith(B + "> sds█"))
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

// ---- a short terminal keeps one row and the whole key bar when the detail is long ---------------------------------

{
  const eight = (id: string) => Array.from({ length: 8 }, (_, i) => `${id} line ${i + 1}`)
  const { entry } = await open([fakeTab("todo", 5, { detail: eight })], 0, { rows: 12, columns: 60 })
  const out = lines(entry, 40)
  assert.equal(out.length, 12)
  assert.equal(out.at(-3), row(" enter do it   e edit"))
  assert.equal(out.at(-2), KEYS2, "the key bar is last before the bottom rule")
  assert.equal(out.at(-1), BOTTOM)
  assert.ok(out.some((l: string) => l.startsWith(B + "> todo item 1")), "one row line is kept")
  // 12 - 7 chrome lines - 1 row = 4 detail lines.
  assert.equal(out.filter((l: string) => l.includes("line ")).length, 4, "the detail is capped at height - chrome - one row")
  assert.ok(out.every((l: string) => Bun.stringWidth(l) === 40))
  // The smallest terminal (8 rows): no detail, one row, the key bar, both rules.
  const tiny = await open([fakeTab("todo", 5, { detail: eight })], 0, { rows: 8, columns: 60 })
  assert.equal(lines(tiny.entry, 40).length, 8)
  assert.equal(lines(tiny.entry, 40).at(-2), KEYS2)
  assert.ok(!lines(tiny.entry, 40).some((l: string) => l.includes("line ")), "no detail fits")
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
  // The key bar's second row, at a width that fits it, lists the filter key; the frame is drawn in `border`.
  assert.ok(out.at(-2)!.includes("filtrar"), out.at(-2))
  assert.equal(out[0], "<border>┌" + "─".repeat(59) + "</border>")
  assert.equal(out.at(-1), "<border>└" + "─".repeat(59) + "</border>")
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
  assert.equal(lines(entry)[2], filterLine("", "2 / 3"))
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
  assert.equal(lines(entry)[2], filterLine("", "0 / 0"))
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
    assert.equal(out[22], KEYS2)
    assert.equal(out[23], BOTTOM)
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
  }
}

console.log("test_panel: all assertions passed")
