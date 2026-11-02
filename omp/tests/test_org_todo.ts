// The org-todo widget of the omp extension and the parser it shares with OpenCode's TUI plugin, driven through
// fake-pi. Plain assert script. pi.exec is a stub: no omp, no network; the one real process is the grep that
// checks the shared PATTERN against fixture files in a temp dir.
import { FAKE_THEME, dir, makeCtx, makePi, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PATTERN, flipLine, parse, rank } from "../../opencode/tui-plugins/org-todo/core.ts"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"

// A main session_start checks $HOME/.claude/skills/ecomono-sdd-shared (the extension reads process.env.HOME per
// call), so the file runs under a temp HOME that has it: the real home is never consulted and the machine cannot
// change a result. Restored at the end of the file.
const hostHome = process.env.HOME
const fakeHome = dir("home")
mkdirSync(join(fakeHome, ".claude/skills/ecomono-sdd-shared"), { recursive: true })
process.env.HOME = fakeHome

const setup = (over: Record<string, any> = {}, opts: Parameters<typeof makePi>[0] = {}) => {
  const { pi, fire, calls } = makePi(opts)
  ecomono({ repo: REPO })(pi)
  return { fire, calls, ctx: makeCtx(over) }
}
/** A hang in the code under test fails the run instead of freezing it. */
const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms))])

/** The grep calls of a run: session_start also execs the skill-registry generator, which is not under test here. */
const greps = (calls: ReturnType<typeof makePi>["calls"]) => calls.exec.filter(([command]) => command === "grep")
const grepOut = (stdout: string) => ({ stdout, stderr: "", code: stdout ? 0 : 1, killed: false })
/** What the skill-registry exec answers here: a clean exit, so it adds no warning of its own. */
const nodeOk = { stdout: "", stderr: "", code: 0, killed: false }
const start = (ctx: any, fire: (name: string, event: any, ctx: any) => Promise<any>) =>
  within(fire("session_start", { reason: "start" }, ctx))
/** The lines a widget's content draws at `width`, colors dropped. */
const draw = (content: any, width: number): string[] => content(null, FAKE_THEME).render(width)
/** The grep the widget asked for, run for real over the fixture files; `extra` lines are appended to its output. */
const realGrep = (args: string[], extra = "") => {
  const r = spawnSync("grep", args, { encoding: "utf8" })
  return { stdout: r.stdout + extra, stderr: r.stderr, code: r.status, killed: false }
}

// ---- the shared parser ----------------------------------------------------------------------------------------

{
  const out = [
    "/p/docs/a.md:4:- [ ] write the docs",
    "/p/docs/plan.org:7:** TODO ship it ",
    "/o/inbox.org:2:* BLOCKED wait for review",
    "/p/docs/b.md:9:  * [ ] nested box",
    "/p/docs/c.md:1:plain text, not a todo",
    "/p/docs/d.org:3:* DONE finished",
    "/p/docs/e.md:5:- [x] ticked",
    "no colon-separated location here",
    "",
  ].join("\n")
  assert.deepEqual(parse(out, ["/p/docs", "/o"]), [
    { file: "/p/docs/a.md", line: 4, text: "write the docs", kind: "md", src: "a.md" },
    { file: "/p/docs/plan.org", line: 7, text: "ship it", kind: "org", src: "plan.org" },
    { file: "/o/inbox.org", line: 2, text: "BLOCKED: wait for review", kind: "org", src: "inbox.org" },
    { file: "/p/docs/b.md", line: 9, text: "nested box", kind: "md", src: "b.md" },
  ])
  assert.deepEqual(parse("", ["/p"]), [])
  // A file outside every root keeps its full path as the source.
  assert.equal(parse("/x/y.org:1:* TODO z", ["/p"])[0]!.src, "/x/y.org")
}

{
  // PATTERN against a real grep, with the flags the widget uses: the parser sees exactly the lines that count.
  const docs = dir("docs")
  const org = dir("org")
  writeFileSync(join(docs, "a.md"), "# t\n- [ ] open one\n- [x] done\n  * [ ] nested\nprose\n")
  writeFileSync(join(docs, "skip.txt"), "- [ ] not scanned\n")
  writeFileSync(join(org, "b.org"), "* TODO first\n** BLOCKED second\n* DONE third\n")
  const r = spawnSync("grep", ["-rnHsE", "--include=*.org", "--include=*.md", PATTERN, docs, org], { encoding: "utf8" })
  assert.deepEqual(
    parse(r.stdout, [docs, org]).map((t) => `${t.src} ${t.line} ${t.text}`).sort(),
    ["a.md 2 open one", "a.md 4 nested", "b.org 1 first", "b.org 2 BLOCKED: second"],
  )
}

{
  // A CRLF file: grep keeps the "\r", which is not part of the todo.
  assert.deepEqual(parse("/p/a.md:1:- [ ] one\r\n/p/b.org:2:* TODO two\r", ["/p"]).map((t) => t.text), ["one", "two"])
}

// ---- rank: the newest dated file per directory, then the most recently changed file first ----------------------

{
  const todo = (file: string, line: number) => ({ file, line, text: `${file}:${line}`, kind: "md" as const, src: file })
  const todos = [
    todo("/o/fleet/2026-10-31.md", 1), // dated, an older report in its directory: dropped
    todo("/o/TODO.md", 1),
    todo("/o/fleet/2026-11-02.md", 1),
    todo("/o/fleet/2026-11-02.md", 2),
    todo("/o/fleet/2026-11-01.org", 3), // dated .org next to dated .md: one rule across both extensions
    todo("/p/docs/2026-01-01.md", 1), // dated, the only one in its directory: kept
    todo("/o/1.6.26.org", 1), // not YYYY-MM-DD: never dropped
  ]
  const mtimes: Record<string, number> = {
    "/o/fleet/2026-10-31.md": 400,
    "/o/TODO.md": 300,
    "/o/1.6.26.org": 300,
    "/o/fleet/2026-11-02.md": 200,
    "/o/fleet/2026-11-01.org": 500,
    "/p/docs/2026-01-01.md": 0,
  }
  const asked: string[] = []
  const ranked = rank(todos, (f) => (asked.push(f), mtimes[f]!))
  // mtime descending; a tie keeps grep order (TODO.md before 1.6.26.org, line 1 before line 2).
  assert.deepEqual(ranked.map((t) => t.text), [
    "/o/TODO.md:1",
    "/o/1.6.26.org:1",
    "/o/fleet/2026-11-02.md:1",
    "/o/fleet/2026-11-02.md:2",
    "/p/docs/2026-01-01.md:1",
  ])
  assert.equal(new Set(asked).size, asked.length, "mtime is asked once per file")
  assert.equal(todos.length, 7, "the input is not mutated")
  assert.deepEqual(rank([], () => 0), [])

  // The listing, not the todos, names the newest date: a finished 2026-11-02 hides 2026-11-01's open todo.
  const listed: string[] = []
  const hidden = rank(
    [todo("/o/fleet/2026-11-01.md", 1), todo("/o/fleet/2026-11-01.md", 2), todo("/o/TODO.md", 1)],
    () => 0,
    (d) => (listed.push(d), d === "/o/fleet" ? "2026-11-02" : undefined),
  )
  assert.deepEqual(hidden.map((t) => t.text), ["/o/TODO.md:1"])
  assert.deepEqual(listed.sort(), ["/o", "/o/fleet"], "the listing is asked once per directory")
  // A listing that throws keeps the rule from the todos' own dates.
  const thrown = rank(
    [todo("/o/fleet/2026-10-31.md", 1), todo("/o/fleet/2026-11-01.md", 1)],
    () => 0,
    () => {
      throw new Error("EACCES")
    },
  )
  assert.deepEqual(thrown.map((t) => t.text), ["/o/fleet/2026-11-01.md:1"])
}

// ---- flipLine: mark done only the todo the scan saw -------------------------------------------------------------

{
  assert.equal(flipLine("** TODO ship it ", { kind: "org", text: "ship it" }), "** DONE ship it ")
  assert.equal(flipLine("* BLOCKED wait", { kind: "org", text: "BLOCKED: wait" }), "* DONE wait")
  assert.equal(flipLine("  * [ ] nested box", { kind: "md", text: "nested box" }), "  * [x] nested box")
  assert.equal(flipLine("- [ ] one\r", { kind: "md", text: "one" }), "- [x] one\r", "a CRLF line keeps its \\r")
  // The file changed since the scan: nothing to flip.
  assert.equal(flipLine("- [ ] other", { kind: "md", text: "one" }), null, "text changed")
  assert.equal(flipLine("- [x] one", { kind: "md", text: "one" }), null, "already done")
  assert.equal(flipLine("* DONE one", { kind: "org", text: "one" }), null, "already done (org)")
  assert.equal(flipLine("* TODO one", { kind: "md", text: "one" }), null, "kind changed")
  assert.equal(flipLine("", { kind: "md", text: "one" }), null, "line gone")
}

// ---- when the widget starts -----------------------------------------------------------------------------------

const sub = { agent: { kind: "sub", id: "0-ecomono-explore", name: "ecomono-explore", depth: 0, parentId: "Main" } }

for (const [label, over] of [
  ["print mode", { mode: "print", hasUI: true }],
  ["no UI", { mode: "tui", hasUI: false }],
  ["subagent", { mode: "tui", hasUI: true, ...sub }],
  ["rpc mode", { mode: "rpc", hasUI: true }],
] as const) {
  const { fire, calls, ctx } = setup(over)
  await start(ctx, fire)
  await tick()
  assert.equal(greps(calls).length, 0, `${label}: no grep`)
  assert.equal(ctx.recorded.setInterval.length, 0, `${label}: no timer`)
  assert.equal(ctx.recorded.setWidget.length, 0, `${label}: no widget`)
  assert.deepEqual(calls.failures, [], label)
}

// ---- the widget -----------------------------------------------------------------------------------------------

{
  // Main TUI session: one grep now over <cwd>/docs and the org directory, one timer at 3000 ms.
  const orgDir = dir("org-dir")
  await withEnv({ ECOMONO_ORG_DIR: orgDir }, async () => {
    const cwd = dir("project")
    const rows = Array.from({ length: 12 }, (_, i) => `${cwd}/docs/n${i + 1}.md:${i + 1}:- [ ] item ${i + 1}`)
    const { fire, calls, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut(rows.join("\n")) : nodeOk) })
    assert.equal(await start(ctx, fire), undefined)
    await tick()

    assert.equal(greps(calls).length, 1)
    const [command, args, options] = greps(calls)[0]!
    assert.equal(command, "grep")
    assert.deepEqual(args, ["-rnHsE", "--include=*.org", "--include=*.md", PATTERN, `${cwd}/docs`, orgDir])
    assert.equal(options.cwd, cwd)
    assert.ok(options.timeout > 0, "the grep has a timeout")
    assert.equal(ctx.recorded.setInterval.length, 1)
    assert.equal(ctx.recorded.setInterval[0]![1], 3000)

    // 12 todos: the header and the first nine rows, the height omp gives a string widget. None of the files
    // exists, so every mtime is 0 and grep's order stands.
    assert.equal(ctx.recorded.setWidget.length, 1)
    const [key, content, widgetOptions] = ctx.recorded.setWidget[0]!
    assert.equal(key, "org-todo")
    const lines = draw(content, 60)
    assert.equal(lines.length, 10)
    assert.equal(lines[0], "todo 12 · alt+t")
    assert.equal(lines[1], "item 1 · n1.md")
    assert.equal(lines[9], "item 9 · n9.md")
    assert.deepEqual(widgetOptions, { placement: "belowEditor" })

    // The timer callback runs the same tick again.
    await ctx.recorded.setInterval[0]![0]()
    await tick()
    assert.equal(greps(calls).length, 2)
    assert.equal(ctx.recorded.setWidget.length, 2)
    assert.deepEqual(calls.failures, [])
    assert.deepEqual(calls.warn, [])
  })
}

{
  // Without ECOMONO_ORG_DIR the org directory is ~/work/org (a path only: nothing is read from it here).
  await withEnv({ ECOMONO_ORG_DIR: undefined }, async () => {
    const { fire, calls, ctx } = setup({ mode: "tui", hasUI: true })
    await start(ctx, fire)
    assert.equal(greps(calls)[0]![1].at(-1), join(homedir(), "work/org"))
  })
}

{
  // A row fits the width omp draws it at: a long text is cut with "…" and keeps its source; too narrow for both,
  // the source goes. A wide character counts two columns. The widget is cleared (content undefined) once the last
  // todo is gone.
  const cwd = dir("project")
  let todos = `${cwd}/docs/long.md:3:- [ ] ${"x".repeat(200)}\n${cwd}/docs/wide.md:1:- [ ] 日本語の文`
  const { fire, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut(todos) : nodeOk) })
  await start(ctx, fire)
  await tick()
  const [, content] = ctx.recorded.setWidget[0]!
  assert.deepEqual(draw(content, 40), ["todo 2 · alt+t", `${"x".repeat(29)}… · long.md`, "日本語の文 · wide.md"])
  assert.deepEqual(draw(content, 12), ["todo 2 · al…", `${"x".repeat(11)}…`, "日本語の文"])
  assert.equal(draw(content, 7)[2], "日本語…", "a wide character is never split")

  todos = ""
  await ctx.recorded.setInterval[0]![0]()
  await tick()
  assert.equal(ctx.recorded.setWidget.length, 2)
  assert.deepEqual(ctx.recorded.setWidget[1], ["org-todo", undefined])
}

{
  // The rows follow core.rank on the real files: only the newest dated report of a directory, then the most recently
  // changed file first; a file gone by the time it is stat'ed sorts last.
  const cwd = dir("project")
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  const org = dir("org")
  writeFileSync(join(docs, "old.md"), "- [ ] old\n")
  writeFileSync(join(docs, "new.md"), "- [ ] new\n")
  writeFileSync(join(org, "2026-10-31.md"), "- [ ] stale report\n")
  writeFileSync(join(org, "2026-11-01.md"), "- [ ] latest report\n")
  utimesSync(join(docs, "old.md"), 1000, 1000)
  utimesSync(join(docs, "new.md"), 3000, 3000)
  utimesSync(join(org, "2026-10-31.md"), 4000, 4000)
  utimesSync(join(org, "2026-11-01.md"), 2000, 2000)
  await withEnv({ ECOMONO_ORG_DIR: org }, async () => {
    const exec = (command: string, args: string[]) => (command === "grep" ? realGrep(args, `${docs}/gone.md:1:- [ ] gone\n`) : nodeOk)
    const { fire, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec })
    await start(ctx, fire)
    await tick()
    assert.deepEqual(draw(ctx.recorded.setWidget[0]![1], 60), [
      "todo 4 · alt+t",
      "new · new.md",
      "latest report · 2026-11-01.md",
      "old · old.md",
      "gone · gone.md",
    ])
  })
}

{
  // A fully ticked newest report still hides the older ones: the directory listing names the newest date.
  const cwd = dir("project")
  mkdirSync(join(cwd, "docs"))
  const org = dir("org")
  writeFileSync(join(org, "2026-11-01.md"), "- [ ] stale report\n")
  writeFileSync(join(org, "2026-11-02.md"), "- [x] all done\n")
  writeFileSync(join(org, "TODO.md"), "- [ ] undated\n")
  await withEnv({ ECOMONO_ORG_DIR: org }, async () => {
    const exec = (command: string, args: string[]) => (command === "grep" ? realGrep(args) : nodeOk)
    const { fire, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec })
    await start(ctx, fire)
    await tick()
    assert.deepEqual(draw(ctx.recorded.setWidget[0]![1], 60), ["todo 1 · alt+t", "undated · TODO.md"])
  })
}

// ---- the picker -----------------------------------------------------------------------------------------------

/** Opens the picker through /org-todo and waits for the overlay (the fake) to hold its component. */
const openPicker = async (calls: ReturnType<typeof makePi>["calls"], ctx: any) => {
  const [, command] = calls.commands.find(([name]) => name === "org-todo")!
  const closed = within(command.handler("", ctx))
  await tick()
  return { entry: ctx.recorded.custom.at(-1), closed }
}
const press = async (entry: any, ...keys: string[]) => {
  for (const key of keys) {
    entry.component.handleInput(key)
    await tick()
  }
}
/** The picker's rows without its frame, the selected one marked "> ". */
const rows = (entry: any, width = 60): string[] =>
  entry.component.render(width).slice(1, -1).map((l: string) => l.slice(2, -2).trimEnd())
/** A main TUI session over <cwd>/docs and `org`, with the real grep. */
const session = (cwd: string, org: string) =>
  // The org directory is read when the widget starts, at session_start.
  withEnv({ ECOMONO_ORG_DIR: org }, async () => {
    const s = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command, args) => (command === "grep" ? realGrep(args) : nodeOk) })
    await start(s.ctx, s.fire)
    await tick()
    return s
  })

{
  // /org-todo and alt+t are registered at load. Without a widget (no main TUI session started) they say why.
  const { calls, ctx } = setup({ mode: "tui", hasUI: true })
  assert.deepEqual(calls.commands.map(([name]) => name), ["org-todo"])
  assert.deepEqual(calls.shortcuts.map(([key]) => key), ["alt+t"])
  assert.ok(calls.commands[0]![1].description && calls.shortcuts[0]![1].description)
  await within(calls.commands[0]![1].handler("", ctx))
  await within(Promise.resolve(calls.shortcuts[0]![1].handler(ctx)))
  assert.equal(ctx.recorded.custom.length, 0)
  assert.equal(ctx.recorded.notify.filter(([t]: [string]) => t.includes("org-todo runs in the main TUI session only")).length, 2)
}

{
  // enter marks the selected todo done in its file and drops it from the list; the last one closes the picker.
  // A file without a trailing newline keeps it that way, a CRLF file keeps its "\r", and an org directory that
  // is a symlink is written through: the link stays a link.
  const cwd = dir("project")
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  const realOrg = dir("real-org")
  const org = join(dir("links"), "org")
  symlinkSync(realOrg, org)
  writeFileSync(join(docs, "a.md"), "# t\n- [ ] one\n- [ ] two")
  writeFileSync(join(realOrg, "b.org"), "* TODO three\r\n* DONE x\r\n")
  utimesSync(join(docs, "a.md"), 3000, 3000)
  utimesSync(join(realOrg, "b.org"), 2000, 2000)
  await withEnv({ ECOMONO_ORG_DIR: org }, async () => {
    const { calls, ctx } = await session(cwd, org)
    const { entry, closed } = await openPicker(calls, ctx)
    assert.deepEqual(entry.options, { overlay: true })
    assert.deepEqual(rows(entry), ["> one · a.md", "  two · a.md", "  three · b.org"])
    // j / k and the arrows move the selection.
    await press(entry, "j")
    assert.deepEqual(rows(entry)[1], "> two · a.md")
    await press(entry, "\x1b[B", "k")
    assert.deepEqual(rows(entry)[1], "> two · a.md")
    await press(entry, "\x1b[A")
    assert.deepEqual(rows(entry)[0], "> one · a.md")

    const before = greps(calls).length
    await press(entry, "\r")
    assert.equal(readFileSync(join(docs, "a.md"), "utf8"), "# t\n- [x] one\n- [ ] two")
    assert.deepEqual(rows(entry), ["> two · a.md", "  three · b.org"])
    assert.ok(greps(calls).length > before, "the widget rescans after a flip")
    await press(entry, "\r", "\r")
    assert.equal(readFileSync(join(docs, "a.md"), "utf8"), "# t\n- [x] one\n- [x] two")
    assert.equal(readFileSync(join(realOrg, "b.org"), "utf8"), "* DONE three\r\n* DONE x\r\n")
    assert.ok(lstatSync(org).isSymbolicLink())
    assert.equal(entry.closed, true, "the last todo closes the picker")
    await closed
    assert.deepEqual(calls.failures, [])
  })
}

{
  // The file changed since the scan: enter writes nothing, says so and rescans; the picker shows the new list.
  // A file that is not UTF-8 is never rewritten (a decode and encode would mangle every other line).
  const cwd = dir("project")
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  writeFileSync(join(docs, "a.md"), "- [ ] one\n")
  const org = dir("org")
  const { calls, ctx } = await session(cwd, org)
  const { entry, closed } = await openPicker(calls, ctx)
  writeFileSync(join(docs, "a.md"), "- [ ] one, edited\n")
  await press(entry, "\r")
  assert.equal(readFileSync(join(docs, "a.md"), "utf8"), "- [ ] one, edited\n")
  assert.ok(ctx.recorded.notify.some(([t]: [string]) => t.includes("changed on disk")), JSON.stringify(ctx.recorded.notify))
  assert.deepEqual(rows(entry), ["> one, edited · a.md"])
  await press(entry, "q")
  await closed

  const latin1 = Buffer.from("- [ ] caf\xe9\n", "latin1")
  writeFileSync(join(docs, "a.md"), latin1)
  const s2 = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut(`${docs}/a.md:1:- [ ] caf`) : nodeOk) })
  await start(s2.ctx, s2.fire)
  await tick()
  const picker2 = await openPicker(s2.calls, s2.ctx)
  await press(picker2.entry, "\r")
  assert.deepEqual(readFileSync(join(docs, "a.md")), latin1)
  assert.ok(s2.ctx.recorded.notify.some(([t]: [string]) => t.includes("not UTF-8")), JSON.stringify(s2.ctx.recorded.notify))
  await press(picker2.entry, "q")
  await picker2.closed
}

{
  // e opens $EDITOR at the todo's line in a Zellij pane and closes the picker; without openTerminal, or when it
  // fails (no Zellij session), the notice names the file and line instead.
  const cwd = dir("project")
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  writeFileSync(join(docs, "a.md"), "# t\n- [ ] one\n")
  const org = dir("org")
  await withEnv({ EDITOR: "nvim -u NONE" }, async () => {
    const { calls, ctx } = await session(cwd, org)
    const { entry, closed } = await openPicker(calls, ctx)
    await press(entry, "e")
    assert.deepEqual(ctx.recorded.openTerminal, [
      { multiplexer: "zellij", placement: "pane", command: ["nvim", "-u", "NONE", "+2", join(docs, "a.md")], cwd },
    ])
    assert.equal(entry.closed, true)
    await closed
  })
  for (const openTerminal of [undefined, () => Promise.reject(new Error("zellij launch requires an active Zellij session"))]) {
    const { calls, ctx } = await session(cwd, org)
    ctx.ui.openTerminal = openTerminal
    const { entry } = await openPicker(calls, ctx)
    await press(entry, "e")
    const said = ctx.recorded.notify.map(([t]: [string]) => t).join("\n")
    assert.ok(said.includes(`${join(docs, "a.md")}:2`), said)
    if (openTerminal) assert.ok(said.includes("active Zellij session"), said)
    assert.equal(entry.closed, true)
  }
}

{
  // q and escape close the picker and write nothing; with no open todo it does not open at all.
  const cwd = dir("project")
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  writeFileSync(join(docs, "a.md"), "- [ ] one\n")
  const org = dir("org")
  for (const key of ["q", "\x1b"]) {
    const { calls, ctx } = await session(cwd, org)
    const { entry, closed } = await openPicker(calls, ctx)
    await press(entry, key)
    assert.equal(entry.closed, true, key)
    await closed
  }
  assert.equal(readFileSync(join(docs, "a.md"), "utf8"), "- [ ] one\n")

  const empty = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut("") : nodeOk) })
  await start(empty.ctx, empty.fire)
  await tick()
  await within(empty.calls.commands[0]![1].handler("", empty.ctx))
  assert.equal(empty.ctx.recorded.custom.length, 0)
  assert.ok(empty.ctx.recorded.notify.some(([t]: [string]) => t.includes("no open todos")))
}

// ---- failures -------------------------------------------------------------------------------------------------

{
  // An exec that rejects, or throws on the spot, leaves no unhandled rejection, no widget change and no failure.
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown) => void seen.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const rejecting = setup({ mode: "tui", hasUI: true }, { exec: () => Promise.reject(new Error("grep rejected")) })
    await start(rejecting.ctx, rejecting.fire)
    await rejecting.ctx.recorded.setInterval[0]![0]()
    await rejecting.ctx.recorded.setInterval[0]![0]()
    await tick()
    assert.equal(greps(rejecting.calls).length, 3)
    assert.equal(rejecting.ctx.recorded.setWidget.length, 0)
    assert.deepEqual(rejecting.calls.failures, [])
    // Once per session, however many ticks fail: the timer runs every 3 s.
    const failed = rejecting.calls.warn.filter((l) => l.includes("org-todo tick failed"))
    assert.equal(failed.length, 1, failed.join("\n"))
    assert.ok(failed[0]!.includes("grep rejected"))

    const throwing = setup({ mode: "tui", hasUI: true }, {
      exec: (command) => {
        if (command === "grep") throw new Error("exec threw")
        return nodeOk
      },
    })
    assert.equal(await start(throwing.ctx, throwing.fire), undefined)
    await tick()
    assert.deepEqual(throwing.calls.failures, [], "safe() contains a synchronous failure")
    assert.ok(throwing.calls.warn.some((l) => l.includes("exec threw")))
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  assert.deepEqual(seen, [], "no unhandledRejection")
}

{
  // pi.exec resolves on a timeout: a killed grep's partial stdout is not the answer, so the widget keeps its
  // previous state and the logger says so once. grep -s exits 2 when a directory is missing, matches or not: that
  // still renders.
  const cwd = dir("project")
  let result: any = grepOut(`${cwd}/docs/a.md:1:- [ ] one`)
  const { fire, calls, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? result : nodeOk) })
  await start(ctx, fire)
  await tick()
  assert.equal(ctx.recorded.setWidget.length, 1)

  result = { stdout: `${cwd}/docs/a.md:1:- [ ] one`, stderr: "", code: -1, killed: true }
  await ctx.recorded.setInterval[0]![0]()
  await ctx.recorded.setInterval[0]![0]()
  await tick()
  assert.equal(ctx.recorded.setWidget.length, 1, "a killed grep leaves the widget as it was")
  assert.deepEqual(calls.warn, ["ecomono: org-todo grep timed out; keeping the previous widget"])

  // A failure of another kind still warns once after the timeout warning: separate kinds.
  result = Promise.reject(new Error("grep gone"))
  result.catch(() => {})
  await ctx.recorded.setInterval[0]![0]()
  await ctx.recorded.setInterval[0]![0]()
  await tick()
  assert.equal(calls.warn.length, 2, calls.warn.join("\n"))
  assert.ok(calls.warn[1]!.includes("org-todo tick failed: grep gone"), calls.warn[1])

  result = { stdout: `${cwd}/docs/a.md:1:- [ ] one\n${cwd}/docs/b.md:2:- [ ] two`, stderr: "", code: 2, killed: false }
  await ctx.recorded.setInterval[0]![0]()
  await tick()
  assert.equal(ctx.recorded.setWidget.length, 2)
  assert.equal(draw(ctx.recorded.setWidget[1]![1], 60)[0], "todo 2 · alt+t")
  assert.deepEqual(calls.failures, [])
}

{
  // The widget and its parser load on first use, from the extension's own tree: a tree without the org-todo files
  // costs the widget only. The extension loads, session_start resolves with one warning and still runs the skills
  // check after it, and the path gate (here a one-key deny list) still blocks.
  const repo = dir("repo")
  mkdirSync(join(repo, "opencode"), { recursive: true })
  writeFileSync(join(repo, "opencode/opencode.json"), JSON.stringify({ permission: { read: { "*": "allow", "**/.env": "deny" } } }))
  const { pi, fire, calls } = makePi({ exec: () => nodeOk })
  ecomono({ repo })(pi)
  const ctx = makeCtx({ mode: "tui", hasUI: true })
  await withEnv({ HOME: dir("home") }, async () => {
    assert.equal(await start(ctx, fire), undefined)
  })
  await tick()
  assert.equal(greps(calls).length, 0)
  assert.equal(ctx.recorded.setInterval.length, 0)
  const notStarted = calls.warn.filter((l) => l.includes("org-todo widget not started"))
  assert.equal(notStarted.length, 1, calls.warn.join("\n"))
  assert.ok(notStarted[0]!.includes("org-todo"), notStarted[0])
  assert.ok(ctx.recorded.notify.some(([text]: [string]) => text.includes("ecomono-sdd-shared")), "the skills check still ran")
  assert.deepEqual(calls.failures, [])
  assert.equal((await fire("tool_call", { toolName: "read", toolCallId: "c", input: { path: ".env" } }, ctx))?.block, true)
}

if (hostHome === undefined) delete process.env.HOME
else process.env.HOME = hostHome

console.log("test_org_todo: all assertions passed")
