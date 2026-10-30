// Path deny and read post-check of the omp extension, driven through fake-pi. Plain assert script. Nothing here
// reads the content of a file under test: the gate matches path strings and resolves symlinks, so the real home
// directory is safe to use in expectations, and the symlink fixtures are empty files in a temp tree. `~` is built
// from os.homedir(); HOME is never changed (Bun's os.homedir() ignores a runtime change).
import { dir, makeCtx, makePi, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"

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

  // The last matching key wins, as in OpenCode: an "allow" after a "deny" lifts it, a "deny" after an "allow" holds,
  // and an "ask" (or any other value) is skipped, so it never lifts a deny before it.
  const order = (read: Record<string, unknown>) => {
    const r = dir("repo")
    mkdirSync(join(r, "opencode"))
    writeFileSync(join(r, "opencode/opencode.json"), JSON.stringify({ permission: { read } }))
    return setup(r)
  }
  const last = order({ "*": "allow", "*.foo": "deny", "ok.foo": "allow", "ask.foo": "ask" })
  assert.equal((await last.fire("tool_call", call("read", { path: "a.foo" }), last.ctx))?.block, true)
  assert.equal(await last.fire("tool_call", call("read", { path: "ok.foo" }), last.ctx), undefined)
  assert.equal((await last.fire("tool_call", call("read", { path: "ask.foo" }), last.ctx))?.block, true)
  const flipped = order({ "*": "allow", "ok.foo": "allow", "*.foo": "deny" })
  assert.equal((await flipped.fire("tool_call", call("read", { path: "ok.foo" }), flipped.ctx))?.block, true)
  // Allow entries alone deny nothing.
  const allowOnly = order({ "*": "allow", "*.foo": "allow" })
  assert.equal(await allowOnly.fire("tool_call", call("read", { path: "a.foo" }), allowOnly.ctx), undefined)

  // The extension reads the keys in file order and OpenCode gets them in byte order on the Nix deploy (builtins.toJSON
  // sorts attribute names), so the file keeps them in byte order: both hosts then see the same last match.
  const keys = Object.keys(readRules)
  assert.deepEqual(keys, [...keys].sort(), "opencode.json permission.read keys are not in byte order")

  // OpenCode reads the same keys its own way: `*` and `**` both become `.*`, so they match "/", the whole value must
  // match, and the last matching key wins. Mirrored from OpenCode packages/core/src/util/wildcard.ts match() (its
  // trailing " *" case is for bash commands only) and permission evaluate() (findLast), over the keys in byte order.
  // So an "allow" for a name such as `*.env.example` would lift `**/secrets/**` there: the file has none besides "*",
  // and the extension takes the templates from the bash gate's `for benign in` line instead.
  assert.deepEqual(Object.entries(readRules).filter(([k, v]) => v === "allow" && k !== "*"), [])
  const ocMatch = (input: string, key: string) =>
    new RegExp(`^${key.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(input)
  const ocVerdict = (path: string) => readRules[keys.findLast((k) => ocMatch(path, k)) ?? "*"]
  const ompVerdict = async (path: string) =>
    (await real.fire("tool_call", call("read", { path }), real.ctx))?.block === true ? "deny" : "allow"
  // Both hosts agree on a template inside a denied directory, on the `.env` names, and on omp's credential store.
  const agreed: Array<[string, string]> = [
    ["x/secrets/.env.example", "deny"],
    ["/h/.ssh/x.env.sample", "deny"],
    ["/h/.credentials/a.env.dist", "deny"],
    ["/U/Library/Keychains/k.env.template", "deny"],
    ["config/.env", "deny"],
    [".env.example.local", "deny"],
    ["/h/.omp/agent/agent.db", "deny"],
    ["/h/.omp/agent/agent.db-wal", "deny"],
    ["/h/.omp/auth-broker.token", "deny"],
    ["/h/.omp/auth-gateway.token", "deny"],
    ["src/agent.db.ts", "allow"],
    ["src/a.ts", "allow"],
  ]
  for (const [path, verdict] of agreed) {
    assert.equal(ocVerdict(path), verdict, `OpenCode: ${path}`)
    assert.equal(await ompVerdict(path), verdict, `omp: ${path}`)
  }
  // The one drift, documented: OpenCode denies a template the omp extension and the bash gate let through.
  for (const path of [".env.example", "config/.env.sample"]) {
    assert.equal(ocVerdict(path), "deny", `OpenCode: ${path}`)
    assert.equal(await ompVerdict(path), "allow", `omp: ${path}`)
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
    // omp's credential store, agent.db, wherever the agent dir is: the default, a profile, a PI_CODING_AGENT_DIR
    // override, an XDG data dir; the sqlite selector `:table`, and the wal and shm siblings.
    ["read", { path: "~/.omp/agent/agent.db" }],
    ["read", { path: "~/.omp/agent/agent.db:auth_credentials" }],
    ["read", { path: "~/.omp/agent/agent.db:auth_credentials:raw" }],
    ["read", { path: "~/.omp/agent/agent.db-wal" }],
    ["read", { path: "~/.omp/agent/agent.db-shm" }],
    ["read", { path: "~/.omp/profiles/work/agent/agent.db" }],
    ["grep", { path: "/srv/omp-agent/agent.db" }],
    ["read", { path: "~/.local/share/omp/agent.db" }],
    ["write", { path: "~/.omp/agent/agent.db" }],
    ["read", { path: "agent.db" }],
    ["read", { path: "~/.omp/agent/agent.db-journal" }],
    // A sqlite selector whose key holds a `/`: omp still reads agent.db (SQLITE_PATH_PATTERN).
    ["read", { path: "~/.omp/agent/agent.db:auth_credentials:a/b" }],
    ["read", { path: "~/.omp/agent/agent.db:auth_credentials?q=1/2" }],
    ["grep", { path: "/srv/omp/agent.db:t:x/y/z" }],
    // A template name inside a denied directory: the directory's glob still holds.
    ["read", { path: "secrets/.env.example" }],
    ["read", { path: ".env.example.local" }], // not a template name: `*.env.*` is the last match
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
    ["read", { path: "src/myagent.db" }], // agent.db is a whole file name
    ["read", { path: "src/agent.ts" }],
    ["read", { path: "src/agent.db.ts" }], // and has a right boundary
    ["read", { path: "agent.dbx" }],
    ["read", { path: "src/agent.db.ts:1-5" }],
    // The `.env` templates the bash gate also lets through, read from its `for benign in` line.
    ["read", { path: ".env.example" }],
    ["read", { path: "config/.env.sample" }],
    ["grep", { path: `${home}/x/.env.template` }],
    ["read", { path: ".env.dist" }],
    ["read", { path: ".env.defaults" }],
    ["read", { path: ".env.schema" }],
    ["read", { path: "app.env.example" }],
    ["read", { path: "~/.omp/agent/config.yml" }], // the rest of the agent dir is not credential storage
    ["bash", { command: "ls" }], // not a path tool
    ["lsp", { file: ".env" }], // not a path tool (documented ceiling)
  ]
  for (const [tool, input] of allowed) {
    assert.equal(await fire("tool_call", call(tool, input), ctx), undefined, `${tool} ${JSON.stringify(input)}`)
  }
}

{
  // A doubled or trailing space in the gate's `for benign in` line leaves no empty template, which every name ends in
  // and so would lift the deny on every file.
  const repo = dir("repo")
  mkdirSync(join(repo, "opencode"))
  mkdirSync(join(repo, "claude/hooks"), { recursive: true })
  writeFileSync(join(repo, "opencode/opencode.json"), readFileSync(join(REPO, "opencode/opencode.json")))
  writeFileSync(join(repo, "claude/hooks/secret-access-gate.sh"), "#!/bin/sh\nfor benign in  .env.example   .env.sample ; do\n  :\ndone\n")
  const { fire, calls, ctx } = setup(repo)
  for (const path of [".env", "server.key", "id.pem", "credentials.json", "~/.omp/agent/agent.db", ".env.local"]) {
    assert.equal((await fire("tool_call", call("read", { path }), ctx))?.block, true, path)
  }
  for (const path of [".env.example", "config/.env.sample"]) {
    assert.equal(await fire("tool_call", call("read", { path }), ctx), undefined, path)
  }
  assert.deepEqual(calls.warn, [])
}

{
  // The release valve of the bash secret gate never lifts the in-process path deny.
  const { fire, ctx } = setup()
  await withEnv({ ECOMONO_ALLOW_SECRET_PATHS: "1" }, async () => {
    assert.equal((await fire("tool_call", call("read", { path: ".env" }), ctx))?.block, true)
  })
}

{
  // A read whose input names no path under either key is a shape omp 18.14.0 never sends: it is allowed, and the
  // warning says the path deny skipped it, once. A well-formed read stays silent.
  const { fire, calls, ctx } = setup()
  for (const input of [{}, { file: ".env" }, { path: 7 }]) {
    assert.equal(await fire("tool_call", call("read", input), ctx), undefined, JSON.stringify(input))
  }
  const drift = calls.warn.filter((l) => l.includes("unexpected omp shape"))
  assert.equal(drift.length, 1)
  assert.ok(drift[0].includes("read tool_call"), drift[0])
  const quiet = setup()
  await quiet.fire("tool_call", call("read", { path: "a.txt" }), quiet.ctx)
  await quiet.fire("tool_call", call("grep", { pattern: "x" }), quiet.ctx)
  assert.deepEqual(quiet.calls.warn, [])
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
    // The sloppy mode's header: `*** Edit File: X`, the `:` optional, a trailing ` all` allowed.
    { input: "*** Edit File: .env\n*** Find\nA=1\n*** Replace\nA=2\n" },
    { input: "*** Edit File secrets/a.txt all\n*** Find\nx\n*** Replace\ny\n" },
    { input: '*** edit file: "secrets/a b.txt"\n*** Insert After\nx\n' },
    { path: "README.md", input: "*** Edit File: ~/.ssh/config\n*** Find\nx\n" },
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
    { input: "*** Edit File: src/a.ts\n*** Find\n.env\n*** Replace\nsecrets/x\n" }, // the sloppy body is content
    { input: "*** Edit File: src/a.ts all\n*** Find\nx\n*** Replace\ny\n" },
  ]
  for (const input of allowed) assert.equal(await fire("tool_call", call("edit", input), ctx), undefined, JSON.stringify(input))
  // A long header-like line with no `:` is linear work: the engine's own spelling of the header regex, run by
  // JavaScript's backtracking engine, is quadratic on it (seconds at this length), the one here is not.
  const started = performance.now()
  await fire("tool_call", call("edit", { path: "src/a.ts", input: `*** add${" ".repeat(100_000)}x\n` }), ctx)
  assert.ok(performance.now() - started < 1000, `a 100k-character header line took ${Math.round(performance.now() - started)} ms`)
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
    // A double-encoded task (omp: repairTaskParams runs after tool_call): the child gets the decoded text.
    { tasks: [{ agent: "task", task: "Summarize.\\n@.env\\nThanks." }] }, // two escapes, so omp unescapes it
    { agent: "task", task: "see\\n@~/.ssh/id_ed25519\\n" }, // non-batch
    { tasks: [{ task: 'read @\\"secrets/a b.txt\\" now' }] }, // a structural `\"`: decodes to a quoted mention
    { tasks: [{ task: "look at @\\u002eenv" }] }, // a `\uXXXX` escape: decodes to `@.env`
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
    { context: "x\\n@.env\\n", tasks: [{ task: "x" }] }, // decoded or not, context is never scanned
    // omp leaves these as typed, so the child sees no mention.
    { tasks: [{ task: "see\\n@.env" }] }, // one escape: no double-encoding signature
    { tasks: [{ task: "C:\\Users\\@.env\\n" }] }, // not a JSON string body: `\U` is no escape
    { tasks: [{ task: "Summarize.\\n@src/a.ts\\nThanks." }] }, // decoded, still an ordinary mention
  ]) {
    assert.equal(await fire("tool_call", task(input), ctx), undefined, JSON.stringify(input))
  }
}

// ---- task: taskFile -----------------------------------------------------------------------------------------

{
  // omp 18.14.0's task.file (off by default) lets an item, or the flat call, name an absolute path or local:// URL
  // whose contents omp reads into the child's first prompt (task/index.ts resolveTaskFile). The path is denied like
  // a path tool's; the reason names the path the model typed, never one it did not.
  const { fire, calls, ctx } = setup()
  const task = (input: unknown) => call("task", input)
  for (const input of [
    { tasks: [{ taskFile: `${ctx.cwd}/.env` }] },
    { tasks: [{ agent: "a", task: "fine" }, { agent: "b", taskFile: `${home}/.ssh/id_ed25519` }] },
    { tasks: [{ taskFile: `${ctx.cwd}/secrets/brief.md` }] }, // inside a denied directory
    { agent: "task", taskFile: `${home}/.omp/agent/agent.db` }, // flat
    { taskFile: `${ctx.cwd}/.env`, tasks: [{ task: "x" }] }, // top-level next to tasks[]: checked too
  ]) {
    const r = await fire("tool_call", task(input), ctx)
    assert.equal(r?.block, true, JSON.stringify(input))
    assert.match(r.reason, /^Blocked: taskFile "/, JSON.stringify(input))
    assert.match(r.reason, /opencode\/opencode\.json \(permission\.read\)/, JSON.stringify(input))
  }
  // No agent, so no judge script runs: the verdict is the taskFile check alone. local:// is an internal URL.
  for (const input of [
    { tasks: [{ taskFile: `${ctx.cwd}/src/brief.md` }] },
    { tasks: [{ taskFile: "local://brief.md" }] },
    { tasks: [{ taskFile: `${ctx.cwd}/.env.example` }] }, // a template the bash gate lets through
    { tasks: [{ taskFile: 7 }] }, // not a string: omp rejects it
  ]) {
    assert.equal(await fire("tool_call", task(input), ctx), undefined, JSON.stringify(input))
  }
  assert.deepEqual(calls.warn, [])
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

  // A suffix resolution into a denied file: content withheld, and the notice names the glob, never the file.
  const sr = {
    suffixResolution: { from: "prod", to: "secrets/prod" },
    resolvedPath: `${ctx.cwd}/secrets/prod`,
    displayContent: { text: "FILE CONTENT", startLine: 1 },
    fileSize: 12,
    totalLines: 1,
    raw: false,
    meta: { artifactId: "7" },
  }
  const r = await fire("tool_result", result(sr), ctx)
  assert.equal(r?.isError, true)
  assert.equal(r.content.length, 1)
  assert.equal(r.content[0].type, "text")
  assert.match(r.content[0].text, /withheld/)
  assert.equal(
    r.content[0].text,
    "ecomono: read resolved to a file that **/secrets/** in opencode/opencode.json denies; content withheld.",
  )
  assert.ok(!JSON.stringify(r.content).includes("FILE CONTENT"))
  // details: the counts and flags survive, the content, the paths and the spill link do not. omp persists details in
  // the session file and keeps the original ones when a handler returns none, so they are always replaced.
  assert.deepEqual(r.details, { fileSize: 12, totalLines: 1, raw: false })
  assert.deepEqual((await fire("tool_result", result({ suffixResolution: sr.suffixResolution }), ctx))?.details, {})

  // Delimited parts: one denied target is enough, and none of them is named.
  const dr = await fire("tool_result", result({ displayReadTargets: ["src/a.ts", "config/.env"] }), ctx)
  assert.equal(dr?.isError, true)
  assert.ok(!dr.content[0].text.includes("config/"), dr.content[0].text)
  assert.match(dr.content[0].text, /withheld/)

  // The same helper as the path gate: selectors, tilde and absolute targets count too.
  for (const target of [`${home}/.ssh/id_rsa`, "~/.ssh/id_rsa", ".env:raw", "/x/k.pem"]) {
    const t = await fire("tool_result", result({ displayReadTargets: [target] }), ctx)
    assert.equal(t?.isError, true, target)
  }

  // resolvedPath, the absolute file omp read (a link or an internal URL's backing file), is checked too.
  for (const resolvedPath of [`${home}/.ssh/id_rsa`, `${home}/.omp/agent/agent.db`, `${ctx.cwd}/config/.env`]) {
    const t = await fire("tool_result", result({ resolvedPath }), ctx)
    assert.equal(t?.isError, true, resolvedPath)
    assert.ok(!t.content[0].text.includes(resolvedPath), t.content[0].text)
  }
  assert.equal(await fire("tool_result", result({ resolvedPath: `${ctx.cwd}/src/a.ts` }), ctx), undefined)
  assert.equal(await fire("tool_result", result({ resolvedPath: `${ctx.cwd}/.env.example` }), ctx), undefined)

  // Allowed targets, and shapes that carry none: the result is not touched.
  assert.equal(await fire("tool_result", result({ suffixResolution: { from: "prod", to: "src/prod.ts" } }), ctx), undefined)
  assert.equal(await fire("tool_result", result({ displayReadTargets: ["src/a.ts", "src/b.ts"] }), ctx), undefined)
  assert.equal(await fire("tool_result", result(undefined), ctx), undefined)
  for (const details of [null, "secrets/prod", 3, [], {}, { suffixResolution: null }, { suffixResolution: { to: 5 } }, { displayReadTargets: "secrets/x" }, { displayReadTargets: [1, null, {}] }, { resolvedPath: 7 }]) {
    assert.equal(await fire("tool_result", result(details), ctx), undefined, JSON.stringify(details))
  }

  // Only `read`: another tool's details are not looked at.
  assert.equal(await fire("tool_result", result(sr, { toolName: "lsp" }), ctx), undefined)
  assert.deepEqual(calls.warn, [], "safe() caught nothing: no handler threw")
}

// ---- search post-check --------------------------------------------------------------------------------------

{
  // grep, ast_grep, glob and find list the files a result shows in `details`; a call that names no root (or a parent
  // directory) is not blocked up front, so a listed denied file withholds the result.
  const { fire, calls, ctx } = setup()
  const body = [{ type: "text", text: "LINE CONTENT" }]
  const result = (toolName: string, details: unknown) => ({
    toolName,
    toolCallId: "call-1",
    input: { pattern: "x" },
    content: body,
    details,
    isError: false,
  })
  const files = (...paths: string[]) => ({ files: paths, fileMatches: paths.map((path) => ({ path, count: 1 })) })

  const edited = (...paths: string[]) => ({ files: paths, fileReplacements: paths.map((path) => ({ path, count: 1 })) })
  const denied: Array<[string, unknown, string]> = [
    ["grep", files("src/a.ts", "server.key"), "server.key"],
    ["grep", files("secrets/a.txt"), "secrets/a.txt"],
    ["grep", files(".env"), ".env"],
    ["grep", files(`${home}/.ssh/config`), `${home}/.ssh/config`], // outside the cwd: absolute
    ["grep", files("x.zip:.ssh/k"), "x.zip:.ssh/k"], // an archive member
    ["grep", files(`${home}/.omp/agent/agent.db`), `${home}/.omp/agent/agent.db`],
    ["grep", { files: [], fileMatches: [{ path: "secrets/a.txt", count: 1 }] }, "secrets/a.txt"], // fileMatches alone
    ["grep", { files: ["config/.env"] }, "config/.env"], // files alone
    ["ast_grep", files("src/a.ts", "config/.env"), "config/.env"],
    ["glob", { files: ["src/a.ts", "secrets/"], fileCount: 2 }, "secrets/"], // a directory, trailing slash
    ["glob", { files: ["docs/prod.env"] }, "docs/prod.env"],
    ["find", { hits: [{ rel: "src/a.ts" }, { rel: "secrets/a.txt" }] }, "secrets/a.txt"],
    ["find", { hits: [{ rel: ".env" }] }, ".env"],
    // ast_edit: its result is the staged diff of every file it would touch (a dry run, applied: false).
    ["ast_edit", edited("src/a.ts", "config/.env"), "config/.env"],
    ["ast_edit", { files: [], fileReplacements: [{ path: "secrets/a.ts", count: 2 }], applied: false }, "secrets/a.ts"],
  ]
  // The notice names the glob, never the file: it is the template below with a deny key of the file in the slot.
  // An ast_edit notice also asks for xd://reject, since its preview stays staged in omp (steering only: the apply is
  // the documented write ceiling).
  const notice = (tool: string, glob: string) =>
    `ecomono: ${tool} listed a file that ${glob} in opencode/opencode.json denies; result withheld. Narrow \`path\` or the pattern so the result lists no file that glob matches.` +
    (tool === "ast_edit" ? " Its edits stay staged: write a reason to xd://reject to discard them." : "")
  for (const [tool, details, listed] of denied) {
    const label = `${tool} ${JSON.stringify(details)}`
    const r = await fire("tool_result", result(tool, details), ctx)
    assert.equal(r?.isError, true, label)
    assert.equal(r.content.length, 1, label)
    assert.equal(r.content[0].type, "text", label)
    assert.match(r.content[0].text, /withheld/, label)
    assert.ok(denyKeys.some((k) => r.content[0].text === notice(tool, k)), `${label}: ${r.content[0].text}`)
    assert.ok(!JSON.stringify(r.content).includes("LINE CONTENT"), label)
    assert.ok(!JSON.stringify(r.details).includes(listed), `${label}: details still name ${listed}: ${JSON.stringify(r.details)}`)
  }
  // An error result is checked too: one that still carries `details` is cut like any other.
  const stale = await fire("tool_result", { ...result("ast_edit", edited(".env")), isError: true }, ctx)
  assert.equal(stale?.isError, true)

  // details keep their counts and flags; the lines, the snippets, the diff and the path lists go.
  const grepDetails = {
    ...files("src/a.ts", "secrets/a.txt"),
    matchCount: 3,
    fileCount: 2,
    truncated: false,
    displayContent: "secrets/a.txt\n│*1 LINE CONTENT",
    displayTargets: { "secrets/a.txt": "/abs/secrets/a.txt" },
    cwd: ctx.cwd,
    meta: { artifactId: "3" },
  }
  assert.deepEqual((await fire("tool_result", result("grep", grepDetails), ctx))?.details, { matchCount: 3, fileCount: 2, truncated: false })
  const findDetails = { query: "x", keywords: ["x"], threshold: 0.5, hits: [{ rel: ".env", contentScore: 1, ranges: [{ start: 1, end: 1, p: 1, snippet: "LINE CONTENT" }], linesSeen: 1, truncated: false }], elapsedMs: 4, cwd: ctx.cwd }
  assert.deepEqual((await fire("tool_result", result("find", findDetails), ctx))?.details, { threshold: 0.5, elapsedMs: 4 })
  const editDetails = { ...edited("secrets/a.ts"), totalReplacements: 2, filesTouched: 1, filesSearched: 9, applied: false, limitReached: false, displayContent: "-old\n+LINE CONTENT" }
  assert.deepEqual((await fire("tool_result", result("ast_edit", editDetails), ctx))?.details, { totalReplacements: 2, filesTouched: 1, filesSearched: 9, applied: false, limitReached: false })

  // A tracked `.env` template listed by a repo-wide search does not withhold it: the same templates as read.
  for (const tool of ["grep", "ast_grep", "glob"]) {
    assert.equal(await fire("tool_result", result(tool, files("src/a.ts", ".env.example", "config/.env.sample")), ctx), undefined, tool)
  }

  // Ordinary results, and shapes that carry no path: the result is not touched.
  const allowed: Array<[string, unknown]> = [
    ["grep", files("src/a.ts", "src/b.ts")],
    ["grep", { files: [], fileMatches: [], matchCount: 0 }],
    ["ast_grep", files("src/a.ts")],
    ["glob", { files: ["src/", "src/a.ts"] }],
    ["find", { hits: [{ rel: "src/a.ts" }] }],
    ["grep", files("src/.envrc.ts", "environment.ts", `${home}/.omp/agent/config.yml`)],
    ["grep", undefined],
    ["grep", null],
    ["glob", "secrets/x"],
    ["glob", 3],
    ["grep", []],
    ["grep", {}],
    ["grep", { files: "secrets/x" }], // not an array
    ["grep", { files: [1, null, {}], fileMatches: [null, { path: 5 }, "secrets/x"], hits: [{}, null] }],
    ["find", { hits: "secrets/x" }],
    ["glob", { fileMatches: "secrets/x" }],
  ]
  for (const [tool, details] of allowed) {
    assert.equal(await fire("tool_result", result(tool, details), ctx), undefined, `${tool} ${JSON.stringify(details)}`)
  }

  // Only the search tools: another tool's details are not looked at, `read` keeps its own check.
  for (const tool of ["bash", "lsp", "write", "edit"]) {
    assert.equal(await fire("tool_result", result(tool, files(".env")), ctx), undefined, tool)
  }
  assert.ok(!calls.warn.some((l) => l.includes("handler failed")), "safe() caught nothing: no handler threw")
  // A non-error result with none of the path arrays is a shape omp 18.14.0 never sends: it passes, and drift() says
  // so once per tool. Above, grep (undefined), glob ("secrets/x") and find ({ hits: "secrets/x" }) were such results.
  const drifted = calls.warn.filter((l) => l.includes("unexpected omp shape"))
  assert.deepEqual(drifted.map((l) => /shape, (\w+ tool_result)/.exec(l)?.[1]), ["grep tool_result", "glob tool_result", "find tool_result"])
  assert.equal(calls.warn.length, drifted.length, calls.warn.join("\n"))

  // An error result carries no arrays (omp throws, details absent): no drift. A well-formed one stays silent too.
  const quiet = setup()
  await quiet.fire("tool_result", { ...result("grep", undefined), isError: true }, quiet.ctx)
  await quiet.fire("tool_result", result("grep", { files: [], matchCount: 0 }), quiet.ctx)
  await quiet.fire("tool_result", result("ast_edit", { files: [], fileReplacements: [], applied: false }), quiet.ctx)
  assert.deepEqual(quiet.calls.warn, [])
}

// ---- the result of xd://resolve and xd://reject --------------------------------------------------------------

{
  // ast_edit only stages its edits; a write to xd://resolve applies the newest staged preview and a write to
  // xd://reject discards it. The apply is the documented write ceiling, so neither write is refused, a withheld
  // preview's included. What the model would see is withheld instead: the write result carries the source tool's own
  // apply or reject result under details.xdev.inner.sourceResultDetails (tools/resolve.ts runResolveInvocation), and
  // one that lists a denied file is cut like a search result.
  const { fire, calls, ctx } = setup()
  const write = (tool: string) => ({ toolName: "write", toolCallId: "call-1", input: { path: `xd://${tool}`, content: "reason" } })
  const preview = (...paths: string[]) => ({
    toolName: "ast_edit",
    toolCallId: "call-0",
    input: { ops: [] },
    content: [{ type: "text", text: "DIFF" }],
    details: { files: paths, fileReplacements: paths.map((path) => ({ path, count: 1 })), applied: false },
    isError: false,
  })
  const settled = (tool: string, inner: unknown, text = "done") => ({
    ...write(tool),
    content: [{ type: "text", text }],
    details: { xdev: { tool, mode: "execute", args: { reason: "reason" }, inner } },
    isError: false,
  })
  const sourced = (tool: string, action: string, ...paths: string[]) =>
    settled(
      tool,
      {
        action,
        reason: "reason",
        sourceToolName: "ast_edit",
        label: "AST Edit: 1 replacement in 1 file",
        sourceResultDetails: { files: paths, fileReplacements: paths.map((path) => ({ path, count: 1 })), totalReplacements: 1, applied: action === "apply" },
      },
      paths.map((p) => `[${p}#AB12]`).join("\n") + "\nLINE CONTENT",
    )

  // Not a gate: xd://resolve and xd://reject pass, before and after a withheld preview.
  for (const tool of ["resolve", "reject"]) assert.equal(await fire("tool_call", write(tool), ctx), undefined, tool)
  assert.equal((await fire("tool_result", preview("src/a.ts", "secrets/a.ts"), ctx))?.isError, true)
  for (const tool of ["resolve", "reject"]) assert.equal(await fire("tool_call", write(tool), ctx), undefined, `${tool} after a withheld preview`)

  // A settled preview that lists a denied file: withheld, the notice names the glob and never the file, and details
  // keep only their number and boolean fields (xdev is an object, so none are left).
  for (const [tool, action] of [["resolve", "apply"], ["reject", "discard"]]) {
    for (const r of [await fire("tool_result", sourced(tool, action, "src/a.ts", "secrets/a.ts"), ctx), await fire("tool_result", { ...sourced(tool, action, ".env"), isError: true }, ctx)]) {
      assert.equal(r?.isError, true, tool)
      assert.equal(r.content.length, 1, tool)
      assert.ok(
        denyKeys.some((k) => r.content[0].text === `ecomono: xd://${tool} listed a file that ${k} in opencode/opencode.json denies; result withheld. Its staged edits may already be written to that file.`),
        r.content[0].text,
      )
      assert.deepEqual(r.details, {}, tool)
      // `.env` as the listed path, quoted or in its header: the `*.env` glob in the notice is not a leak.
      for (const leak of ["secrets/a.ts", '".env"', "[.env#", "LINE CONTENT"]) assert.ok(!JSON.stringify(r).includes(leak), `${tool}: ${leak} in ${JSON.stringify(r)}`)
    }
  }

  // Not touched: an ordinary apply, a reject with nothing pending (no sourceResultDetails), a write to a file, a
  // write result with no details.
  const untouched = [
    sourced("resolve", "apply", "src/a.ts"),
    settled("reject", { action: "discard", reason: "reason" }),
    { ...write("x"), input: { path: "src/b.ts", content: "x" }, content: [{ type: "text", text: "ok" }], details: { files: [".env"] }, isError: false },
    { ...write("resolve"), content: [{ type: "text", text: "ok" }], details: undefined, isError: false },
  ]
  for (const event of untouched) assert.equal(await fire("tool_result", event, ctx), undefined, JSON.stringify(event))
  assert.deepEqual(calls.warn, [])
}

console.log("test_paths: all assertions passed")
