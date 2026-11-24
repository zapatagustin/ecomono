/**
 * The `files` tab of the side panel: the git working tree grouped as staged, unstaged and untracked, each row
 * with its `+a -d`, the selected file's diff as the detail. s stages an unstaged or untracked file and unstages
 * a staged one, enter opens it in the editor, d opens it at its first changed hunk. One `git status` and two
 * numstats per load; the detail is the selected row's `git diff`, read by prefetch into a cache that a load
 * clears. Every git command runs at the repository root (git's paths are relative to it) with literal pathspecs.
 */

import { lstat, open } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type Change, parseNumstat, parseStatus, repoRoot } from "./git.ts"
import type { Action, Detail, DetailLine, Host, Row, Tab } from "./model.ts"

/** Lines of an untracked file, or of a diff's hunk, held as its detail; the panel cuts further to the room it has. */
const DETAIL_LINES = 40
/** An untracked directory with more files than this is one row. */
const COLLAPSE_OVER = 20

export function filesTab(host: Host): Tab {
  let changes: Change[] = []
  let stats = { staged: new Map<string, { add: number; del: number }>(), unstaged: new Map<string, { add: number; del: number }>() }
  const diffs = new Map<string, Detail>()
  /** False until the first load worked: the strip shows no count before that, never a zero that is not known. */
  let loaded = false

  let root = host.cwd

  const git = (...args: string[]) => host.exec("git", args, { timeout: 10_000, cwd: root })
  /** The selected row's diff as a detail: the first hunk (header in the title's tail, lines numbered by the new
   *  file, a removed line by the old one) and a count of the hunks after it. The file headers are dropped by
   *  position, not by prefix, so a removed `-- comment` stays. A diff without a hunk (binary, mode only, pure
   *  rename) is said in one line from its extended headers instead. */
  const diffDetail = (path: string, out: string): Detail => {
    const lines = out.split("\n").filter((l) => l !== "")
    const at = lines.findIndex((l) => l.startsWith("@@"))
    if (at >= 0) {
      const rest = lines.slice(at)
      const next = rest.findIndex((l, i) => i > 0 && l.startsWith("@@"))
      const hunk = next === -1 ? rest : rest.slice(0, next)
      const hunks = rest.filter((l) => l.startsWith("@@")).length - 1
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk[0]!)
      let [from, to] = [Number(m?.[1] ?? 1), Number(m?.[2] ?? 1)]
      // The body is capped at DETAIL_LINES, the panel draws only what fits: a huge hunk (a staged new file) is held to the bound, the rest is counted.
      const hidden = Math.max(0, hunk.length - 1 - DETAIL_LINES)
      const body: DetailLine[] = hunk.slice(1, 1 + DETAIL_LINES).map((l) => {
        if (l.startsWith("+")) return { text: l, no: to++, kind: "add" }
        if (l.startsWith("-")) return { text: l, no: from++, kind: "del" }
        if (l.startsWith("\\")) return { text: l }
        return { text: l, no: (from++, to++) }
      })
      return { title: path, tail: /^@@ [^@]*@@/.exec(hunk[0]!)?.[0] ?? hunk[0]!, lines: body, more: [hidden > 0 ? `${hidden} línea${hidden > 1 ? "s" : ""} más` : "", hunks > 0 ? `${hunks} hunk${hunks > 1 ? "s" : ""} más` : ""].filter(Boolean).join(" · ") || undefined }
    }
    const head = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length)
    const parts: string[] = []
    if (lines.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch")) parts.push("binary file")
    const [oldMode, newMode] = [head("old mode "), head("new mode ")]
    if (oldMode && newMode) parts.push(`mode change ${oldMode} → ${newMode}`)
    // An empty new or deleted file has no hunk either: git's own header says it.
    const [added, deleted] = [head("new file mode "), head("deleted file mode ")]
    if (added) parts.push(`new file · mode ${added}`)
    if (deleted) parts.push(`deleted file · mode ${deleted}`)
    const from = head("rename from ")
    if (from) parts.push(`renamed from ${from}`)
    return { title: path, lines: parts.length ? [{ text: parts.join(" · ") }] : [] }
  }
  /** An untracked file has no diff: its first lines, or `binary file` when the head holds a NUL. Only a regular
   *  file is opened (a FIFO would block, a symlink may point outside the repository): anything else is named in one
   *  line. A read error gives no lines. The lines of a file are numbered, a one-line statement is not. */
  const headOf = async (path: string): Promise<DetailLine[]> => {
    const st = await lstat(join(root, path)).catch(() => undefined)
    if (!st) return []
    if (!st.isFile()) return [{ text: st.isSymbolicLink() ? "symbolic link" : st.isDirectory() ? "directory or nested repository" : st.isFIFO() ? "named pipe" : st.isSocket() ? "socket" : "special file" }]
    const f = await open(join(root, path)).catch(() => undefined)
    if (!f) return []
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await f.read(buf, 0, buf.length, 0)
      if (buf.subarray(0, bytesRead).includes(0)) return [{ text: "binary file" }]
      const text = buf.toString("utf8", 0, bytesRead).split("\n")
      if (text.at(-1) === "") text.pop()
      return text.slice(0, DETAIL_LINES).map((t, i) => ({ text: t, no: i + 1 }))
    } catch {
      return []
    } finally {
      await f.close()
    }
  }
  /** The untracked directories shown as one row each, with their file counts. ecomono: only the directory that
   *  directly holds the files counts, so a build tree spread over many small subdirectories still lists them;
   *  fold by ancestor if that ever shows. */
  const bigDirs = (): Map<string, number> => {
    const n = new Map<string, number>()
    for (const c of changes) if (c.untracked && dirname(c.path) !== ".") n.set(dirname(c.path), (n.get(dirname(c.path)) ?? 0) + 1)
    for (const [d, k] of n) if (k <= COLLAPSE_OVER) n.delete(d)
    return n
  }
  /** The file count of a collapsed row's path (`<dir>/`), by membership in the collapse set, never by the slash. */
  const collapsedCount = (path: string): number | undefined => (path.endsWith("/") ? bigDirs().get(path.slice(0, -1)) : undefined)
  /** Rows are `<group>\0<path>` so a path staged and unstaged at once has two selectable rows. */
  const id = (group: string, path: string): string => `${group}\0${path}`
  const parse = (rowId: string): { group: string; path: string } => {
    const [group, path] = rowId.split("\0")
    return { group: group!, path: path! }
  }

  const prefetch = async (rowId: string): Promise<void> => {
    const { group, path } = parse(rowId)
    if (group === "untracked") {
      const n = collapsedCount(path)
      diffs.set(rowId, { title: path, lines: n !== undefined ? [{ text: `${n} untracked files` }] : await headOf(path) })
      return
    }
    // A staged rename is diffed with its old path too: on the new path alone git sees a new file, not a rename.
    const from = group === "staged" ? changes.find((c) => c.path === path)?.from : undefined
    const r = await git("--literal-pathspecs", "diff", "--no-ext-diff", ...(group === "staged" ? ["--cached"] : []), "-U2", "--", path, ...(from ? [from] : []))
    diffs.set(rowId, diffDetail(path, r.stdout))
  }

  return {
    name: "files",
    title: () => (loaded ? `files ${changes.length}` : "files"),
    rows: (filter) => {
      const q = filter.toLowerCase()
      const groups: Array<[string, Array<[Change, string]>]> = [
        ["staged", changes.filter((c) => c.staged !== "." && !c.untracked).map((c) => [c, c.staged])],
        ["unstaged", changes.filter((c) => c.unstaged !== "." && !c.untracked).map((c) => [c, c.unstaged])],
        ["untracked", changes.filter((c) => c.untracked).map((c) => [c, "?"])],
      ]
      const rows: Row[] = []
      // While a filter is active nothing is collapsed: the folded row would carry the unfiltered count.
      const big = q ? new Map<string, number>() : bigDirs()
      for (const [group, list] of groups) {
        const shown = list.filter(([c]) => !q || c.path.toLowerCase().includes(q))
        if (shown.length === 0) continue
        rows.push({ kind: "head", text: group, right: String(shown.length) })
        const folded = new Set<string>()
        for (const [c, letter] of shown) {
          const dir = group === "untracked" ? dirname(c.path) : "."
          if (big.has(dir)) {
            if (!folded.has(dir)) rows.push({ kind: "item", text: `? ${dir}/`, right: `${big.get(dir)} files`, id: id(group, `${dir}/`), color: color("?"), cut: "start" })
            folded.add(dir)
            continue
          }
          const stat = group === "staged" ? stats.staged.get(c.path) : group === "unstaged" ? stats.unstaged.get(c.path) : undefined
          rows.push({ kind: "item", text: `${letter} ${c.path}`, add: stat?.add, del: stat?.del, id: id(group, c.path), color: color(letter), cut: "start" })
        }
      }
      return rows
    },
    detail: (rowId) => diffs.get(rowId),
    prefetch,
    keys: [
      ["enter", "nvim"],
      ["s", "stage/unstage"],
      ["d", "diff"],
    ],
    act: async (key, rowId): Promise<Action> => {
      const { group, path } = parse(rowId)
      const file = join(root, path)
      if (key === "enter") {
        await host.openEditor(file, 1)
        return { kind: "close" }
      }
      if (key === "d") {
        // ecomono: the diff is shown in the editor as the file at its first changed hunk, not as a diff buffer: a
        // pipe into `nvim -R -` has no stdin under foot. Write the diff to a temp file if a diff view is wanted.
        if (!diffs.has(rowId)) await prefetch(rowId)
        const line = Number(/\+(\d+)/.exec(diffs.get(rowId)?.tail ?? "")?.[1] ?? 1)
        await host.openEditor(file, line)
        return { kind: "close" }
      }
      if (key === "s") {
        // A staged rename is two staged entries: unstage the old path with the new one, or its deletion stays staged.
        const from = group === "staged" ? changes.find((c) => c.path === path)?.from : undefined
        // A collapsed row adds exactly the untracked files it stands for, as explicit paths: the directory itself
        // would also stage the tracked changes under it. ecomono: one argument per file, so a directory holding
        // many thousands of untracked files can exceed the argv limit and the add fails with a notice. Upgrade to
        // `--pathspec-from-file` once Host.exec can pass stdin.
        const stands = group === "untracked" && collapsedCount(path) !== undefined ? changes.filter((c) => c.untracked && dirname(c.path) === path.slice(0, -1)).map((c) => c.path) : [path]
        const r = group === "staged" ? await git("--literal-pathspecs", "restore", "--staged", "--", path, ...(from ? [from] : [])) : await git("--literal-pathspecs", "add", "--", ...stands)
        if (r.code !== 0) return { kind: "notice", text: `git: ${firstLine(r.stderr) || `exit ${r.code}`}` }
        return { kind: "refresh" }
      }
      return { kind: "none" }
    },
    load: async () => {
      root = await repoRoot(host)
      const status = await git("--no-optional-locks", "status", "--untracked-files=all", "--porcelain=v2", "--branch", "-z")
      if (status.code !== 0) throw new Error(`git status: ${firstLine(status.stderr) || `exit ${status.code}`}`)
      ;({ changes } = parseStatus(status.stdout))
      const [unstaged, staged] = await Promise.all([git("diff", "--no-ext-diff", "--numstat", "-z"), git("diff", "--no-ext-diff", "--cached", "--numstat", "-z")])
      stats = { staged: parseNumstat(staged.stdout), unstaged: parseNumstat(unstaged.stdout) }
      diffs.clear()
      loaded = true
    },
  }
}

/** The theme color of a status letter: added green, deleted red, modified amber, untracked dim, conflict warning. */
const color = (letter: string): string => (letter === "A" ? "success" : letter === "D" ? "error" : letter === "?" ? "dim" : letter === "U" ? "warning" : "accent")

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? ""
