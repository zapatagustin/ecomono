// Bash compression and compaction style in the omp extension, driven through fake-pi. Plain assert script.
import { ISOLATED, makeCtx, makePi } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { STYLE } from "../../opencode/plugins/cave-compress/core.ts"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"

// The reference compressor: the extension must produce exactly what Claude's hook script produces.
const ref = createRequire(import.meta.url)(join(REPO, "claude/hooks/ecomono-compress.js"))

const statsFile = join(process.env.XDG_CACHE_HOME!, "ecomono-compress", "stats.jsonl")
const statsLines = () => (existsSync(statsFile) ? readFileSync(statsFile, "utf8").split("\n").filter(Boolean) : [])

const bigBody = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n")
const NOTICE = ["", "Wall time: 2.1 seconds", "[raw output: artifact://3]", "", "Command exited with code 1"].join("\n")

const setup = (repo = REPO) => {
  const { pi, fire, calls } = makePi()
  ecomono({ repo })(pi)
  return { fire, calls, ctx: makeCtx() }
}
const bash = (text: string, over: Record<string, any> = {}) => ({
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "seq 2000" },
  content: [{ type: "text", text }],
  details: undefined,
  isError: false,
  ...over,
})

{
  // Registration: exactly the two events this slice owns.
  const { calls } = setup()
  assert.deepEqual(calls.on.map(([name]) => name), ["tool_result", "session.compacting"])
}

{
  // (1) A long body with the notices omp appends: compressed, notices re-appended untouched, error flag kept.
  const { fire, ctx } = setup()
  const text = bigBody + "\n" + NOTICE
  const r = await fire("tool_result", bash(text, { isError: true }), ctx)
  const out: string = r.content[0].text
  assert.ok(out.length < text.length)
  assert.ok(out.includes("lines omitted"))
  assert.ok(out.endsWith(NOTICE), "the original notice block comes back exactly")
  assert.equal(out, ref.compressBash(bigBody, "seq 2000") + "\n" + NOTICE)
  assert.equal(r.isError, true)
  assert.equal(r.content.length, 1)
}

{
  // (2) A body ending in a one-line JSON array is not mistaken for a notice: it is compressed with the body.
  const { fire, ctx } = setup()
  const body = bigBody + "\n[1,2,3]"
  const tail = "\n\nWall time: 1.0 seconds"
  const r = await fire("tool_result", bash(body + tail), ctx)
  assert.equal(r.content[0].text, ref.compressBash(body, "seq 2000") + tail)
  assert.notEqual(r.content[0].text, ref.compressBash(bigBody, "seq 2000") + "\n[1,2,3]" + tail, "peeling would keep one more line")
}

{
  // (3) Eval-bridged results go back to a script and are never touched.
  const { fire, ctx } = setup()
  for (const id of ["js-bash-1", "prelude-1"]) assert.equal(await fire("tool_result", bash(bigBody, { toolCallId: id }), ctx), undefined)
}

{
  // (4) Other tools are never rewritten: read output feeds hashline anchors.
  const { fire, ctx } = setup()
  const r = await fire("tool_result", bash(bigBody, { toolName: "read", input: { path: "a.txt" }, details: { displayReadTargets: [] } }), ctx)
  assert.equal(r, undefined)
}

{
  // (5) ECOMONO_COMPRESS=off disables it, read per call.
  const { fire, ctx } = setup()
  const prev = process.env.ECOMONO_COMPRESS
  process.env.ECOMONO_COMPRESS = "off"
  try {
    assert.equal(await fire("tool_result", bash(bigBody), ctx), undefined)
  } finally {
    if (prev === undefined) delete process.env.ECOMONO_COMPRESS
    else process.env.ECOMONO_COMPRESS = prev
  }
  assert.ok(await fire("tool_result", bash(bigBody), ctx), "back on once the variable is restored")
}

{
  // (6) Non-text parts survive, after the text, in their original order.
  const { fire, ctx } = setup()
  const image = { type: "image", data: "AAAA", mimeType: "image/png" }
  const r = await fire("tool_result", bash("", { content: [image, { type: "text", text: bigBody }] }), ctx)
  assert.equal(r.content.length, 2)
  assert.equal(r.content[0].type, "text")
  assert.ok(r.content[0].text.includes("lines omitted"))
  assert.deepEqual(r.content[1], image)
}

{
  // (7) A changed result appends exactly one stats line, under the isolated cache dir and not the real one.
  assert.ok(process.env.XDG_CACHE_HOME!.startsWith(ISOLATED))
  const realStats = join(homedir(), ".cache", "ecomono-compress", "stats.jsonl")
  const realSize = () => (existsSync(realStats) ? statSync(realStats).size : 0)
  const realBefore = realSize()
  const started = Date.now()
  const { fire, ctx } = setup()
  const before = statsLines().length
  const text = bigBody + "\n" + NOTICE
  assert.ok(await fire("tool_result", bash(text), ctx))
  const lines = statsLines()
  assert.equal(lines.length, before + 1)
  const rec = JSON.parse(lines.at(-1)!)
  assert.equal(rec.tool, "omp.bash")
  assert.equal(rec.in, bigBody.length, "stats measure the body, not the notices")
  assert.ok(rec.out < rec.in && rec.t >= started)
  // The real file can only grow from another live session, so look for this test's own record rather than a size.
  if (realSize() !== realBefore) {
    const mine = readFileSync(realStats, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return {} } })
      .filter((r) => r.tool === "omp.bash" && r.in === rec.in && r.out === rec.out && r.t >= started)
    assert.equal(mine.length, 0, "no stats line may reach the real ~/.cache")
  }
}

{
  // (8) Short output passes through: nothing returned, nothing logged.
  const { fire, ctx } = setup()
  const before = statsLines().length
  assert.equal(await fire("tool_result", bash("ok\n\nWall time: 0.1 seconds"), ctx), undefined)
  assert.equal(statsLines().length, before)
}

{
  // (9) A repo without the hook script: pass through, one warning however many results follow.
  const repo = mkdtempSync(join(tmpdir(), "ecomono-omp-norepo-"))
  const { fire, calls, ctx } = setup(repo)
  assert.equal(await fire("tool_result", bash(bigBody), ctx), undefined)
  assert.equal(await fire("tool_result", bash(bigBody), ctx), undefined)
  assert.equal(calls.warn.length, 1)
  assert.ok(calls.warn[0].includes("ecomono-compress.js"))
}

{
  // (10) Compaction: the style text, unless compression is off.
  const { fire, ctx } = setup()
  assert.deepEqual(await fire("session.compacting", {}, ctx), { context: [STYLE] })
  const prev = process.env.ECOMONO_COMPRESS
  process.env.ECOMONO_COMPRESS = "off"
  try {
    assert.equal(await fire("session.compacting", {}, ctx), undefined)
  } finally {
    if (prev === undefined) delete process.env.ECOMONO_COMPRESS
    else process.env.ECOMONO_COMPRESS = prev
  }
}

{
  // (11) Malformed events return undefined and never throw: a throw here would only be logged, but nothing
  // ecomono does may depend on that.
  const { fire, calls, ctx } = setup()
  const good = bash(bigBody)
  const { content: _c, ...noContent } = good
  const { input: _i, ...noInput } = good
  const { toolName: _t, ...noTool } = good
  for (const ev of [{ ...good, content: "not an array" }, { ...good, content: null }, noContent, noInput, { ...good, input: null }, noTool, {}, { toolName: "bash" }]) {
    assert.equal(await fire("tool_result", ev, ctx), undefined, JSON.stringify(Object.keys(ev)))
  }
  assert.equal(await fire("tool_result", undefined, ctx), undefined)
  assert.deepEqual(calls.warn, [], "safe() caught nothing: no handler threw")
}

console.log("test_compress: all assertions passed")
