// The org-todo scan of the omp extension and the parser it shares with OpenCode's TUI plugin, driven through
// fake-pi. Plain assert script. pi.exec is a stub: no omp, no network; the one real process is the grep that
// checks the shared PATTERN against fixture files in a temp dir.
import { dir, makeCtx, makePi, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
/** The last `todo N` the scan put in the status line (undefined once cleared). */
const status = (ctx: any) => ctx.recorded.setStatus.at(-1)?.[1]

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
  // PATTERN against a real grep, with the flags the scan uses: the parser sees exactly the lines that count.
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

// ---- when the scan starts -----------------------------------------------------------------------------------

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
  assert.equal(ctx.recorded.setStatus.length, 0, `${label}: no status`)
  assert.deepEqual(calls.failures, [], label)
}

// ---- the status line: todo N, cleared at 0 ---------------------------------------------------------------------

{
  // Main TUI session: one grep now over <cwd>/docs and the org directory, one timer at 3000 ms, the count as plain
  // text under the org-todo key; no todos clears the key.
  const orgDir = dir("org-dir")
  await withEnv({ ECOMONO_ORG_DIR: orgDir }, async () => {
    const cwd = dir("project")
    let out = `${cwd}/docs/a.md:1:- [ ] one\n${cwd}/docs/b.md:2:- [ ] two`
    const { fire, calls, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut(out) : nodeOk) })
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
    assert.deepEqual(ctx.recorded.setStatus, [["org-todo", "todo 2"]])
    assert.ok(!ctx.recorded.setWidget.some(([, , o]: [string, unknown, any]) => o?.placement === "belowEditor"), "nothing below the editor")

    out = ""
    await ctx.recorded.setInterval[0]![0]()
    await tick()
    assert.deepEqual(ctx.recorded.setStatus.at(-1), ["org-todo", undefined])
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

// ---- the banner: above the editor at session start, gone at the first prompt ------------------------------------

{
  const { ART, banner } = await import("../extensions/ecomono/panel/banner.ts")
  const { makeTheme } = await import("./fake-pi.ts")
  // The art: 72 columns each, only the half-block glyphs and spaces the VGA font has.
  assert.equal(ART.length, 11)
  for (const l of ART) {
    assert.equal(Bun.stringWidth(l), 72)
    assert.ok(/^[ ▀▄█]+$/.test(l), l)
  }
  // Wide: the art with the wordmark block at its right; narrow: the block alone. A blank line closes both.
  const wide = banner("18.15.0", "/w", makeTheme(true)).render(120)
  assert.equal(wide.length, ART.length + 1)
  assert.ok(wide[0]!.startsWith("<text>" + ART[0] + "</text>"), wide[0])
  assert.ok(wide.some((l: string) => l.includes("<accent>▄▀▀▄ █▀▄▀▄ █▀▀▄</accent>")), "the omp wordmark is drawn in accent")
  assert.ok(wide.some((l: string) => l.includes("<dim>v18.15.0</dim>")))
  assert.ok(wide.some((l: string) => l.includes("<muted>/w</muted>")))
  assert.equal(wide.at(-1), "")
  const narrow = banner("18.15.0", "/w", makeTheme(true)).render(60)
  assert.ok(!narrow.some((l: string) => l.includes("█████")), "no art below the minimum width")
  assert.ok(narrow.some((l: string) => l.includes("<dim>v18.15.0</dim>")))

  // Every line fits the width: the side block is cut (the cwd keeps its tail), and the narrow layout cuts to width.
  const cwd = "/home/surface/personal/ecomono"
  const at90 = banner("18.15.0", cwd, makeTheme()).render(90)
  assert.ok(at90.length > ART.length && at90[0]!.startsWith(ART[0]!), "90 columns is the wide layout")
  assert.ok(at90.some((l: string) => l.endsWith("…" + cwd.slice(-(90 - 72 - 2 - 1)))), "the cwd is cut to its tail")
  const at20 = banner("18.15.0", cwd, makeTheme()).render(20)
  assert.ok(at20.includes("…" + cwd.slice(-19)), "narrow: the cwd is cut to the width, tail kept")
  for (let w = 10; w <= 130; w++) {
    for (const l of banner("18.15.0", cwd, makeTheme()).render(w)) assert.ok(Bun.stringWidth(l) <= w, `${w}: ${JSON.stringify(l)}`)
  }

  // With a picture whose terminal draws images, the picture's lines come first and the block goes under them;
  // a picture whose terminal draws none falls back to the art. The picture is omp's Image: faked here.
  const drawn = ["\x1b_Gpayload\x1b\\", "reserved", "reserved"]
  const pic = { image: () => ({ render: () => drawn }) }
  const withPic = banner("18.15.0", "/w", makeTheme(true), pic).render(120)
  assert.deepEqual(withPic.slice(0, 3), drawn, "the picture's lines are kept verbatim")
  assert.ok(!withPic.some((l: string) => l.includes("█████")), "no art beside a picture")
  assert.ok(withPic.some((l: string) => l.includes("<accent>▄▀▀▄ █▀▄▀▄ █▀▀▄</accent>")), "the block still draws")
  const noProto = banner("18.15.0", "/w", makeTheme(true), { image: () => undefined }).render(120)
  assert.ok(noProto[0]!.startsWith("<text>" + ART[0] + "</text>"), "no protocol: the art")
  const narrowPic = banner("18.15.0", "/w", makeTheme(true), pic).render(60)
  assert.ok(!narrowPic.some((l: string) => l === drawn[0]), "narrow: no picture either")
  // A picture that throws, building or rendering, falls back to the art instead of failing the paint.
  const badBuild = banner("18.15.0", "/w", makeTheme(true), { image: () => { throw new Error("boom") } }).render(120)
  assert.ok(badBuild[0]!.startsWith("<text>" + ART[0] + "</text>"), "image() throws: the art")
  const badRender = banner("18.15.0", "/w", makeTheme(true), { image: () => ({ render: () => { throw new Error("boom") } }) }).render(120)
  assert.ok(badRender[0]!.startsWith("<text>" + ART[0] + "</text>"), "render() throws: the art")
  // Under the picture the block has the full width: the cwd is not cut to the art's remainder.
  assert.ok(banner("18.15.0", cwd, makeTheme(true), pic).render(90).some((l: string) => l.includes(`<muted>${cwd}</muted>`)), "picture: the full cwd at 90")
  // No PNG set: no picture is loaded and @oh-my-pi/pi-tui is never imported (the tests could not resolve it).
  const { loadPicture } = await import("../extensions/ecomono/panel/banner.ts")
  assert.equal(await loadPicture("/nonexistent/omp-banner.png"), undefined, "an unreadable PNG means no picture")
  const png = join(mkdtempSync(join(tmpdir(), "banner-")), "b.png")
  writeFileSync(png, "x")
  assert.equal(await loadPicture(png, () => Promise.reject(new Error("no pi-tui"))), undefined, "a failing import means no picture")

  // In a main TUI session it is set above the editor at session_start and cleared by the first prompt; a
  // revive does not clear it, and a second prompt does not clear it again.
  const { fire, calls, ctx } = setup({ mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut("") : nodeOk) })
  await start(ctx, fire)
  await tick()
  const shown = ctx.recorded.setWidget.filter(([key]: [string]) => key === "ecomono-banner")
  assert.equal(shown.length, 1, JSON.stringify(ctx.recorded.setWidget))
  assert.equal(typeof shown[0]![1], "function", "a component, not lines: omp caps string widgets at 10")
  assert.deepEqual(shown[0]![2], { placement: "aboveEditor" })
  await fire("before_agent_start", { reason: "revive", prompt: "x" }, ctx)
  assert.equal(ctx.recorded.setWidget.filter(([key]: [string]) => key === "ecomono-banner").length, 1, "a revive keeps it")
  await fire("before_agent_start", { reason: "prompt", prompt: "hello" }, ctx)
  await fire("before_agent_start", { reason: "prompt", prompt: "again" }, ctx)
  const gone = ctx.recorded.setWidget.filter(([key]: [string]) => key === "ecomono-banner")
  assert.equal(gone.length, 2)
  assert.deepEqual(gone[1], ["ecomono-banner", undefined])
  assert.deepEqual(calls.failures, [])
}

// ---- failures -------------------------------------------------------------------------------------------------

{
  // An exec that rejects, or throws on the spot, leaves no unhandled rejection, no status change and no failure.
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
    assert.equal(rejecting.ctx.recorded.setStatus.length, 0)
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
  // pi.exec resolves on a timeout: a killed grep's partial stdout is not the answer, so the status keeps its
  // previous value and the logger says so once. grep -s exits 2 when a directory is missing, matches or not: that
  // still renders.
  const cwd = dir("project")
  let result: any = grepOut(`${cwd}/docs/a.md:1:- [ ] one`)
  const { fire, calls, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? result : nodeOk) })
  await start(ctx, fire)
  await tick()
  assert.equal(status(ctx), "todo 1")

  result = { stdout: `${cwd}/docs/a.md:1:- [ ] one`, stderr: "", code: -1, killed: true }
  await ctx.recorded.setInterval[0]![0]()
  await ctx.recorded.setInterval[0]![0]()
  await tick()
  assert.equal(ctx.recorded.setStatus.length, 1, "a killed grep leaves the status as it was")
  assert.deepEqual(calls.warn, ["ecomono: org-todo grep timed out; keeping the previous count"])

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
  assert.equal(status(ctx), "todo 2")
  assert.deepEqual(calls.failures, [])
}

{
  // The scan, the panel and their parser load on first use, from the extension's own tree: a tree without those
  // files costs the panel only. The extension loads, session_start resolves with one warning and still runs the skills
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
  const notStarted = calls.warn.filter((l) => l.includes("side panel not started"))
  assert.equal(notStarted.length, 1, calls.warn.join("\n"))
  assert.ok(ctx.recorded.notify.some(([text]: [string]) => text.includes("ecomono-sdd-shared")), "the skills check still ran")
  assert.deepEqual(calls.failures, [])
  assert.equal((await fire("tool_call", { toolName: "read", toolCallId: "c", input: { path: ".env" } }, ctx))?.block, true)
}

if (hostHome === undefined) delete process.env.HOME
else process.env.HOME = hostHome

console.log("test_org_todo: all assertions passed")
