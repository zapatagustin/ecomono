// The three tabs of the omp side panel against real files: a temp git repo for files and log, fixture todo files
// for todo. The Host is a fake that runs git for real (spawnSync) and records editor opens and notices. Plain
// assert script; the extension's registration of /panel, /org-todo, alt+e and alt+w is pinned at the end.
import { dir, makeCtx, makePi, makeTheme, tick, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as core from "../../opencode/tui-plugins/org-todo/core.ts"
import { openPanel } from "../extensions/ecomono/panel/panel.ts"
import { REPO, ecomono } from "../extensions/ecomono/index.ts"
import { startOrgTodo, todoTab } from "../extensions/ecomono/org-todo.ts"
import { filesTab } from "../extensions/ecomono/panel/files.ts"
import { logTab } from "../extensions/ecomono/panel/log.ts"
import type { Detail, Host, Row, Tab } from "../extensions/ecomono/panel/model.ts"

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
/** The text of a detail's lines: what the data tests compare; the presentation is pinned in test_panel.ts. */
const body = (d: Detail | undefined): string[] => d?.lines.map((l) => l.text) ?? []
const stat = (r: Row): string => (r.add !== undefined || r.del !== undefined ? ` +${r.add ?? 0} -${r.del ?? 0}` : "")
const texts = (tab: Tab, filter = "") => tab.rows(filter).map((r) => (r.kind === "head" ? `# ${r.text} ${r.right ?? ""}`.trim() : `${r.text}${stat(r)}${r.right ? ` ${r.right}` : ""}`))

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
  assert.equal(tab.title(), "files", "no count before the first load: never a made-up zero")
  assert.equal(logTab(host).title(), "log")
  await tab.load()
  assert.equal(tab.title(), "files 3")
  // A wholly untracked directory is listed per file (--untracked-files=all), so enter and s act on one file.
  assert.deepEqual(texts(tab), ["# staged 1", "M b.md +1 -0", "# unstaged 1", "M a.ts +1 -0", "# untracked 1", "? dir with space/new.ts"])
  const staged = tab.rows("")[1]!
  assert.equal(staged.color, "accent")
  assert.equal(tab.detail(staged.id!), undefined, "the detail is empty until prefetched")
  await tab.prefetch!(staged.id!)
  assert.deepEqual(body(tab.detail(staged.id!)), [" # b", "+more"])
  assert.deepEqual({ title: tab.detail(staged.id!)!.title, tail: tab.detail(staged.id!)!.tail }, { title: "b.md", tail: "@@ -1 +1,2 @@" })
  assert.deepEqual(tab.detail(staged.id!)!.lines.map((l) => [l.no, l.kind]), [[1, undefined], [2, "add"]], "numbered by the new file, added lines marked")
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
  assert.deepEqual(body(tab.detail(unstaged)), [" x", "+y"])
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
  const detail = body(tab.detail(row.id!))
  assert.ok(tab.detail(row.id!)!.tail!.startsWith("@@"), detail.join("\n"))
  assert.ok(detail.includes("--- keep"), detail.join("\n"))
  assert.ok(detail.includes("+++ y"), detail.join("\n"))
}

// ---- files: a hunk longer than the detail bound is cut, and the cut is said -------------------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "big.txt"), Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join("\n") + "\n")
  git(cwd, "add", "big.txt") // a staged new file: one hunk of 100 lines
  const host = makeHost(cwd)
  const tab = filesTab(host)
  await tab.load()
  const row = tab.rows("").find((r) => r.text.includes("big.txt"))!
  await tab.prefetch!(row.id!)
  const d = tab.detail(row.id!)!
  assert.equal(d.lines.length, 40, "the body is held to the bound, not whole")
  assert.equal(d.lines[0]!.text, "+row 1")
  assert.equal(d.more, "60 líneas más", "the lines left out are counted")
  assert.deepEqual(await tab.act("d", row.id!), { kind: "close" })
  assert.deepEqual(host.opened.at(-1), [join(cwd, "big.txt"), 1], "d still jumps to the first changed line")
}

// ---- log: a commit with an empty subject keeps its author line as the note --------------------------------------

{
  const cwd = repo()
  writeFileSync(join(cwd, "e.ts"), "e\n")
  git(cwd, "add", "e.ts")
  git(cwd, "commit", "-q", "--allow-empty-message", "-m", "")
  const tab = logTab(makeHost(cwd))
  await tab.load()
  const sha = tab.rows("").find((r) => r.color === "accent")!.id! // HEAD: the empty-subject commit
  await tab.prefetch!(sha)
  const d = tab.detail(sha)!
  assert.ok(d.note!.startsWith("t · "), `the note is the author line: ${d.note}`)
  assert.ok(body(d).some((l) => l.includes("e.ts")) && !body(d).some((l) => l.startsWith("t · ")), body(d).join("\n"))
}

// ---- log: the strip count says `200+` when the limit was reached ------------------------------------------------

{
  const inner = makeHost(repo())
  const log = (n: number) => Array.from({ length: n }, (_, i) => `* ${String(i).padStart(7, "0")}\0\0c${i}`).join("\n") + "\n"
  let n = 200
  const host: Host = { ...inner, exec: async (cmd, args, opts) => (args[0] === "log" ? { stdout: log(n), stderr: "", code: 0 } : inner.exec(cmd, args, opts)) }
  const tab = logTab(host)
  await tab.load()
  assert.equal(tab.title(), "log 200+", "200 loaded commits may be a cut, not a total")
  n = 199
  await tab.load()
  assert.equal(tab.title(), "log 199")
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
  assert.equal(tab.detail(sha), undefined)
  await tab.prefetch!(sha)
  assert.equal(tab.detail(sha)!.title, sha)
  assert.equal(tab.detail(sha)!.tail, "feature/x", "the branch names go after the short sha")
  assert.ok(tab.detail(sha)!.note!.startsWith("t · "), tab.detail(sha)!.note)
  assert.equal(body(tab.detail(sha))[0], "feature commit")
  assert.ok(body(tab.detail(sha)).some((l) => l.includes("c.ts")))

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
  assert.equal(tab.title(), "log 4 ·", "the count is of the last load; the mark says --all is off")
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
    const one = tab.rows("")[1]!.id!
    assert.equal(tab.detail(one)!.title, `${join(docs, "a.md")}:2`)
    assert.deepEqual(tab.detail(one)!.lines, [{ no: 2, text: "- [ ] one", kind: "hit" }], "before the file is read: the todo's own line")
    await tab.prefetch!(one)
    assert.deepEqual(tab.detail(one)!.lines, [{ no: 1, text: "# t" }, { no: 2, text: "- [ ] one", kind: "hit" }, { no: 3, text: "- [ ] two" }], "then its neighbours in the file, the todo marked")

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
    return body(tab.detail(row.id!))
  }
  assert.deepEqual(await detail("bin.dat"), ["binary file"], "a binary diff has no hunk: say so")
  assert.deepEqual(await detail("b.md"), ["mode change 100644 → 100755"])
  assert.deepEqual(await detail("renamed.ts"), ["renamed from a.ts"], "a pure rename is diffed with its old path too")
  assert.deepEqual(await detail("n.txt"), Array.from({ length: 12 }, (_, i) => `l${i + 1}`), "an untracked file has no diff: its lines, numbered, the panel cuts them to its room")
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
  assert.deepEqual(body(tab.detail(dirRow.id!)), ["25 untracked files"])
  assert.deepEqual(await tab.act("s", dirRow.id!), { kind: "refresh" })
  const status = git(cwd, "status", "--porcelain", "--untracked-files=all", "--", "build").split("\n")
  assert.equal(status.filter((l) => l.startsWith("A  ")).length, 25, "the 25 untracked files were added")
  assert.ok(status.includes(" M build/tracked.js") && status.includes(" D build/gone.js"), `tracked changes stay unstaged: ${status.join("|")}`)
  // A path git reports with a trailing slash (a nested repository) is an ordinary row, not a collapsed one.
  await tab.load()
  const nested = tab.rows("").find((r) => r.text === "? nested/")!
  assert.ok(nested, texts(tab).join("\n"))
  await tab.prefetch!(nested.id!)
  assert.deepEqual(body(tab.detail(nested.id!)), ["directory or nested repository"])
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
    const [line, ...rest] = body(tab.detail(rowId))
    assert.equal(rest.length, 0)
    assert.ok(line && !line.includes("secret"), `${name}: ${line}`)
  }
  assert.deepEqual(body(tab.detail("untracked\0link")), ["symbolic link"])
  assert.deepEqual(body(tab.detail("untracked\0pipe")), ["named pipe"])
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
    return body(tab.detail(row.id!))
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

// ---- log: enter on a row whose only local branch is the current one, and on a row with only a remote branch -----

{
  const cwd = repo()
  const host = makeHost(cwd)
  const tab = logTab(host)
  await tab.load()
  const row = tab.rows("").find((r) => r.text.includes("[master]"))!
  assert.deepEqual(await tab.act("enter", row.id!), { kind: "refresh" }, "the current branch is switched to, a no-op git accepts")
  assert.equal(git(cwd, "branch", "--show-current").trim(), "master")
  assert.equal(host.opened.length, 0, "it does not open the editor")

  const clone = dir("clone")
  git(clone, "clone", "-q", cwd, ".")
  const chost = makeHost(clone)
  const ctab = logTab(chost)
  await ctab.load()
  const remote = ctab.rows("").find((r) => r.text.includes("[origin/feature/x]"))!
  assert.ok(remote && !remote.text.replace("[origin/feature/x]", "").includes("["), remote?.text)
  assert.deepEqual(await ctab.act("enter", remote.id!), { kind: "refresh" })
  assert.equal(git(clone, "branch", "--show-current").trim(), "feature/x", "a remote-only row creates the tracking branch")
  assert.equal(chost.opened.length, 0)
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
  assert.ok(diffs.length > 0, "the commands ran")
  assert.ok(diffs.every((a) => a.includes("--no-ext-diff")), "no external diff driver runs: " + JSON.stringify(diffs))
}

// ---- the panel over the real tabs: counts, sections, paths, counters, details, lanes, at 46 and 40 cells -------------

{
  const cwd = repo()
  git(cwd, "merge", "-q", "--no-ff", "-m", "merge feature/x", "feature/x") // two lanes, a merge commit
  const long = "omp/extensions/ecomono/panel/some-quite-long-file-name.ts"
  mkdirSync(join(cwd, "omp/extensions/ecomono/panel"), { recursive: true })
  writeFileSync(join(cwd, long), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n")
  git(cwd, "add", long)
  git(cwd, "commit", "-qm", "add the long one")
  writeFileSync(join(cwd, long), Array.from({ length: 30 }, (_, i) => (i === 0 || i === 20 ? `line ${i + 1} edited` : `line ${i + 1}`)).join("\n") + "\n")
  writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree\nfour\n") // unstaged M, +1 and no removal
  git(cwd, "add", long) // staged M: two hunks, +2 -2
  writeFileSync(join(cwd, "b.md"), "# b\nmore\n") // unstaged M +1
  writeFileSync(join(cwd, "new.md"), "# n\n") // untracked
  const docs = join(cwd, "docs")
  mkdirSync(docs)
  writeFileSync(join(docs, "a.md"), "# t\n- [ ] one\n- [ ] decide the foot fallback with a rather long todo title that must be cut\n- [ ] two\n")
  const org = dir("panel-org")
  await withEnv({ ECOMONO_ORG_DIR: org }, async () => {
    const { pi } = makePi({
      exec: (command, args) => {
        const r = spawnSync(command, args, { encoding: "utf8" })
        return { stdout: r.stdout, stderr: r.stderr, code: r.status, killed: false }
      },
    })
    const handle = startOrgTodo(pi, makeCtx({ cwd, mode: "tui", hasUI: true }), core)
    await tick()
    const host = makeHost(cwd)
    const open = async (initial: number, columns: number, rows = 40) => {
      const ctx = makeCtx({ mode: "tui", hasUI: true, terminal: { rows, columns }, theme: makeTheme(true) })
      void openPanel(ctx, [todoTab(core, handle, host), filesTab(host), logTab(host)], initial)
      for (let i = 0; i < 40 && !ctx.recorded.custom.at(-1)?.component; i++) await tick()
      const c = ctx.recorded.custom.at(-1)!.component
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 30))
      return { c, out: (): string[] => c.render(columns) as string[] }
    }
    /** The line as plain text: theme tags, reverse video escapes and bg tags out. */
    const text = (l: string): string => l.replace(/<\/?\w+>/g, "").replace(/\x1b\[(?:7|27)m/g, "")

    // Every tab shows its count at once, including the two that were never visited; the active tab is a solid block.
    const files = await open(1, 46)
    let out = files.out().map(text)
    assert.equal(out[0], "│  todo 3 │ files 5 │ log 5              1 / 5")
    assert.ok(files.out()[0]!.includes("\x1b[7m<accent> files 5 </accent>\x1b[27m"), "the active tab is a solid block")
    assert.ok(files.out().every((l: string) => Bun.stringWidth(l.replace(/<\/?\w+>/g, "")) === 46), "every line is as wide as the panel")

    // Sections: a head with its count, one blank row before each but the first, items indented two cells, the long
    // path cut at its start so the file name survives, the counters in their own columns.
    const pad = (l: string) => l.replace(/ +$/, "")
    assert.deepEqual(out.slice(3, 13).map(pad), [
      "│ staged                                     1",
      "│ > M …/some-quite-long-file-name.ts    +2  -2",
      "│",
      "│ unstaged                                   2",
      "│   M a.ts                              +1",
      "│   M b.md                              +1",
      "│",
      "│ untracked                                  2",
      "│   ? docs/a.md",
      "│   ? new.md",
    ])
    const colored = files.out()
    assert.ok(colored[3]!.includes("<dim>staged"), "a section head is dim")
    assert.ok(!out.join("\n").includes("-0") && !out.join("\n").includes("+0"), "a zero side is blank")

    // The detail: hairline, accent title (the path, the hunk header), a blank row, numbered lines, then what was cut.
    assert.equal(out[13], "│ " + "─".repeat(44))
    assert.ok(colored[14]!.includes("<accent>…/ecomono/panel/some-quite-long-file-name.ts</accent>"), "the path keeps its file name; the hunk header does not fit beside it, so it goes")
    assert.equal(pad(out[15]!), "│")
    assert.equal(pad(out[16]!), "│    1 │ -line 1")
    assert.equal(pad(out[17]!), "│    1 │ +line 1 edited")
    assert.equal(pad(out[18]!), "│    2 │  line 2")
    assert.ok(colored[16]!.includes("<dim>   1 │ </dim><toolDiffRemoved>-line 1") && colored[17]!.includes("<toolDiffAdded>+line 1 edited"), "a dim gutter; removed and added lines in their colors")
    assert.equal(pad(out[20]!), "│ … 1 hunk más", "the hunks left out are counted")
    assert.ok(out.slice(21, -3).every((l: string) => pad(l) === "│"), "free rows after the detail, before the key bar")
    const bar = out.slice(-3).join(" ")
    assert.ok(bar.includes("nvim") && bar.includes("stage/unstage") && bar.includes("diff") && bar.includes("filtrar") && bar.includes("mover") && bar.includes("pestaña") && bar.includes("cerrar"), bar)

    // Unselected, the counters are drawn in their own colors; the selected row is one solid block.
    files.c.handleInput("j")
    await new Promise((r) => setTimeout(r, 60))
    const moved = files.out()
    assert.ok(moved[4]!.includes("<toolDiffAdded>+2</toolDiffAdded>  <toolDiffRemoved>-2</toolDiffRemoved>"), moved[4])
    assert.match(text(moved[14]!), /^│ a\.ts {3}@@ -\d+(,\d+)? \+\d+(,\d+)? @@/, "the path, then the hunk header when both fit")
    assert.ok(moved[7]!.includes("\x1b[7m<accent>> M a.ts") && moved[7]!.endsWith("</accent>\x1b[27m"), moved[7])

    // 40 cells: nothing dropped from the key bar, every line as wide as the panel.
    const narrow = await open(1, 40)
    assert.ok(narrow.out().every((l: string) => Bun.stringWidth(l.replace(/<\/?\w+>/g, "")) === 40))
    assert.ok(narrow.out().map(text)[0]!.startsWith("│  todo 3 │ files 5 │ log 5"), text(narrow.out()[0]!))
    assert.ok(narrow.out().map(text).slice(-6).join(" ").includes("pestaña"))
    assert.ok(narrow.out().map(text).slice(-6).some((l: string) => l.includes(" s  stage/unstage")), "s toggles, and the bar says both verbs, uncropped")

    // The todo tab: free text cut at a word, `file:line` title, the file's neighbouring lines, the todo's own line a block.
    const todo = await open(0, 46)
    out = todo.out().map(text)
    todo.c.handleInput("j")
    await new Promise((r) => setTimeout(r, 60))
    out = todo.out().map(text)
    const item = out.findIndex((l: string) => l.includes("decide the foot"))
    assert.match(out[item]!, /^│ > ○ decide the foot fallback with a… +:3 *$/, "cut on a word boundary, no half word before the ellipsis")
    const trule = out.findIndex((l: string, i: number) => i > item && l.startsWith("│ ──────"))
    assert.match(out[trule + 1]!, /^│ …?\/?.*docs\/a\.md:3 *$/, "the title is file:line")
    assert.ok(todo.out()[trule + 1]!.includes("<accent>"))
    assert.deepEqual(out.slice(trule + 3, trule + 7).map((l: string) => l.replace(/ +$/, "")), [
      "│    1 │ # t",
      "│    2 │ - [ ] one",
      "│    3 │ - [ ] decide the foot fallback with …",
      "│    4 │ - [ ] two",
    ], "the neighbouring lines of the file, numbered")
    assert.ok(todo.out()[trule + 5]!.includes("\x1b[7m") && !todo.out()[trule + 4]!.includes("\x1b[7m"), "the todo's own line is the highlighted one")
    assert.equal(out[trule + 7]!.trim(), "│", "no phantom line after the file's last newline")

    // The log tab: graph, short sha, chips in lane colors (the current branch in the accent), the subject.
    const log = await open(2, 61)
    out = log.out().map(text)
    // The detail of the selected commit: the short sha and its branch names as the title, author and date dim.
    assert.match(out[11]!, /^│ [0-9a-f]{7} {3}master {3,}$/, out[11])
    assert.ok(log.out()[11]!.startsWith("<border>│</border> <accent>"), "the title is accent")
    assert.ok(log.out()[12]!.includes("<dim>t · "), "author and date are dim")
    assert.equal(out[13]!.trim(), "│", "one blank row under the note")
    assert.ok(log.out().every((l: string) => Bun.stringWidth(l.replace(/<\/?\w+>|\[\w+\||\|\]/g, "").replace(/\x1b\[(?:7|27)m/g, "")) === 61), "every line as wide as the panel")
    // Moved off the HEAD row, the columns show: lane glyphs each in their own lane's color, the sha dim, the chip of
    // the current branch in the accent and another branch's chip in its lane's color; the accent is on no lane glyph.
    log.c.handleInput("j")
    await new Promise((r) => setTimeout(r, 60))
    const rows = log.out()
    const strip = (l: string): string => l.replace(/\[\w+\||\|\]/g, "")
    assert.match(strip(rows[3]!), /<mdLink>●<\/mdLink> {4}<muted>[0-9a-f]{7}<\/muted> <accent> master <\/accent> add the long one/)
    const feature = rows.find((l: string) => l.includes("feature commit"))!
    assert.ok(strip(feature).includes("<mdLink>│</mdLink> <success>●</success>") && strip(feature).includes("<success> feature/x </success> feature commit"), strip(feature))
    for (const l of rows) assert.ok(!/<accent>[│├┤┘┐●]/.test(l), "the accent never lands on a lane glyph")
    // The subject is the part that gives way, never the graph or the chips.
    const tight = await open(2, 40)
    const t40 = tight.out().find((l: string) => l.includes("<success> feature/x </success>"))!
    assert.match(strip(t40), /<success> feature\/x <\/success> feature( commit)?…?\s*$/, "the chip stays whole, the subject is what is cut")
  })
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
