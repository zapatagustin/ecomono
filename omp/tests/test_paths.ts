// Path deny and read post-check of the omp extension, driven through fake-pi. Plain assert script. Nothing here
// reads the content of a file under test: the gate matches path strings and resolves symlinks, so the real home
// directory is safe to use in expectations, and the symlink fixtures are empty files in a temp tree. `~` is built
// from os.homedir(); HOME is never changed (Bun's os.homedir() ignores a runtime change).
import { ISOLATED, makeCtx, makePi } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
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
    // Each of these depends on exactly one normalisation step, so dropping that step fails here.
    ["read", { path: ":~.ssh/id_rsa" }], // the `:` prefix before `~`
    ["grep", { path: '".env"' }], // outer quotes
    ["grep", { path: "src,secrets" }], // the `,` split
    ["grep", { path: "src secrets" }], // the whitespace split
    // Archive members: `archive.ext:member/path`.
    ["read", { path: "x.zip:.ssh/k" }],
    ["read", { path: "x.tar.gz:secrets/a" }],
    ["read", { path: "x.zip:.aws/credentials" }],
    ["read", { path: "x.tar.gz:secrets:raw" }], // stacked selector
    ["grep", { path: "x.zip:.ssh/k" }],
    ["grep", { path: "x.tar.gz:secrets/a" }],
    ["write", { path: "x.zip:.aws/credentials" }],
    ["write", { path: "x.zip:.ssh/k" }],
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
    ["read", { path: "x.zip:docs/readme.md" }], // an ordinary archive member
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

{
  // The release valve of the bash secret gate never lifts the in-process path deny.
  const { fire, ctx } = setup()
  const saved = process.env.ECOMONO_ALLOW_SECRET_PATHS
  process.env.ECOMONO_ALLOW_SECRET_PATHS = "1"
  try {
    assert.equal((await fire("tool_call", call("read", { path: ".env" }), ctx))?.block, true)
  } finally {
    if (saved === undefined) delete process.env.ECOMONO_ALLOW_SECRET_PATHS
    else process.env.ECOMONO_ALLOW_SECRET_PATHS = saved
  }
}

// ---- symlinks -------------------------------------------------------------------------------------------------

{
  // omp follows a link, so its target meets the globs: a link to a denied file, a link to a denied directory, and
  // a new file below that linked directory. A link to an ordinary file still passes.
  const { fire, calls, ctx } = setup()
  const outside = dir("outside")
  mkdirSync(join(outside, ".ssh"))
  writeFileSync(join(outside, ".ssh/id_ed25519"), "")
  writeFileSync(join(outside, "plain.txt"), "")
  mkdirSync(join(ctx.cwd, "docs"))
  symlinkSync(join(outside, ".ssh/id_ed25519"), join(ctx.cwd, "docs/notes"))
  symlinkSync(join(outside, ".ssh"), join(ctx.cwd, "docs/sshdir"))
  symlinkSync(join(outside, "plain.txt"), join(ctx.cwd, "docs/plain"))
  for (const [tool, input] of [
    ["read", { path: "docs/notes" }],
    ["read", { path: "docs/notes:1-5" }],
    ["grep", { path: "docs/sshdir" }],
    ["write", { path: "docs/sshdir/newkey" }],
    ["write", { path: "docs/sshdir/new/deeper" }],
  ] as const) {
    assert.equal((await fire("tool_call", call(tool, input), ctx))?.block, true, `${tool} ${JSON.stringify(input)}`)
  }
  assert.equal(await fire("tool_call", call("read", { path: "docs/plain" }), ctx), undefined)
  // The read post-check uses the same check.
  const r = await fire("tool_result", { toolName: "read", toolCallId: "c", input: { path: "notes" }, content: [], details: { displayReadTargets: ["docs/notes"] } }, ctx)
  assert.equal(r?.isError, true)
  assert.deepEqual(calls.warn, [])
}

// ---- edit: the targets in its text input ------------------------------------------------------------------------

{
  const { fire, ctx } = setup()
  const denied: Array<Record<string, unknown>> = [
    { path: "README.md", input: "[.env#1A2B]\n+x\n" }, // a hashline header next to an unrelated path
    { input: "[~/.ssh/authorized_keys#ABCD]\nREM\n" },
    { input: "[README.md#1A2B]\nMV ~/.ssh/authorized_keys\n" }, // a hashline rename
    { input: "[README.md#1A2B]\nMV: secrets/moved\n" },
    { input: "[*** Begin Patch] [.env#ABCD]\n+x\n" }, // envelope-wrapped header
    { input: "[.env#AUTO]\n+x\n" }, // a placeholder tag
    { input: '["secrets/a b.txt"#1A2B]\n+x\n' }, // quoted, with a space
    { input: "\u00b6.env#1A2B\n+x\n" }, // legacy header
    { _input: "[.env#1A2B]\n+x\n" },
    { input: "*** Begin Patch\n*** Update File: .env\n@@\n+x\n*** End Patch\n" }, // apply_patch
    { input: "*** Begin Patch\n*** Add File: secrets/new.txt\n+x\n*** End Patch\n" },
    { input: "*** Begin Patch\n*** Delete File: ~/.ssh/id_rsa\n*** End Patch\n" },
    { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ~/.ssh/config\n@@\n+x\n*** End Patch\n" },
    { path: "src/a.ts", edits: [{ rename: ".env" }] }, // patch mode rename
  ]
  for (const input of denied) {
    const r = await fire("tool_call", call("edit", input), ctx)
    assert.equal(r?.block, true, JSON.stringify(input))
    assert.match(r.reason, /opencode\/opencode\.json/, JSON.stringify(input))
  }
  // Body lines are content, not targets: an edit may mention a secret path.
  const allowed: Array<Record<string, unknown>> = [
    { path: "README.md", input: "[README.md#1A2B]\n+keep API keys in .env\n+see ~/.ssh/config\n" },
    { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-[.env]: old\n+x\n*** End Patch\n" },
    { path: "src/a.ts", edits: [{ rename: "src/b.ts", diff: "+.env" }] },
    { path: "src/a.ts", input: 7, edits: "nope" },
  ]
  for (const input of allowed) assert.equal(await fire("tool_call", call("edit", input), ctx), undefined, JSON.stringify(input))
  // Only edit reads `input`.
  assert.equal(await fire("tool_call", call("write", { path: "src/a.ts", input: "[.env#1A2B]" }), ctx), undefined)
}

// ---- task: @-mentions in an item's task text ------------------------------------------------------------------

{
  const { fire, ctx } = setup()
  const task = (input: unknown) => call("task", input)
  const denied: unknown[] = [
    { tasks: [{ agent: "task", task: "Summarize @.env" }] },
    { tasks: [{ agent: "task", task: "look at @~/.ssh/id_ed25519 please" }] },
    { tasks: [{ agent: "task", task: 'read @"secrets/a b.txt"' }] },
    { tasks: [{ task: "check (@.env)." }] }, // no agent: omp still reads the mention
    { tasks: [{ agent: "a", task: "fine" }, { agent: "b", task: "and @secrets/x" }] },
    { agent: "task", task: "Summarize @'.env'" }, // non-batch
  ]
  for (const input of denied) {
    const r = await fire("tool_call", task(input), ctx)
    assert.equal(r?.block, true, JSON.stringify(input))
    assert.match(r.reason, /task mention "@/, JSON.stringify(input))
    assert.match(r.reason, /opencode\/opencode\.json/, JSON.stringify(input))
  }
  // No agent, so no judge script runs: the verdict is the mention check alone.
  for (const input of [
    { tasks: [{ task: "mail user@.env" }] }, // not at a mention boundary
    { tasks: [{ task: "see @src/a.ts." }] },
    { context: "@.env", tasks: [{ task: "x" }] }, // context is the system prompt: omp reads no mention there
  ]) {
    assert.equal(await fire("tool_call", task(input), ctx), undefined, JSON.stringify(input))
  }
}

// ---- a handler fault fails open ---------------------------------------------------------------------------------

{
  // A ctx with no cwd makes path resolution throw inside the handler: the call is allowed (not failed closed by
  // omp) and the fault is logged.
  const { fire, calls } = setup()
  const ctx = makeCtx({ cwd: undefined })
  assert.equal(await fire("tool_call", call("read", { path: ".env" }), ctx), undefined)
  assert.ok(calls.warn.some((l) => l.includes("[tool-call] failing open") && l.includes("handler failed")), calls.warn.join("\n"))
  assert.deepEqual(calls.failures, [])
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
