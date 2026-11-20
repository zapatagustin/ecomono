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
import type { Action, Host, Row, Tab } from "./model.ts"

const DETAIL_LINES = 8
/** An untracked directory with more files than this is one row. */
const COLLAPSE_OVER = 20

export function filesTab(host: Host): Tab {
  let changes: Change[] = []
  let stats = { staged: new Map<string, { add: number; del: number }>(), unstaged: new Map<string, { add: number; del: number }>() }
  const diffs = new Map<string, string[]>()

  let root = host.cwd

  const git = (...args: string[]) => host.exec("git", args, { timeout: 10_000, cwd: root })
  /** The selected row's diff, from the first hunk on (the file headers are dropped by position, not by prefix, so a
   *  removed `-- comment` stays), as detail lines. A diff without a hunk (binary, mode only, pure rename) is said
   *  in one line from its extended headers instead. */
  const diffLines = (out: string): string[] => {
    const lines = out.split("\n")
    const at = lines.findIndex((l) => l.startsWith("@@"))
    if (at >= 0) return lines.slice(at).filter((l) => l !== "").slice(0, DETAIL_LINES)
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
    return parts.length ? [parts.join(" · ")] : []
  }
  /** An untracked file has no diff: its first lines, or `binary file` when the head holds a NUL. Only a regular
   *  file is opened (a FIFO would block, a symlink may point outside the repository): anything else is named in one
   *  line. A read error gives no lines. */
  const headOf = async (path: string): Promise<string[]> => {
    const st = await lstat(join(root, path)).catch(() => undefined)
    if (!st) return []
    if (!st.isFile()) return [st.isSymbolicLink() ? "symbolic link" : st.isDirectory() ? "directory or nested repository" : st.isFIFO() ? "named pipe" : st.isSocket() ? "socket" : "special file"]
    const f = await open(join(root, path)).catch(() => undefined)
    if (!f) return []
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await f.read(buf, 0, buf.length, 0)
      if (buf.subarray(0, bytesRead).includes(0)) return ["binary file"]
      return buf.toString("utf8", 0, bytesRead).split("\n").slice(0, DETAIL_LINES)
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
  const plusMinus = (m: Map<string, { add: number; del: number }>, path: string): string => {
    const s = m.get(path)
    return s ? `+${s.add} -${s.del}` : ""
  }
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
      diffs.set(rowId, n !== undefined ? [`${n} untracked files`] : await headOf(path))
      return
    }
    // A staged rename is diffed with its old path too: on the new path alone git sees a new file, not a rename.
    const from = group === "staged" ? changes.find((c) => c.path === path)?.from : undefined
    const r = await git("--literal-pathspecs", "diff", "--no-ext-diff", ...(group === "staged" ? ["--cached"] : []), "-U2", "--", path, ...(from ? [from] : []))
    diffs.set(rowId, diffLines(r.stdout))
  }

  return {
    name: "files",
    title: () => `files ${changes.length}`,
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
            if (!folded.has(dir)) rows.push({ kind: "item", text: `? ${dir}/`, right: `${big.get(dir)} files`, id: id(group, `${dir}/`), color: color("?") })
            folded.add(dir)
            continue
          }
          const stat = group === "staged" ? plusMinus(stats.staged, c.path) : group === "unstaged" ? plusMinus(stats.unstaged, c.path) : ""
          rows.push({ kind: "item", text: `${letter} ${c.path}`, right: stat, id: id(group, c.path), color: color(letter) })
        }
      }
      return rows
    },
    detail: (rowId) => diffs.get(rowId) ?? [],
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
        const first = (diffs.get(rowId) ?? []).find((l) => l.startsWith("@@"))
        const line = Number(/\+(\d+)/.exec(first ?? "")?.[1] ?? 1)
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
    },
  }
}

/** The theme color of a status letter: added green, deleted red, modified amber, untracked dim, conflict warning. */
const color = (letter: string): string => (letter === "A" ? "success" : letter === "D" ? "error" : letter === "?" ? "dim" : letter === "U" ? "warning" : "accent")

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? ""
