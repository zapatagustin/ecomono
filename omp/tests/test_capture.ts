// Prompt capture of the omp extension, driven through fake-pi. Plain assert script. fake-pi.ts, imported
// first, has already pointed ECOMONO_DATA_DIR and ECOMONO_LEGACY_DB at temp paths before any storage module loads, so
// the DB written here is a throwaway and the legacy engram DB is never attached.
import { ISOLATED, makeCtx, makePi } from "./fake-pi.ts"
import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"

const DB_FILE = join(process.env.ECOMONO_DATA_DIR!, "memory.db")
const LEGACY = process.env.ECOMONO_LEGACY_DB!

const setup = (repo = REPO) => {
  const { pi, fire, calls } = makePi()
  ecomono({ repo })(pi)
  return { fire, calls }
}
// A cwd outside any git checkout, so the project key is its basename.
const cwd = join(ISOLATED, "capture-proj")
mkdirSync(cwd, { recursive: true })
const as = (sid: string, over: Record<string, any> = {}) => makeCtx({ cwd, sessionManager: { getSessionId: () => sid }, ...over })

/** Rows through a handle of the test's own, so what is read is what reached the file. */
const rows = (sql: string, ...args: string[]): any[] => {
  const db = new Database(DB_FILE, { readonly: true })
  try {
    return db.query(sql).all(...args) as any[]
  } finally {
    db.close()
  }
}
const prompts = () => rows("SELECT session_id, content FROM prompts ORDER BY id")

assert.ok(!existsSync(LEGACY), "the legacy DB path must not exist before the test")

{
  // A main-session prompt is stored trimmed, under its session, in the project the cwd names.
  const { fire, calls } = setup()
  await fire("before_agent_start", { reason: "prompt", prompt: "  hello  " }, as("sess-1"))
  assert.deepEqual(prompts(), [{ session_id: "sess-1", content: "hello" }])
  assert.deepEqual(rows("SELECT project_id FROM sessions WHERE id = ?", "sess-1"), [{ project_id: "capture-proj" }])
  assert.deepEqual(calls.warn, [])

  // A second prompt of the same session adds a row and keeps the one session row.
  await fire("before_agent_start", { reason: "prompt", prompt: "again" }, as("sess-1"))
  assert.deepEqual(prompts().map((r) => r.content), ["hello", "again"])
  assert.equal(rows("SELECT id FROM sessions WHERE id = ?", "sess-1").length, 1)

  // Nothing else is stored: a revive replays no prompt, a subagent's text is not the user's, a blank prompt is no
  // prompt, and a malformed event is ignored. None of them creates a session row either.
  await fire("before_agent_start", { reason: "revive", prompt: "hello revived" }, as("sess-revive"))
  await fire("before_agent_start", { reason: "prompt", prompt: "delegated" }, as("sess-sub", { agent: { kind: "sub", id: "0-Explore", name: "ecomono-explore" } }))
  await fire("before_agent_start", { reason: "prompt", prompt: " \n\t " }, as("sess-empty"))
  await fire("before_agent_start", { reason: "prompt", prompt: "" }, as("sess-empty"))
  await fire("before_agent_start", { reason: "prompt" }, as("sess-nopr"))
  assert.deepEqual(prompts().map((r) => r.session_id), ["sess-1", "sess-1"])
  assert.deepEqual(rows("SELECT id FROM sessions ORDER BY id"), [{ id: "sess-1" }])
  assert.deepEqual(calls.warn, [])

  // session_shutdown closes the handle the capture opened: db.ts caches one per process, and the same resolved path
  // gives the test that very module instance. A closed handle throws on the next statement.
  const { getDb } = await import(join(REPO, "opencode/plugins/storage/db.ts"))
  const handle = getDb()
  assert.equal(handle.query("SELECT 1 AS one").get().one, 1)
  const r = await fire("session_shutdown", {}, as("sess-1"))
  assert.equal(r, undefined)
  assert.throws(() => handle.query("SELECT 1 AS one").get(), /closed/i, "session_shutdown left the DB handle open")
  assert.deepEqual(calls.warn, [])
  assert.deepEqual(calls.failures, [])

  // The extension reopens it for the next prompt, so a shutdown never strands a later session of the process.
  await fire("before_agent_start", { reason: "prompt", prompt: "after close" }, as("sess-2"))
  assert.deepEqual(prompts().map((r) => r.content), ["hello", "again", "after close"])
  await fire("session_shutdown", {}, as("sess-2"))
}

{
  // A shutdown before any capture has nothing to close and loads nothing. The repo has no db.ts, so a shutdown that
  // tried to import it would fail into safe() and leave a warning.
  const { fire, calls } = setup(mkdtempSync(join(ISOLATED, "no-storage-")))
  assert.equal(await fire("session_shutdown", {}, as("sess-never")), undefined)
  assert.deepEqual(calls.warn, [])
  assert.deepEqual(calls.failures, [])
}

{
  // Storage that cannot load costs the capture and nothing else: one warning for the session, no throw, no
  // second attempt, and the shutdown has nothing to close. The registry refresh of the same event still runs.
  const before = prompts()
  const empty = mkdtempSync(join(ISOLATED, "no-storage-"))
  const { fire, calls } = setup(empty)
  const ctx = as("sess-x")
  for (const prompt of ["one", "two"]) await fire("before_agent_start", { reason: "prompt", prompt }, ctx)
  assert.equal(await fire("session_shutdown", {}, ctx), undefined)
  assert.equal(calls.warn.filter((l) => l.includes("prompt capture failed")).length, 1, calls.warn.join("\n"))
  assert.equal(calls.warn.filter((l) => l.includes("handler failed")).length, 0, "a storage failure must not reach safe()")
  assert.deepEqual(calls.failures, [])
  assert.equal(calls.exec.length, 2, "the skill registry refresh must run whatever the capture does")
  assert.deepEqual(prompts(), before)

  // The failed load is cached: the modules becoming loadable afterwards does not bring the capture back.
  mkdirSync(join(empty, "opencode/plugins"), { recursive: true })
  symlinkSync(join(REPO, "opencode/plugins/storage"), join(empty, "opencode/plugins/storage"))
  await fire("before_agent_start", { reason: "prompt", prompt: "three" }, ctx)
  assert.deepEqual(prompts(), before, "a failed load was attempted again")
  assert.equal(calls.warn.filter((l) => l.includes("prompt capture failed")).length, 1)
}

{
  // A fault after the storage loaded (here a trigger that aborts the insert) is the same: one warning however many
  // prompts hit it, it never reaches safe(), the registry refresh still runs, and a later prompt is attempted again.
  const before = prompts()
  const { fire, calls } = setup()
  const ctx = as("sess-fault")
  const own = new Database(DB_FILE)
  own.run("CREATE TRIGGER capture_fault BEFORE INSERT ON prompts BEGIN SELECT RAISE(ABORT, 'injected fault'); END")
  try {
    for (const prompt of ["one", "two"]) await fire("before_agent_start", { reason: "prompt", prompt }, ctx)
    assert.equal(calls.warn.filter((l) => l.includes("prompt capture failed")).length, 1, calls.warn.join("\n"))
    assert.ok(calls.warn.some((l) => l.includes("injected fault")), calls.warn.join("\n"))
    assert.equal(calls.warn.filter((l) => l.includes("handler failed")).length, 0, "a capture fault must not reach safe()")
    assert.deepEqual(calls.failures, [])
    assert.equal(calls.exec.length, 2, "the skill registry refresh must run whatever the capture does")
    assert.deepEqual(prompts(), before)
  } finally {
    own.run("DROP TRIGGER capture_fault")
    own.close()
  }
  await fire("before_agent_start", { reason: "prompt", prompt: "recovered" }, ctx)
  assert.deepEqual(prompts(), [...before, { session_id: "sess-fault", content: "recovered" }])
  assert.equal(calls.warn.filter((l) => l.includes("prompt capture failed")).length, 1, "a second fault warned again")
  await fire("session_shutdown", {}, ctx)
}

{
  // The project key is read once per cwd (it costs two synchronous git calls): a remote renamed mid-session does not
  // move the next prompt, while a new session of the process sees the new name.
  const dir = mkdtempSync(join(ISOLATED, "git-proj-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  git("remote", "add", "origin", "https://example.invalid/acme/first.git")
  const at = (sid: string) => makeCtx({ cwd: dir, sessionManager: { getSessionId: () => sid } })
  const one = setup()
  await one.fire("before_agent_start", { reason: "prompt", prompt: "p1" }, at("sess-p1"))
  git("remote", "set-url", "origin", "https://example.invalid/acme/second.git")
  await one.fire("before_agent_start", { reason: "prompt", prompt: "p2" }, at("sess-p2"))
  await setup().fire("before_agent_start", { reason: "prompt", prompt: "p3" }, at("sess-p3"))
  assert.deepEqual(rows("SELECT id, project_id FROM sessions WHERE id LIKE 'sess-p_' ORDER BY id"), [
    { id: "sess-p1", project_id: "first" },
    { id: "sess-p2", project_id: "first" },
    { id: "sess-p3", project_id: "second" },
  ])
  await one.fire("session_shutdown", {}, at("sess-p1"))
}

// Whatever the run did, it never created the legacy DB path (the migration would have attached it).
assert.ok(!existsSync(LEGACY), "the legacy DB path exists after the run")

console.log("test_capture: all assertions passed")
