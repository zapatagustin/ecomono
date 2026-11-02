// The three tabs of the omp side panel against real files: a temp git repo for files and log, fixture todo files
// for todo. The Host is a fake that runs git for real (spawnSync) and records editor opens and notices. Plain
// assert script; the extension's registration of /panel, /org-todo, alt+t and alt+g is pinned at the end.
import { dir, makeCtx, makePi, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as core from "../../opencode/tui-plugins/org-todo/core.ts"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"
import { startOrgTodo, todoTab } from "../extensions/ecomono/org-todo.ts"
import { filesTab } from "../extensions/ecomono/panel/files.ts"
import { logTab } from "../extensions/ecomono/panel/log.ts"
import type { Host, Tab } from "../extensions/ecomono/panel/model.ts"

/** A host over `cwd`: git runs for real, the editor and the notices are recorded. */
const makeHost = (cwd: string) => {
  const opened: Array<[string, number]> = []
  const notices: string[] = []
  const host: Host & { opened: typeof opened; notices: typeof notices } = {
    cwd,
    exec: async (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { cwd: opts?.cwd ?? cwd, encoding: "utf8" })
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 }
    },
    openEditor: async (file, line) => void opened.push([file, line]),
    notify: (text) => void notices.push(text),
    opened,
    notices,
  }
  return host
}
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout
}
/** A repo with two commits on master, a feature branch one commit ahead, and a working tree with every group. */
const repo = (): string => {
  const cwd = dir("repo")
  git(cwd, "init", "-q", "-b", "master")
  writeFileSync(join(cwd, "a.ts"), "one\ntwo\n")
  writeFileSync(join(cwd, "b.md"), "# b\n")
  git(cwd, "add", ".")
  git(cwd, "commit", "-qm", "first")
  writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree\n")
  git(cwd, "commit", "-qam", "second")
  git(cwd, "switch", "-qc", "feature/x")
  writeFileSync(join(cwd, "c.ts"), "c\n")
  git(cwd, "add", "c.ts")
  git(cwd, "commit", "-qm", "feature commit")
  git(cwd, "switch", "-q", "master")
  return cwd
}
const texts = (tab: Tab, filter = "") => tab.rows(filter).map((r) => (r.kind === "head" ? `# ${r.text} ${r.right ?? ""}`.trim() : `${r.text}${r.right ? ` ${r.right}` : ""}`))

// ---- files: rows from a fixture repo, s stages and unstages, enter opens the editor ----------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree\nfour\n") // unstaged M
  writeFileSync(join(cwd, "b.md"), "# b\nmore\n")
  git(cwd, "add", "b.md") // staged M
  mkdirSync(join(cwd, "dir with space"))
  writeFileSync(join(cwd, "dir with space", "new.ts"), "")
  const host = makeHost(cwd)
  const tab = filesTab(host)
  await tab.load()
  assert.equal(tab.title(), "files 3")
  // A wholly untracked directory is listed per file (--untracked-files=all), so enter and s act on one file.
  assert.deepEqual(texts(tab), ["# staged 1", "M b.md +1 -0", "# unstaged 1", "M a.ts +1 -0", "# untracked 1", "? dir with space/new.ts"])
  const staged = tab.rows("")[1]!
  assert.equal(staged.color, "accent")
  assert.deepEqual(tab.detail(staged.id!), [], "the detail is empty until prefetched")
  await tab.prefetch!(staged.id!)
  assert.deepEqual(tab.detail(staged.id!), ["@@ -1 +1,2 @@", " # b", "+more"])
  assert.deepEqual(texts(tab, "A.TS"), ["# unstaged 1", "M a.ts +1 -0"], "the filter is case-insensitive on the path")

  // s on an unstaged row stages it; on a staged row unstages it; on an untracked row adds it.
  assert.deepEqual(await tab.act("s", tab.rows("")[3]!.id!), { kind: "refresh" })
  await tab.load()
  assert.deepEqual(texts(tab).slice(0, 3), ["# staged 2", "M a.ts +1 -0", "M b.md +1 -0"])
  assert.deepEqual(await tab.act("s", tab.rows("")[2]!.id!), { kind: "refresh" })
  await tab.load()
  assert.deepEqual(texts(tab), ["# staged 1", "M a.ts +1 -0", "# unstaged 1", "M b.md +1 -0", "# untracked 1", "? dir with space/new.ts"])
  assert.deepEqual(await tab.act("s", tab.rows("")[5]!.id!), { kind: "refresh" })
  await tab.load()
  assert.deepEqual(texts(tab)[0], "# staged 2")
  assert.ok(texts(tab).includes("A dir with space/new.ts +0 -0"), texts(tab).join("\n"))

  // enter opens the file; d opens it at the first changed line of its hunk.
  assert.deepEqual(await tab.act("enter", tab.rows("")[1]!.id!), { kind: "close" })
  assert.deepEqual(host.opened.at(-1), [join(cwd, "a.ts"), 1])
  assert.deepEqual(await tab.act("d", tab.rows("")[1]!.id!), { kind: "close" })
  assert.deepEqual(host.opened.at(-1), [join(cwd, "a.ts"), 2], "d fetches the diff itself when it was not prefetched")

  // A git failure is a notice with git's reason.
  const bad = filesTab(makeHost(dir("not-a-repo")))
  await assert.rejects(bad.load(), /git rev-parse: fatal/)
}

// ---- files from a subdirectory: git's paths are repo-root relative, so the tab runs at the root ---------------------

{
  const cwd = realpathSync(repo())
  mkdirSync(join(cwd, "dir with space"))
  writeFileSync(join(cwd, "dir with space", "in.md"), "x\n")
  writeFileSync(join(cwd, "café.md"), "c\n")
  writeFileSync(join(cwd, "g*.ts"), "glob\n")
  git(cwd, "add", "dir with space/in.md")
  git(cwd, "commit", "-qm", "in")
  writeFileSync(join(cwd, "dir with space", "in.md"), "x\ny\n")
  const host = makeHost(join(cwd, "dir with space"))
  const tab = filesTab(host)
  await tab.load()
  // Paths are the root's, not the subdirectory's; a non-ASCII name arrives unquoted.
  assert.deepEqual(texts(tab), ["# unstaged 1", "M dir with space/in.md +1 -0", "# untracked 2", "? café.md", "? g*.ts"])
  const unstaged = tab.rows("")[1]!.id!
  await tab.prefetch!(unstaged)
  assert.deepEqual(tab.detail(unstaged), ["@@ -1 +1,2 @@", " x", "+y"])
  assert.deepEqual(await tab.act("enter", unstaged), { kind: "close" })
  assert.deepEqual(host.opened.at(-1), [join(cwd, "dir with space", "in.md"), 1])
  assert.deepEqual(await tab.act("d", unstaged), { kind: "close" })
  assert.deepEqual(host.opened.at(-1), [join(cwd, "dir with space", "in.md"), 1], "the hunk starts at line 1")
  assert.deepEqual(await tab.act("s", unstaged), { kind: "refresh" })
  // Pathspecs are literal: staging the file named `g*.ts` does not take a glob's other matches.
  writeFileSync(join(cwd, "gx.ts"), "other\n")
  await tab.load()
  const glob = tab.rows("").find((r) => r.text === "? g*.ts")!
  assert.deepEqual(await tab.act("s", glob.id!), { kind: "refresh" })
  assert.equal(git(cwd, "diff", "--cached", "--name-only").trim().split("\n").sort().join(), "dir with space/in.md,g*.ts")
  await tab.load()
  assert.deepEqual(texts(tab), ["# staged 2", "M dir with space/in.md +1 -0", "A g*.ts +1 -0", "# untracked 2", "? café.md", "? gx.ts"])
  // The log tab opens a commit's file from the same subdirectory.
  const log = logTab(host)
  await log.load()
  const row = log.rows("").find((r) => r.text.endsWith("in"))!
  assert.deepEqual(await log.act("d", row.id!), { kind: "close" })
  assert.deepEqual(host.opened.at(-1), [join(cwd, "dir with space", "in.md"), 1])
}

// ---- files: a removed `-- ` line is diff content, not a file header ------------------------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "q.lua"), "-- keep\nx = 1\n")
  git(cwd, "add", "q.lua")
  git(cwd, "commit", "-qm", "lua")
  writeFileSync(join(cwd, "q.lua"), "x = 1\n++ y\n")
  const tab = filesTab(makeHost(cwd))
  await tab.load()
  const row = tab.rows("").find((r) => r.text.includes("q.lua"))!
  await tab.prefetch!(row.id!)
  const detail = tab.detail(row.id!)
  assert.ok(detail[0]!.startsWith("@@"), detail.join("\n"))
  assert.ok(detail.includes("--- keep"), detail.join("\n"))
  assert.ok(detail.includes("+++ y"), detail.join("\n"))
}

// ---- log: chips, enter switches a clean tree, refuses a conflicting dirty tree with git's message ------------

{
  const cwd = repo()
  const host = makeHost(cwd)
  const tab = logTab(host)
  await tab.load()
  // feature/x is one commit past master on the same lane, so the graph is three ● rows and no join line.
  const rows = texts(tab)
  assert.equal(rows.length, 3, rows.join("\n"))
  assert.ok(/^● .{7} \[feature\/x\] feature commit$/.test(rows[0]!), rows[0])
  assert.ok(/^● .{7} \[master\] second$/.test(rows[1]!), "HEAD's row is marked by color, not text")
  assert.equal(tab.rows("")[1]!.color, "accent")
  assert.equal(tab.rows("")[0]!.color, undefined)
  assert.ok(rows[2]!.endsWith("first"))
  assert.deepEqual(texts(tab, "FEAT").length, 1, "the filter matches subjects and chips")

  // The detail arrives through prefetch: subject, author · age, then the stat.
  const sha = tab.rows("")[0]!.id!
  assert.deepEqual(tab.detail(sha), [])
  await tab.prefetch!(sha)
  assert.equal(tab.detail(sha)[0], "feature commit")
  assert.ok(tab.detail(sha)[1]!.startsWith("t · "), tab.detail(sha)[1])
  assert.ok(tab.detail(sha).some((l) => l.includes("c.ts")))

  // enter on the feature row switches a clean tree.
  assert.deepEqual(await tab.act("enter", sha), { kind: "refresh" })
  assert.equal(git(cwd, "branch", "--show-current").trim(), "feature/x")
  // A conflicting dirty tree is refused with git's reason; the branch stays. `other` changes a.ts, and a dirty
  // a.ts on feature/x conflicts with it.
  git(cwd, "switch", "-qc", "other")
  writeFileSync(join(cwd, "a.ts"), "other\n")
  git(cwd, "commit", "-qam", "other change")
  git(cwd, "switch", "-q", "feature/x")
  writeFileSync(join(cwd, "a.ts"), "dirty\n")
  await tab.load()
  const other = tab.rows("").find((r) => r.text.includes("[other]"))!
  const refused = await tab.act("enter", other.id!)
  assert.equal(refused.kind, "notice")
  assert.ok((refused as any).text.startsWith("git: error:") || (refused as any).text.includes("would be overwritten"), (refused as any).text)
  assert.equal(git(cwd, "branch", "--show-current").trim(), "feature/x")
  // enter on a plain commit opens its first changed file; a toggles --all.
  const plain = tab.rows("").find((r) => r.kind === "item" && !r.text.includes("["))!
  assert.deepEqual(await tab.act("enter", plain.id!), { kind: "close" })
  assert.equal(host.opened.at(-1)![0], join(cwd, "a.ts"))
  assert.deepEqual(await tab.act("a", plain.id!), { kind: "refresh" })
  assert.equal(tab.title(), "log ·")
  await tab.load()
  assert.ok(!texts(tab).some((l) => l.includes("[other]")), "without --all only the current branch shows")
}

// ---- log: enter on a commit with no branch (a tag, a detached HEAD) opens the editor, it does not switch -------

{
  const cwd = repo()
  git(cwd, "tag", "v1", "HEAD~1")
  git(cwd, "switch", "-q", "--detach", "v1")
  const host = makeHost(cwd)
  const tab = logTab(host)
  await tab.load()
  const row = tab.rows("").find((r) => r.text.includes("[HEAD]") && r.text.includes("[v1]"))!
  assert.ok(row, texts(tab).join("\n"))
  assert.deepEqual(await tab.act("enter", row.id!), { kind: "close" }, "a bare HEAD and a tag name no branch")
  assert.equal(host.opened.at(-1)![0], join(cwd, "a.ts"))
  assert.equal(git(cwd, "branch", "--show-current").trim(), "", "still detached: nothing was switched")
}

// ---- todo: enter flips, e opens ------------------------------------------------------------------------------

{
  // A main TUI session over <cwd>/docs and a symlinked org directory, with the real grep.
  const cwd = dir("project")
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  const realOrg = dir("real-org")
  const org = join(dir("links"), "org")
  symlinkSync(realOrg, org)
  writeFileSync(join(docs, "a.md"), "# t\n- [ ] one\n- [ ] two")
  writeFileSync(join(realOrg, "b.org"), "* TODO three\r\n* DONE x\r\n")
  let greps = 0
  await withEnv({ ECOMONO_ORG_DIR: org }, async () => {
    const { pi } = makePi({
      exec: (command, args) => {
        greps++
        const r = spawnSync(command, args, { encoding: "utf8" })
        return { stdout: r.stdout, stderr: r.stderr, code: r.status, killed: false }
      },
    })
    const ctx = makeCtx({ cwd, mode: "tui", hasUI: true })
    const handle = startOrgTodo(pi, ctx, core)
    await tick()
    const host = makeHost(cwd)
    const tab = todoTab(core, handle, host)
    assert.equal(tab.title(), "todo 3")
    const rows = texts(tab)
    assert.deepEqual(rows.slice(0, 3), ["# a.md 2", "○ one :2", "○ two :3"])
    assert.equal(rows[3], "# b.org 1")
    assert.deepEqual(tab.detail(tab.rows("")[1]!.id!), [join(docs, "a.md"), "- [ ] one"])

    // enter flips the line in place (no trailing newline kept, CRLF kept, symlink written through).
    // A flip does not rescan in act: the panel's `refresh` action runs load(), which does.
    let scans = greps
    assert.deepEqual(await tab.act("enter", tab.rows("")[1]!.id!), { kind: "refresh" })
    assert.equal(greps, scans, "act does not rescan after a flip")
    assert.equal(readFileSync(join(docs, "a.md"), "utf8"), "# t\n- [x] one\n- [ ] two")
    await tab.load()
    assert.ok(greps > scans, "load rescans")
    assert.equal(tab.title(), "todo 2")
    assert.deepEqual(await tab.act("enter", tab.rows("")[3]!.id!), { kind: "refresh" })
    await tab.load()
    assert.equal(readFileSync(join(realOrg, "b.org"), "utf8"), "* DONE three\r\n* DONE x\r\n")
    assert.ok(lstatSync(org).isSymbolicLink())
    // The file changed since the scan: refused, with a notice, and the panel reloads.
    const id = tab.rows("")[1]!.id!
    writeFileSync(join(docs, "a.md"), "# t\n- [x] one\n- [ ] two, edited")
    scans = greps
    const refused = await tab.act("enter", id)
    assert.equal(greps, scans, "act does not rescan: the refresh action's load() does")
    assert.equal(refused.kind, "refresh")
    assert.ok((refused as any).notice.includes("changed on disk"))
    await tab.load() // what the panel does after the notice
    assert.ok(greps > scans, "load rescans")
    assert.equal(tab.rows("")[1]!.text, "○ two, edited", "the rows are the file as it is now")
    assert.equal(readFileSync(join(docs, "a.md"), "utf8"), "# t\n- [x] one\n- [ ] two, edited")
    // e opens the editor at the todo's line and closes.
    assert.deepEqual(await tab.act("e", tab.rows("")[1]!.id!), { kind: "close" })
    assert.deepEqual(host.opened.at(-1), [join(docs, "a.md"), 3])
    assert.deepEqual(ctx.recorded.setStatus.at(-1), ["org-todo", "todo 1"])
  })
}

// ---- /panel, /org-todo, alt+t and alt+g are registered at load; without a session they say why -------------

{
  const { pi, calls } = makePi()
  ecomono({ repo: REPO })(pi)
  assert.deepEqual(calls.commands.map(([name]) => name), ["panel", "org-todo"])
  assert.deepEqual(calls.shortcuts.map(([key]) => key), ["alt+t", "alt+g"])
  const ctx = makeCtx({ mode: "tui", hasUI: true })
  await calls.commands[0]![1].handler("files", ctx)
  await calls.shortcuts[1]![1].handler(ctx)
  assert.equal(ctx.recorded.custom.length, 0)
  assert.equal(ctx.recorded.notify.filter(([t]: [string]) => t.includes("main TUI session only")).length, 2)
}

console.log("test_panel_tabs: all assertions passed")
