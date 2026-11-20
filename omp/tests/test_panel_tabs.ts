// The three tabs of the omp side panel against real files: a temp git repo for files and log, fixture todo files
// for todo. The Host is a fake that runs git for real (spawnSync) and records editor opens and notices. Plain
// assert script; the extension's registration of /panel, /org-todo, alt+e and alt+w is pinned at the end.
import { dir, makeCtx, makePi, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
/** A hang in the code under test fails the run instead of freezing it. */
const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms))])
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

// ---- files: a diff without hunks says what it is; an untracked file shows its first lines --------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]))
  git(cwd, "add", "bin.dat")
  git(cwd, "commit", "-qm", "binary")
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 9, 9, 0, 255, 0])) // unstaged, binary
  chmodSync(join(cwd, "b.md"), 0o755) // unstaged, mode only
  git(cwd, "mv", "a.ts", "renamed.ts") // staged, pure rename
  writeFileSync(join(cwd, "n.txt"), Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n") // untracked
  const tab = filesTab(makeHost(cwd))
  await tab.load()
  const detail = async (needle: string): Promise<string[]> => {
    const row = tab.rows("").find((r) => r.kind === "item" && r.text.includes(needle))!
    assert.ok(row, texts(tab).join("\n"))
    await tab.prefetch!(row.id!)
    return tab.detail(row.id!)
  }
  assert.deepEqual(await detail("bin.dat"), ["binary file"], "a binary diff has no hunk: say so")
  assert.deepEqual(await detail("b.md"), ["mode change 100644 → 100755"])
  assert.deepEqual(await detail("renamed.ts"), ["renamed from a.ts"], "a pure rename is diffed with its old path too")
  assert.deepEqual(await detail("n.txt"), ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"], "an untracked file has no diff: its first lines")
}

// ---- files: unstaging a staged rename unstages the old path too --------------------------------------------------

{
  const cwd = repo()
  git(cwd, "mv", "a.ts", "renamed.ts")
  const inner = makeHost(cwd)
  const argvs: string[][] = []
  const host = { ...inner, exec: (cmd: string, args: string[], opts?: any) => (argvs.push(args), inner.exec(cmd, args, opts)) }
  const tab = filesTab(host)
  await tab.load()
  const row = tab.rows("").find((r) => r.kind === "item" && r.text.includes("renamed.ts"))!
  assert.deepEqual(await tab.act("s", row.id!), { kind: "refresh" })
  assert.equal(argvs.filter((a) => a.includes("restore")).length, 1, "one git call for both paths")
  assert.equal(git(cwd, "status", "--porcelain"), " D a.ts\n?? renamed.ts\n", "the old path's deletion is no longer staged")
}

// ---- files: a directory with more than 20 untracked files is one row, and s adds the directory ---------------------

{
  const cwd = repo()
  for (const [d, n] of [["build/out", 25], ["twenty", 20], ["few", 3]] as const) {
    mkdirSync(join(cwd, d), { recursive: true })
    for (let i = 0; i < n; i++) writeFileSync(join(cwd, d, `f${String(i).padStart(2, "0")}.js`), "x\n")
  }
  const tab = filesTab(makeHost(cwd))
  await tab.load()
  const rows = texts(tab)
  assert.ok(rows.includes("? build/out/ 25 files"), rows.join("\n"))
  assert.equal(rows.filter((r) => r.startsWith("? build/out/f")).length, 0, "no row per file of the big directory")
  assert.equal(rows.filter((r) => r.startsWith("? twenty/f")).length, 20, "20 files stay listed one by one")
  assert.equal(rows.filter((r) => r.startsWith("? few/f")).length, 3)
  const dirRow = tab.rows("").find((r) => r.text.startsWith("? build/out/"))!
  assert.deepEqual(await tab.act("s", dirRow.id!), { kind: "refresh" })
  assert.equal(git(cwd, "status", "--porcelain", "--untracked-files=all", "--", "build").split("\n").filter((l) => l.startsWith("A  ")).length, 25, "the directory was added")
}

// ---- files: a collapsed row stages only the untracked files it stands for -----------------------------------------

{
  const cwd = repo()
  mkdirSync(join(cwd, "build"))
  writeFileSync(join(cwd, "build", "tracked.js"), "t\n")
  writeFileSync(join(cwd, "build", "gone.js"), "g\n")
  git(cwd, "add", "build")
  git(cwd, "commit", "-qm", "build")
  writeFileSync(join(cwd, "build", "tracked.js"), "t\nmore\n")
  rmSync(join(cwd, "build", "gone.js"))
  for (let i = 0; i < 25; i++) writeFileSync(join(cwd, "build", `f${String(i).padStart(2, "0")}.js`), "x\n")
  mkdirSync(join(cwd, "nested"))
  git(join(cwd, "nested"), "init", "-q")
  const tab = filesTab(makeHost(cwd))
  await tab.load()
  const dirRow = tab.rows("").find((r) => r.text.startsWith("? build/"))!
  await tab.prefetch!(dirRow.id!)
  assert.deepEqual(tab.detail(dirRow.id!), ["25 untracked files"])
  assert.deepEqual(await tab.act("s", dirRow.id!), { kind: "refresh" })
  const status = git(cwd, "status", "--porcelain", "--untracked-files=all", "--", "build").split("\n")
  assert.equal(status.filter((l) => l.startsWith("A  ")).length, 25, "the 25 untracked files were added")
  assert.ok(status.includes(" M build/tracked.js") && status.includes(" D build/gone.js"), `tracked changes stay unstaged: ${status.join("|")}`)
  // A path git reports with a trailing slash (a nested repository) is an ordinary row, not a collapsed one.
  await tab.load()
  const nested = tab.rows("").find((r) => r.text === "? nested/")!
  assert.ok(nested, texts(tab).join("\n"))
  await tab.prefetch!(nested.id!)
  assert.deepEqual(tab.detail(nested.id!), ["directory or nested repository"])
  // While a filter is active nothing is collapsed.
  const dir2 = repo()
  mkdirSync(join(dir2, "out"))
  for (let i = 0; i < 25; i++) writeFileSync(join(dir2, "out", `f${String(i).padStart(2, "0")}.js`), "x\n")
  const tab2 = filesTab(makeHost(dir2))
  await tab2.load()
  const filtered = texts(tab2, "f0")
  assert.equal(filtered.filter((r) => r.startsWith("? out/f0")).length, 10, filtered.join("\n"))
  assert.ok(!filtered.some((r) => r.startsWith("? out/ ")), "no folded row in a filtered view")
}

// ---- files: the detail of an untracked path that is not a regular file ---------------------------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "target.txt"), "secret\n")
  symlinkSync("target.txt", join(cwd, "link"))
  mkdirSync(join(cwd, "sub"))
  symlinkSync("sub", join(cwd, "dirlink"))
  assert.equal(spawnSync("mkfifo", [join(cwd, "pipe")]).status, 0)
  const tab = filesTab(makeHost(cwd))
  await tab.load()
  for (const name of ["link", "dirlink", "pipe"]) {
    // git does not list a FIFO, so the row id is built by hand: prefetch must not trust what git lists.
    const rowId = `untracked\0${name}`
    await within(tab.prefetch!(rowId))
    const [line, ...rest] = tab.detail(rowId)
    assert.equal(rest.length, 0)
    assert.ok(line && !line.includes("secret"), `${name}: ${line}`)
  }
  assert.deepEqual(tab.detail("untracked\0link"), ["symbolic link"])
  assert.deepEqual(tab.detail("untracked\0pipe"), ["named pipe"])
}

// ---- files: a diff without hunks still says what it is ---------------------------------------------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "empty-gone"), "")
  git(cwd, "add", "empty-gone")
  git(cwd, "commit", "-qm", "empty")
  rmSync(join(cwd, "empty-gone")) // unstaged: a staged deletion beside the new empty file would be read as a rename
  writeFileSync(join(cwd, "empty-new"), "")
  git(cwd, "add", "empty-new")
  const tab = filesTab(makeHost(cwd))
  await tab.load()
  const detail = async (text: string) => {
    const row = tab.rows("").find((r) => r.text === text)!
    assert.ok(row, texts(tab).join("\n"))
    await tab.prefetch!(row.id!)
    return tab.detail(row.id!)
  }
  assert.deepEqual(await detail("A empty-new"), ["new file · mode 100644"])
  assert.deepEqual(await detail("D empty-gone"), ["deleted file · mode 100644"])
}

// ---- log: several local branches on one commit ---------------------------------------------------------------------

{
  const cwd = repo()
  git(cwd, "branch", "alpha")
  git(cwd, "branch", "beta")
  const host = makeHost(cwd)
  const tab = logTab(host)
  await tab.load()
  const row = tab.rows("").find((r) => r.text.includes("[master]"))!
  const out = await tab.act("enter", row.id!)
  assert.equal(out.kind, "notice")
  assert.ok((out as any).text.includes("alpha") && (out as any).text.includes("beta"), (out as any).text)
  assert.ok(!(out as any).text.includes("filter"), "the notice gives no advice that cannot work")
  assert.ok((out as any).text.includes("cannot be switched"), (out as any).text)
  assert.equal(git(cwd, "branch", "--show-current").trim(), "master", "an ambiguous row switches nothing")
  git(cwd, "branch", "-D", "beta")
  await tab.load()
  assert.deepEqual(await tab.act("enter", tab.rows("").find((r) => r.text.includes("[alpha]"))!.id!), { kind: "refresh" })
  assert.equal(git(cwd, "branch", "--show-current").trim(), "alpha", "the one branch that is not the current one")
}

// ---- log: opening a commit opens its first file that still exists --------------------------------------------------

{
  const cwd = repo()
  git(cwd, "rm", "-q", "a.ts")
  writeFileSync(join(cwd, "z.ts"), "z\n")
  git(cwd, "add", "z.ts")
  git(cwd, "commit", "-qm", "drop-a")
  writeFileSync(join(cwd, "y.txt"), "y\n")
  git(cwd, "add", "y.txt")
  git(cwd, "commit", "-qm", "between")
  git(cwd, "rm", "-q", "b.md")
  git(cwd, "commit", "-qm", "drop-b")
  writeFileSync(join(cwd, "v.txt"), "v\n")
  git(cwd, "add", "v.txt")
  git(cwd, "commit", "-qm", "top")
  const host = makeHost(cwd)
  const tab = logTab(host)
  await tab.load()
  const byName = (s: string) => tab.rows("").find((r) => r.text.endsWith(` ${s}`))!.id!
  assert.deepEqual(await tab.act("enter", byName("drop-a")), { kind: "close" })
  assert.equal(host.opened.at(-1)![0], join(cwd, "z.ts"), "a.ts is gone: the next file of the commit")
  const none = await tab.act("enter", byName("drop-b"))
  assert.equal(none.kind, "notice", "every file of the commit was deleted")
  assert.equal(host.opened.length, 1)
}

// ---- the git commands carry --no-optional-locks (status) and --no-ext-diff (every diff and show) -----------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "a.ts"), "changed\n")
  const inner = makeHost(cwd)
  const argvs: string[][] = []
  const host = { ...inner, exec: (cmd: string, args: string[], opts?: any) => (argvs.push(args), inner.exec(cmd, args, opts)) }
  const files = filesTab(host)
  await files.load()
  await files.prefetch!(files.rows("").find((r) => r.kind === "item")!.id!)
  const log = logTab(host)
  await log.load()
  await log.prefetch!(log.rows("").find((r) => r.kind === "item")!.id!)
  const verbs = (verb: string) => argvs.filter((a) => a.includes(verb))
  assert.ok(verbs("status").length > 0 && verbs("status").every((a) => a.includes("--no-optional-locks")), "status takes no optional lock")
  const diffs = [...verbs("diff"), ...verbs("show")]
  assert.ok(verbs("diff").length >= 3 && verbs("show").length >= 1)
  assert.ok(diffs.every((a) => a.includes("--no-ext-diff")), "no external diff driver runs: " + JSON.stringify(diffs))
}

// ---- /panel, /org-todo, alt+e and alt+w are registered at load; without a session they say why -------------

{
  const { pi, calls } = makePi()
  ecomono({ repo: REPO })(pi)
  assert.deepEqual(calls.commands.map(([name]) => name), ["panel", "org-todo"])
  assert.deepEqual(calls.shortcuts.map(([key]) => key), ["alt+e", "alt+w"])
  const ctx = makeCtx({ mode: "tui", hasUI: true })
  await calls.commands[0]![1].handler("files", ctx)
  await calls.shortcuts[1]![1].handler(ctx)
  assert.equal(ctx.recorded.custom.length, 0)
  assert.equal(ctx.recorded.notify.filter(([t]: [string]) => t.includes("main TUI session only")).length, 2)
}

console.log("test_panel_tabs: all assertions passed")
