// The org-todo widget of the omp extension and the parser it shares with OpenCode's TUI plugin, driven through
// fake-pi. Plain assert script. pi.exec is a stub: no omp, no network; the one real process is the grep that
// checks the shared PATTERN against fixture files in a temp dir.
import { ISOLATED, makeCtx, makePi } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PATTERN, parse } from "../../opencode/tui-plugins/org-todo/core.ts"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"

const TMP = mkdtempSync(join(ISOLATED, "org-todo-"))
let seq = 0
const dir = (label: string) => {
  const d = join(TMP, `${label}-${++seq}`)
  mkdirSync(d, { recursive: true })
  return d
}

const setup = (over: Record<string, any> = {}, opts: Parameters<typeof makePi>[0] = {}) => {
  const { pi, fire, calls } = makePi(opts)
  ecomono({ repo: REPO })(pi)
  return { fire, calls, ctx: makeCtx(over) }
}
const settle = () => new Promise((r) => setTimeout(r, 20))
/** A hang in the code under test fails the run instead of freezing it. */
const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms))])

/** The grep calls of a run: session_start also execs the skill-registry generator, which is not under test here. */
const greps = (calls: ReturnType<typeof makePi>["calls"]) => calls.exec.filter(([command]) => command === "grep")
const grepOut = (stdout: string) => ({ stdout, stderr: "", code: stdout ? 0 : 1, killed: false })
const start = (ctx: any, fire: (name: string, event: any, ctx: any) => Promise<any>) =>
  within(fire("session_start", { reason: "start" }, ctx))

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
  await settle()
  assert.equal(greps(calls).length, 0, `${label}: no grep`)
  assert.equal(ctx.recorded.setInterval.length, 0, `${label}: no timer`)
  assert.equal(ctx.recorded.setWidget.length, 0, `${label}: no widget`)
  assert.deepEqual(calls.failures, [], label)
}

// ---- the widget -----------------------------------------------------------------------------------------------

{
  // Main TUI session: one grep now over <cwd>/docs and the org directory, one timer at 3000 ms.
  const orgDir = dir("org-dir")
  const saved = process.env.ECOMONO_ORG_DIR
  process.env.ECOMONO_ORG_DIR = orgDir
  try {
    const cwd = dir("project")
    const rows = Array.from({ length: 12 }, (_, i) => `${cwd}/docs/n${i + 1}.md:${i + 1}:- [ ] item ${i + 1}`)
    const { fire, calls, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => (command === "grep" ? grepOut(rows.join("\n")) : grepOut("")) })
    assert.equal(await start(ctx, fire), undefined)
    await settle()

    assert.equal(greps(calls).length, 1)
    const [command, args, options] = greps(calls)[0]!
    assert.equal(command, "grep")
    assert.deepEqual(args, ["-rnHsE", "--include=*.org", "--include=*.md", PATTERN, `${cwd}/docs`, orgDir])
    assert.equal(options.cwd, cwd)
    assert.ok(options.timeout > 0, "the grep has a timeout")
    assert.equal(ctx.recorded.setInterval.length, 1)
    assert.equal(ctx.recorded.setInterval[0]![1], 3000)

    // 12 todos: omp draws at most 10 lines, so the header and the first nine rows.
    assert.equal(ctx.recorded.setWidget.length, 1)
    const [key, lines, widgetOptions] = ctx.recorded.setWidget[0]!
    assert.equal(key, "org-todo")
    assert.equal(lines.length, 10)
    assert.equal(lines[0], "todo 12")
    assert.equal(lines[1], "n1.md:1 item 1")
    assert.equal(lines[9], "n9.md:9 item 9")
    assert.deepEqual(widgetOptions, { placement: "belowEditor" })

    // The timer callback runs the same tick again.
    await ctx.recorded.setInterval[0]![0]()
    await settle()
    assert.equal(greps(calls).length, 2)
    assert.equal(ctx.recorded.setWidget.length, 2)
    assert.deepEqual(calls.failures, [])
    assert.deepEqual(calls.warn, [])
  } finally {
    if (saved === undefined) delete process.env.ECOMONO_ORG_DIR
    else process.env.ECOMONO_ORG_DIR = saved
  }
}

{
  // Without ECOMONO_ORG_DIR the org directory is ~/work/org (a path only: nothing is read from it here).
  const saved = process.env.ECOMONO_ORG_DIR
  delete process.env.ECOMONO_ORG_DIR
  try {
    const { fire, calls, ctx } = setup({ mode: "tui", hasUI: true })
    await start(ctx, fire)
    assert.equal(greps(calls)[0]![1].at(-1), join(homedir(), "work/org"))
  } finally {
    if (saved !== undefined) process.env.ECOMONO_ORG_DIR = saved
  }
}

{
  // A long row is cut to 80 characters; the widget is cleared (content undefined) once the last todo is gone.
  const cwd = dir("project")
  let todos = `${cwd}/docs/long.md:3:- [ ] ${"x".repeat(200)}`
  const { fire, ctx } = setup({ cwd, mode: "tui", hasUI: true }, { exec: (command) => grepOut(command === "grep" ? todos : "") })
  await start(ctx, fire)
  await settle()
  const [, lines] = ctx.recorded.setWidget[0]!
  assert.equal(lines[0], "todo 1")
  assert.equal(lines.length, 2)
  assert.equal(lines[1].length, 80)
  assert.ok(lines[1].startsWith("long.md:3 xxx") && lines[1].endsWith("…"))

  todos = ""
  await ctx.recorded.setInterval[0]![0]()
  await settle()
  assert.equal(ctx.recorded.setWidget.length, 2)
  assert.deepEqual(ctx.recorded.setWidget[1], ["org-todo", undefined])
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
    await settle()
    assert.equal(greps(rejecting.calls).length, 2)
    assert.equal(rejecting.ctx.recorded.setWidget.length, 0)
    assert.deepEqual(rejecting.calls.failures, [])
    assert.ok(rejecting.calls.warn.some((l) => l.includes("org-todo tick failed") && l.includes("grep rejected")))

    const throwing = setup({ mode: "tui", hasUI: true }, {
      exec: (command) => {
        if (command === "grep") throw new Error("exec threw")
        return grepOut("")
      },
    })
    assert.equal(await start(throwing.ctx, throwing.fire), undefined)
    await settle()
    assert.deepEqual(throwing.calls.failures, [], "safe() contains a synchronous failure")
    assert.ok(throwing.calls.warn.some((l) => l.includes("exec threw")))
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  assert.deepEqual(seen, [], "no unhandledRejection")
}

console.log("test_org_todo: all assertions passed")
