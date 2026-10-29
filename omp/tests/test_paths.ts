// Path deny and read post-check of the omp extension, driven through fake-pi. Plain assert script. Nothing here
// reads a file under test: the gate only matches path strings, so the real home directory is safe to use in
// expectations. `~` is built from os.homedir(); HOME is never changed (Bun's os.homedir() ignores a runtime
// change, design.md F16).
import { ISOLATED, makeCtx, makePi } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"

const TMP = mkdtempSync(join(ISOLATED, "paths-"))
let seq = 0
const dir = (label: string) => {
  const d = join(TMP, `${label}-${++seq}`)
  mkdirSync(d, { recursive: true })
  return d
}

const setup = (repo: string = REPO) => {
  const { pi, fire, calls } = makePi()
  // An empty hooksDir: the path gate runs no script, and a call that reached one would fail open and show.
  ecomono({ repo, hooksDir: dir("hooks") })(pi)
  return { fire, calls, ctx: makeCtx({ cwd: dir("cwd") }) }
}
const call = (toolName: string, input: unknown) => ({ toolName, toolCallId: "call-1", input })
const home = homedir()

// ---- the globs are the file's, not a copy -------------------------------------------------------------------

const readRules: Record<string, string> = JSON.parse(readFileSync(join(REPO, "opencode/opencode.json"), "utf8")).permission.read
const denyKeys = Object.entries(readRules).filter(([, v]) => v === "deny").map(([k]) => k)
/** A path the glob matches: `**` + `/` becomes a directory, a lone `*` a name. */
const sample = (glob: string) => glob.replace(/\*\*\//g, "/x/").replace(/\*\*/g, "a").replace(/\*/g, "a")

{
  assert.ok(denyKeys.length > 0, "opencode.json has deny globs")

  // Every deny key blocks its own sample on the real file, and the reason names a key of the file.
  const real = setup()
  for (const key of denyKeys) {
    const r = await real.fire("tool_call", call("read", { path: sample(key) }), real.ctx)
    assert.equal(r?.block, true, `${key}: ${sample(key)}`)
    assert.match(r.reason, /opencode\/opencode\.json/, key)
    assert.ok(denyKeys.some((k) => r.reason.includes(`"${k}"`)), `${key}: the reason names a glob of the file`)
  }

  // A repo whose file holds only one deny key blocks that key's sample and names exactly it: each key compiles.
  for (const key of denyKeys) {
    const repo = dir("repo")
    mkdirSync(join(repo, "opencode"))
    writeFileSync(join(repo, "opencode/opencode.json"), JSON.stringify({ permission: { read: { "*": "allow", [key]: "deny" } } }))
    const one = setup(repo)
    const r = await one.fire("tool_call", call("read", { path: sample(key) }), one.ctx)
    assert.equal(r?.block, true, key)
    assert.ok(r.reason.includes(`"${key}"`), `${key}: ${r.reason}`)
  }

  // Only the "deny" values count; nothing is hard-coded in the extension.
  const repo = dir("repo")
  mkdirSync(join(repo, "opencode"))
  writeFileSync(
    join(repo, "opencode/opencode.json"),
    JSON.stringify({ permission: { read: { "*": "allow", "**/zzz/**": "deny", "*.foo": "ask", "*.bar": "allow", "*.env": 1 } } }),
  )
  const t = setup(repo)
  assert.equal((await t.fire("tool_call", call("read", { path: "/x/zzz/a" }), t.ctx))?.block, true)
  for (const p of ["a.foo", "a.bar", ".env", "a.env", "/x/.ssh/id_rsa"]) {
    assert.equal(await t.fire("tool_call", call("read", { path: p }), t.ctx), undefined, p)
  }

  // A file that is missing, unparseable, or has no permission.read: one warning, nothing denied.
  const bad = dir("repo")
  mkdirSync(join(bad, "opencode"))
  writeFileSync(join(bad, "opencode/opencode.json"), "{not json")
  const empty = dir("repo")
  mkdirSync(join(empty, "opencode"))
  writeFileSync(join(empty, "opencode/opencode.json"), JSON.stringify({ permission: {} }))
  for (const [label, r, warns] of [["unparseable", bad, 1], ["missing", dir("repo"), 1], ["no permission.read", empty, 0]] as const) {
    const u = setup(r)
    assert.equal(await u.fire("tool_call", call("read", { path: ".env" }), u.ctx), undefined, label)
    assert.equal(await u.fire("tool_call", call("read", { path: ".env" }), u.ctx), undefined, label)
    assert.equal(u.calls.warn.filter((l) => l.includes("path deny disabled")).length, warns, label)
  }
}

// ---- denied -------------------------------------------------------------------------------------------------

{
  const { fire, ctx } = setup()
  const cwd: string = ctx.cwd
  const denied: Array<[string, unknown]> = [
    ["read", { path: "~/.ssh/id_rsa" }],
    ["read", { path: `${cwd}/.env` }],
    ["read", { path: ".env.prod" }],
    ["read", { path: `${cwd}/.env:1-5` }],
    ["read", { path: ".env:raw" }],
    ["read", { path: ".env:1-5:raw" }], // compound selector
    ["read", { path: ".env:raw:1-5" }], // compound selector, raw first
    ["read", { path: "/x/a.key?q=1" }],
    ["read", { path: "/x/k.pem" }],
    ["read", { path: "/x/.aws/credentials" }],
    ["read", { path: "/x/secrets/s" }],
    ["read", { path: "/x/.credentials/c" }],
    ["read", { path: "/x/credentials.json" }],
    ["read", { path: "/x/prod.env" }],
    ["read", { path: "src/a.ts;.env" }], // semicolon list
    ["read", { path: "skill://x;.env" }], // mixed URL list
    ["read", { path: `file://${home}/.ssh/id_rsa` }],
    ["read", { path: "@~/.ssh/id_rsa" }],
    ["read", { path: '"~/.ssh/id_rsa"' }], // outer quotes
    ["read", { path: ":~/.ssh/id_rsa" }],
    ["read", { path: "~.ssh/id_rsa" }], // expandTilde form
    ["grep", { path: "~/.ssh" }], // a directory
    ["grep", { path: "~\\.ssh" }], // `~`, one backslash, `.ssh`: omp searches ~/.ssh
    ["read", { path: "ssh://host/home/u/.ssh/id_rsa" }],
    ["read", { path: "ssh://host/~/.ssh/id_rsa" }],
    ["grep", { paths: ["src", "~/.ssh"] }],
    ["grep", { paths: "src;.env" }],
    ["grep", { path: "src, .env" }],
    ["glob", { path: "secrets" }],
    ["edit", { paths: ["src/a.ts", ".env"] }],
    ["ast_grep", { path: "src;.env" }],
    ["ast_edit", { paths: ["src/a.ts", "b.key"] }],
    ["write", { path: ".env" }],
    // Beyond the required list: the other tools and the other spellings of the same forms.
    ["find", { path: "~/.ssh" }],
    ["read", { path: "ssh://user@host:2222/home/u/.ssh/id_rsa" }],
    ["read", { path: "ssh://host/home/u/%2Eenv" }],
    ["read", { path: '"ssh://host/home/u/.env"' }],
    ["read", { path: "src/a.ts\n.env" }],
    ["read", { path: `${cwd}/.env:raw?x=1` }],
    ["grep", { path: ".env", paths: ["src"] }],
    // A JSON-encoded string array: grep, glob and ast_grep decode it before resolving (toPathList).
    ["grep", { path: '[".env"]' }],
    ["grep", { path: '["src","~/.ssh"]' }],
    ["glob", { path: '["secrets"]' }],
    ["ast_grep", { path: '[".env"]' }],
    ["grep", { path: '["/x/.env"]' }],
    ["grep", { path: '["~\\/.ssh"]' }], // JSON-escaped slash: decodes to ~/.ssh
    ["grep", { path: ' [ "src" , "b.key" ] ' }], // padded
    ["grep", { paths: ['["src",".env"]'] }], // inside an array
  ]
  for (const [tool, input] of denied) {
    const r = await fire("tool_call", call(tool, input), ctx)
    const label = `${tool} ${JSON.stringify(input)}`
    assert.equal(r?.block, true, label)
    assert.match(r.reason, /opencode\/opencode\.json/, label)
    const value = Object.values(input as Record<string, string | string[]>).flat().find((v) => r.reason.includes(`"${v}"`))
    assert.ok(value !== undefined, `${label}: the reason names the original value: ${r.reason}`)
  }
}

// ---- allowed ------------------------------------------------------------------------------------------------

{
  const { fire, ctx } = setup()
  const allowed: Array<[string, unknown]> = [
    ["read", { path: "src/main.ts" }],
    ["read", { path: "src/a.ts:1-5,10-12" }],
    ["read", { path: "skill://ecomono-commit" }],
    ["read", { path: "xd://mcp__ecomono_memory_mem_save" }],
    ["read", { path: "https://example.com/.env" }],
    ["read", { path: "ssh://host/etc/hosts" }],
    ["glob", { pattern: "**/*.ts" }], // no path at all
    ["grep", { pattern: "x", paths: 42 }], // a non-string is ignored
    ["grep", { path: 7, paths: [null, {}, 1] }],
    ["read", { path: "environment.ts" }],
    ["read", { path: "src/.envrc.ts" }],
    ["grep", { path: '["src","lib"]' }], // a JSON array of ordinary paths
    ["grep", { path: '["src", 1, null]' }], // non-string entries are ignored
    ["grep", { path: "[not json" }],
    ["bash", { command: "ls" }], // not a path tool
    ["lsp", { file: ".env" }], // not a path tool (documented ceiling)
  ]
  for (const [tool, input] of allowed) {
    assert.equal(await fire("tool_call", call(tool, input), ctx), undefined, `${tool} ${JSON.stringify(input)}`)
  }
}

// ---- read post-check ----------------------------------------------------------------------------------------

{
  const { fire, calls, ctx } = setup()
  const body = [{ type: "text", text: "FILE CONTENT" }]
  const result = (details: unknown, over: Record<string, any> = {}) => ({
    toolName: "read",
    toolCallId: "call-1",
    input: { path: "prod" },
    content: body,
    details,
    isError: false,
    ...over,
  })

  // A suffix resolution into a denied file: content withheld, details untouched.
  const sr = { suffixResolution: { from: "prod", to: "secrets/prod" } }
  const r = await fire("tool_result", result(sr), ctx)
  assert.equal(r?.isError, true)
  assert.equal(r.content.length, 1)
  assert.equal(r.content[0].type, "text")
  assert.match(r.content[0].text, /withheld/)
  assert.equal(
    r.content[0].text,
    "ecomono: read resolved to secrets/prod, which **/secrets/** in opencode/opencode.json denies; content withheld.",
  )
  assert.ok(!JSON.stringify(r.content).includes("FILE CONTENT"))
  assert.deepEqual(r.details, sr, "details are left as omp produced them")

  // Delimited parts: one denied target is enough.
  const dr = await fire("tool_result", result({ displayReadTargets: ["src/a.ts", "config/.env"] }), ctx)
  assert.equal(dr?.isError, true)
  assert.match(dr.content[0].text, /config\/\.env/)
  assert.match(dr.content[0].text, /withheld/)

  // The same helper as the path gate: selectors, tilde and absolute targets count too.
  for (const target of [`${home}/.ssh/id_rsa`, "~/.ssh/id_rsa", ".env:raw", "/x/k.pem"]) {
    const t = await fire("tool_result", result({ displayReadTargets: [target] }), ctx)
    assert.equal(t?.isError, true, target)
  }

  // Allowed targets, and shapes that carry none: the result is not touched.
  assert.equal(await fire("tool_result", result({ suffixResolution: { from: "prod", to: "src/prod.ts" } }), ctx), undefined)
  assert.equal(await fire("tool_result", result({ displayReadTargets: ["src/a.ts", "src/b.ts"] }), ctx), undefined)
  assert.equal(await fire("tool_result", result(undefined), ctx), undefined)
  for (const details of [null, "secrets/prod", 3, [], {}, { suffixResolution: null }, { suffixResolution: { to: 5 } }, { displayReadTargets: "secrets/x" }, { displayReadTargets: [1, null, {}] }]) {
    assert.equal(await fire("tool_result", result(details), ctx), undefined, JSON.stringify(details))
  }

  // Only `read`: another tool's details are not looked at.
  assert.equal(await fire("tool_result", result(sr, { toolName: "grep" }), ctx), undefined)
  assert.deepEqual(calls.warn, [], "safe() caught nothing: no handler threw")
}

console.log("test_paths: all assertions passed")
