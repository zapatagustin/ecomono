// Subagent tier routing, the memory write guard and the skill-registry refresh of the omp extension, driven
// through fake-pi. Plain assert script. No real LLM, no real registry run: pi.exec is a stub.
import { ISOLATED, makeCtx, makePi } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { REPO, TIER_ROLE, ecomono } from "../extensions/ecomono/index.ts"

const TMP = mkdtempSync(join(ISOLATED, "spawn-"))
let seq = 0
const dir = (label: string) => {
  const d = join(TMP, `${label}-${++seq}`)
  mkdirSync(d, { recursive: true })
  return d
}

const setup = (over: Record<string, any> = {}, opts: Parameters<typeof makePi>[0] = {}, repo = REPO) => {
  const { pi, fire, calls } = makePi(opts)
  ecomono({ repo })(pi)
  return { fire, calls, ctx: makeCtx(over) }
}
const settle = () => new Promise((r) => setTimeout(r, 20))
/** A hang in the code under test fails the run instead of freezing it. */
const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms))])

assert.deepEqual({ ...TIER_ROLE }, { haiku: "@smol", sonnet: "@task", opus: "@slow" })

// ---- tier routing ---------------------------------------------------------------------------------------------

const spawn = (patterns: unknown, over: Record<string, any> = {}) => ({
  agent: "ecomono-explore",
  invocationKind: "task",
  patterns,
  ...over,
})


{
  // (1) A bare tier word becomes its role, with a note naming both; the case of the word does not matter.
  const { fire, ctx } = setup()
  assert.deepEqual(await fire("before_subagent_spawn", spawn(["sonnet"]), ctx), {
    model: "@task",
    note: "ecomono: sonnet tier -> @task",
  })
  assert.deepEqual(await fire("before_subagent_spawn", spawn(["opus"]), ctx), {
    model: "@slow",
    note: "ecomono: opus tier -> @slow",
  })
  assert.deepEqual(await fire("before_subagent_spawn", spawn(["haiku"]), ctx), {
    model: "@smol",
    note: "ecomono: haiku tier -> @smol",
  })
  assert.deepEqual(await fire("before_subagent_spawn", spawn(["Sonnet"]), ctx), {
    model: "@task",
    note: "ecomono: sonnet tier -> @task",
  })
  assert.deepEqual(await fire("before_subagent_spawn", spawn(["OPUS"]), ctx), {
    model: "@slow",
    note: "ecomono: opus tier -> @slow",
  })
  // An eval agent() spawn follows the same rule.
  assert.equal((await fire("before_subagent_spawn", spawn(["sonnet"], { invocationKind: "eval" }), ctx)).model, "@task")
}

{
  // (2) Silent inheritance: no role, and the one pattern is exactly the main model -> @task, for task and eval.
  const { fire, ctx } = setup()
  const note = "ecomono: no model tier; routed to @task instead of the main model"
  assert.deepEqual(await fire("before_subagent_spawn", spawn(["fakellm/fake-1"]), ctx), { model: "@task", note })
  assert.deepEqual(
    await fire("before_subagent_spawn", spawn(["fakellm/fake-1"], { invocationKind: "eval" }), ctx),
    { model: "@task", note },
  )
  // A role the caller chose is left alone, even when it expands to the main model.
  assert.equal(await fire("before_subagent_spawn", spawn(["fakellm/fake-1"], { modelRole: "task" }), ctx), undefined)
  assert.equal(
    await fire("before_subagent_spawn", spawn(["fakellm/fake-1"], { modelRole: "task", invocationKind: "eval" }), ctx),
    undefined,
  )
}

{
  // (3) Everything else is untouched: an explicit model, two patterns, no patterns, malformed input, no main model.
  const { fire, ctx } = setup()
  assert.equal(await fire("before_subagent_spawn", spawn(["anthropic/claude-x"]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn(["sonnet", "opus"]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn(["fakellm/fake-1", "sonnet"]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn([]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn(undefined), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn("sonnet"), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn([42]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn(["constructor"]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn(["__proto__"]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", spawn(["sonnet-4"]), ctx), undefined)
  assert.equal(await fire("before_subagent_spawn", {}, ctx), undefined)
  const bare = setup({ model: undefined })
  assert.equal(await bare.fire("before_subagent_spawn", spawn(["fakellm/fake-1"]), bare.ctx), undefined)
  assert.deepEqual(bare.calls.failures, [])
}

// ---- memory guard (the real claude/agents) --------------------------------------------------------------------

const SAVE = "mcp__ecomono_memory_mem_save"
const SEARCH = "mcp__ecomono_memory_mem_search"
const mem = (toolName: string) => ({ toolName, toolCallId: "call-1", input: { title: "t", content: "c" } })
const sub = (name: string) => ({ agent: { kind: "sub", id: `0-${name}`, name, depth: 0, parentId: "Main" } })

{
  const { fire, calls } = setup()
  const ctx = (name: string) => makeCtx(sub(name))

  // The judges list search and get only: a save is blocked and the reason names the file to change.
  const blocked = await fire("tool_call", mem(SAVE), ctx("ecomono-judge-a"))
  assert.equal(blocked.block, true)
  assert.equal(
    blocked.reason,
    "ecomono-judge-a has no memory write access (claude/agents/ecomono-judge-a.md tools:); report it to the parent instead",
  )
  assert.equal(await fire("tool_call", mem(SEARCH), ctx("ecomono-judge-a")), undefined)
  assert.equal(await fire("tool_call", mem("mcp__ecomono_memory_mem_get_observation"), ctx("ecomono-judge-a")), undefined)
  assert.equal((await fire("tool_call", mem("mcp__ecomono_memory_mem_update"), ctx("ecomono-judge-b"))).block, true)

  // An agent with no memory tool at all is blocked on every one of them.
  assert.equal((await fire("tool_call", mem(SAVE), ctx("ecomono-explore"))).block, true)
  assert.equal((await fire("tool_call", mem(SEARCH), ctx("ecomono-explore"))).block, true)

  // An agent that lists mem_save may call it; the tools it does not list stay blocked.
  assert.equal(await fire("tool_call", mem(SAVE), ctx("ecomono-sdd-apply")), undefined)
  assert.equal(await fire("tool_call", mem("mcp__ecomono_memory_mem_judge"), ctx("ecomono-sdd-apply")), undefined)
  assert.equal((await fire("tool_call", mem("mcp__ecomono_memory_mem_delete"), ctx("ecomono-sdd-apply"))).block, true)

  // The main agent is never guarded, even under the name of a restricted agent's file.
  assert.equal(await fire("tool_call", mem(SAVE), makeCtx()), undefined)
  assert.equal(
    await fire("tool_call", mem(SAVE), makeCtx({ agent: { kind: "main", id: "Main", name: "ecomono-explore" } })),
    undefined,
  )
  // A subagent with no agent file (omp's bundled `task`, a /tan clone named `sub`) passes, silently: a missing
  // file is the normal case, not a warning.
  assert.equal(await fire("tool_call", mem(SAVE), ctx("task")), undefined)
  assert.equal(await fire("tool_call", mem(SAVE), ctx("sub")), undefined)
  assert.deepEqual(calls.warn, [])
  // Other tools are not this branch's business, not even from a restricted agent.
  assert.equal(await fire("tool_call", { toolName: "mcp__context7_query-docs", input: {} }, ctx("ecomono-explore")), undefined)
  assert.equal(await fire("tool_call", { toolName: "todo_write", input: {} }, ctx("ecomono-explore")), undefined)
  // Malformed events and contexts: undefined, never a throw (a throw would fail the call closed).
  assert.equal(await fire("tool_call", { toolName: SAVE }, ctx("ecomono-judge-a")), undefined)
  assert.equal(await fire("tool_call", mem(SAVE), makeCtx({ agent: undefined })), undefined)
  assert.equal(await fire("tool_call", mem(SAVE), makeCtx({ agent: { kind: "sub" } })), undefined)
  assert.equal(await fire("tool_call", mem(SAVE), makeCtx({ agent: { kind: "sub", name: 7 } })), undefined)
  assert.deepEqual(calls.failures, [])
}

{
  // A name that is not [a-z0-9-]+ never joins a path: with a decoy that would block if it were read, `../x`
  // resolves to <repo>/claude/x.md, outside claude/agents.
  const repo = dir("repo")
  mkdirSync(join(repo, "claude/agents"), { recursive: true })
  writeFileSync(join(repo, "claude/x.md"), "---\nname: x\ntools: Read\n---\n")
  writeFileSync(join(repo, "claude/agents/x.md"), "---\nname: x\ntools: Read\n---\n")
  const { fire, calls } = setup({}, {}, repo)
  for (const name of ["../x", "..", "x/../x", "X", "a b", "", "x.md"]) {
    assert.equal(await fire("tool_call", mem(SAVE), makeCtx(sub(name))), undefined, `name ${JSON.stringify(name)}`)
  }
  // The control: the same file read by its proper name does block, so the decoy is a real one.
  assert.equal((await fire("tool_call", mem(SAVE), makeCtx(sub("x")))).block, true)
  assert.deepEqual(calls.failures, [])
}

{
  // Frontmatter parsing: only the block between the first two `---` lines counts, entries are comma-split and
  // trimmed, and only the memory entries are kept. A file without a `tools:` line inherits every tool (Claude),
  // so it is not restricted. The verdict is cached per name.
  const repo = dir("repo")
  const agents = join(repo, "claude/agents")
  mkdirSync(agents, { recursive: true })
  const agent = (name: string, text: string) => writeFileSync(join(agents, `${name}.md`), text)
  agent("lister", "---\nname: lister\ntools:  Read ,mcp__ecomono-memory__mem_search,  mcp__ecomono-memory__mem_save ,Bash\n---\nbody\n")
  agent("crlf", "---\r\nname: crlf\r\ntools: mcp__ecomono-memory__mem_save\r\n---\r\n")
  agent("bodytools", "---\nname: bodytools\ntools: Read\n---\ntools: mcp__ecomono-memory__mem_save\n")
  agent("notools", "---\nname: notools\ndescription: d\n---\n")
  agent("nofront", "tools: Read\n")
  agent("unclosed", "---\ntools: Read\n")
  agent("othermcp", "---\nname: othermcp\ntools: mcp__context7__query-docs, mcp__ecomono-memory-x__mem_save, mcp__ecomono_memory__mem_save\n---\n")
  const { fire, calls } = setup({}, {}, repo)
  const call = (name: string, tool = SAVE) => fire("tool_call", mem(tool), makeCtx(sub(name)))

  assert.equal(await call("lister"), undefined)
  assert.equal(await call("lister", SEARCH), undefined)
  assert.equal((await call("lister", "mcp__ecomono_memory_mem_judge")).block, true)
  assert.equal(await call("crlf"), undefined)
  assert.equal((await call("bodytools")).block, true, "a tools: line in the body is not the frontmatter's")
  assert.equal(await call("notools"), undefined)
  assert.equal(await call("nofront"), undefined)
  assert.equal(await call("unclosed"), undefined)
  assert.equal((await call("othermcp")).block, true, "only mcp__ecomono-memory__ entries count")

  // Cached: the file is read once per name, so an edit mid-session does not change the verdict.
  agent("lister", "---\nname: lister\ntools: Read\n---\n")
  assert.equal(await call("lister"), undefined)
  assert.deepEqual(calls.failures, [])
  assert.deepEqual(calls.warn, [])
}

{
  // A file that cannot be read (here: a directory) fails open with one warning, then stays cached.
  const repo = dir("repo")
  mkdirSync(join(repo, "claude/agents/broken.md"), { recursive: true })
  const { fire, calls } = setup({}, {}, repo)
  assert.equal(await fire("tool_call", mem(SAVE), makeCtx(sub("broken"))), undefined)
  assert.equal(await fire("tool_call", mem(SAVE), makeCtx(sub("broken"))), undefined)
  assert.equal(calls.warn.length, 1)
  assert.ok(calls.warn[0].includes("claude/agents/broken.md"))
  assert.deepEqual(calls.failures, [])
}

// ---- skill registry refresh ------------------------------------------------------------------------------------

const REGISTRY = join(REPO, "claude/hooks/ecomono-skill-registry.js")
const never = () => new Promise(() => {})

{
  // session_start, main: one exec of the generator, whose promise never resolves; the handler still resolves.
  const cwd = dir("project")
  const { fire, calls } = setup({ cwd }, { exec: never })
  await within(fire("session_start", { reason: "start" }, makeCtx({ cwd })))
  assert.equal(calls.exec.length, 1)
  assert.deepEqual(calls.exec[0][0], "node")
  assert.deepEqual(calls.exec[0][1], [REGISTRY, "--quiet", "--cwd", cwd])
  assert.deepEqual(calls.exec[0][2], { cwd, timeout: 30_000 })
}

{
  // session_start, sub: nothing. Neither does a before_agent_start from a subagent.
  const { fire, calls } = setup({}, { exec: never })
  await within(fire("session_start", { reason: "start" }, makeCtx(sub("ecomono-explore"))))
  await within(fire("before_agent_start", { reason: "prompt", prompt: "x" }, makeCtx(sub("ecomono-explore"))))
  assert.equal(calls.exec.length, 0)
}

{
  // before_agent_start: a prompt refreshes (every time), a revive does not, and the handler returns nothing.
  const cwd = dir("project")
  const { fire, calls } = setup({}, { exec: never })
  const ctx = makeCtx({ cwd })
  assert.equal(await within(fire("before_agent_start", { reason: "prompt", prompt: "a" }, ctx)), undefined)
  assert.equal(calls.exec.length, 1)
  assert.deepEqual(calls.exec[0][1], [REGISTRY, "--quiet", "--cwd", cwd])
  assert.equal(await within(fire("before_agent_start", { reason: "prompt", prompt: "b" }, ctx)), undefined)
  assert.equal(calls.exec.length, 2)
  assert.equal(await within(fire("before_agent_start", { reason: "revive", prompt: "" }, ctx)), undefined)
  assert.equal(await within(fire("before_agent_start", {}, ctx)), undefined)
  assert.equal(calls.exec.length, 2)
}

{
  // An exec that rejects, or throws on the spot, leaves no unhandled rejection and fails nothing.
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown) => void seen.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const rejecting = setup({}, { exec: () => Promise.reject(new Error("exec rejected")) })
    await within(rejecting.fire("session_start", { reason: "start" }, rejecting.ctx))
    await within(rejecting.fire("before_agent_start", { reason: "prompt", prompt: "x" }, rejecting.ctx))
    assert.equal(rejecting.calls.exec.length, 2)
    assert.deepEqual(rejecting.calls.failures, [])

    const throwing = setup({}, { exec: () => { throw new Error("exec threw") } })
    assert.equal(await within(throwing.fire("before_agent_start", { reason: "prompt", prompt: "x" }, throwing.ctx)), undefined)
    assert.ok(throwing.calls.warn.some((l) => l.includes("exec threw")), "a synchronous failure is logged by safe()")
    assert.deepEqual(throwing.calls.failures, [])
    await settle()
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  assert.deepEqual(seen, [], "no unhandledRejection")
}

// ---- missing ~/.claude/skills tree -------------------------------------------------------------------------------
// The check reads process.env.HOME per call, so pointing it at a temp dir is valid here (the rule against changing
// HOME is about os.homedir(), which Bun does not re-read).

{
  const realHome = process.env.HOME
  try {
    // Absent: one notify across two session_start calls, naming the tree and who reads it.
    const bare = dir("home")
    process.env.HOME = bare
    const a = setup({ hasUI: true })
    await a.fire("session_start", { reason: "start" }, a.ctx)
    await a.fire("session_start", { reason: "start" }, a.ctx)
    assert.equal(a.ctx.recorded.notify.length, 1)
    const [text, level] = a.ctx.recorded.notify[0]
    assert.equal(level, "warning")
    assert.ok(text.includes(join(bare, ".claude/skills/ecomono-sdd-shared")), text)
    assert.ok(text.includes("ecomono-sdd-*") && text.includes("~/.claude/skills"), text)
    assert.deepEqual(a.calls.warn, [])
    assert.equal(a.calls.exec.length, 2, "the refresh is not tied to the warning")

    // Headless: the same once-only warning goes to the logger.
    const h = setup()
    await h.fire("session_start", { reason: "start" }, h.ctx)
    await h.fire("session_start", { reason: "start" }, h.ctx)
    assert.equal(h.ctx.recorded.notify.length, 0)
    assert.equal(h.calls.warn.length, 1)
    assert.ok(h.calls.warn[0].includes("ecomono-sdd-shared"))

    // A subagent never warns.
    const s = setup({ hasUI: true, ...sub("ecomono-explore") })
    await s.fire("session_start", { reason: "start" }, s.ctx)
    assert.equal(s.ctx.recorded.notify.length, 0)
    assert.deepEqual(s.calls.warn, [])

    // Present: silence, and it is read per call, so the tree appearing mid-session ends the warning.
    const full = dir("home")
    mkdirSync(join(full, ".claude/skills/ecomono-sdd-shared"), { recursive: true })
    process.env.HOME = full
    const p = setup({ hasUI: true })
    await p.fire("session_start", { reason: "start" }, p.ctx)
    assert.equal(p.ctx.recorded.notify.length, 0)
    assert.deepEqual(p.calls.warn, [])

    // A notify that throws is logged, not fatal.
    process.env.HOME = bare
    const t = setup({ hasUI: true })
    t.ctx.ui.notify = () => {
      throw new Error("ui gone")
    }
    await t.fire("session_start", { reason: "start" }, t.ctx)
    assert.ok(t.calls.warn.some((l) => l.includes("ui gone")))
    assert.deepEqual(t.calls.failures, [])
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
  }
  assert.equal(process.env.HOME, realHome)
}

console.log("test_spawn: all assertions passed")
