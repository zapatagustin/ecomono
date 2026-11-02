/**
 * The `files` tab of the side panel: the git working tree grouped as staged, unstaged and untracked, each row
 * with its `+a -d`, the selected file's diff as the detail. s stages an unstaged or untracked file and unstages
 * a staged one, enter opens it in the editor, d opens it at its first changed hunk. One `git status` and two
 * numstats per load; the detail is the selected row's `git diff`, read by prefetch into a cache that a load
 * clears. Every git command runs at the repository root (git's paths are relative to it) with literal pathspecs.
 */

import { join } from "node:path"
import { type Change, parseNumstat, parseStatus, repoRoot } from "./git.ts"
import type { Action, Host, Row, Tab } from "./model.ts"

const DETAIL_LINES = 8

export function filesTab(host: Host): Tab {
  let branch = ""
  let changes: Change[] = []
  let stats = { staged: new Map<string, { add: number; del: number }>(), unstaged: new Map<string, { add: number; del: number }>() }
  const diffs = new Map<string, string[]>()

  let root = host.cwd

  const git = (...args: string[]) => host.exec("git", args, { timeout: 10_000, cwd: root })
  /** The selected row's diff, from the first hunk on (the file headers are dropped by position, not by prefix, so a
   *  removed `-- comment` stays), as detail lines. */
  const diffLines = (out: string): string[] => {
    const lines = out.split("\n")
    const at = lines.findIndex((l) => l.startsWith("@@"))
    return (at < 0 ? [] : lines.slice(at)).filter((l) => l !== "").slice(0, DETAIL_LINES)
  }
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
    if (group === "untracked") return
    const r = await git("--literal-pathspecs", "diff", "--no-ext-diff", ...(group === "staged" ? ["--cached"] : []), "-U2", "--", path)
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
      for (const [group, list] of groups) {
        const shown = list.filter(([c]) => !q || c.path.toLowerCase().includes(q))
        if (shown.length === 0) continue
        rows.push({ kind: "head", text: group, right: String(shown.length) })
        for (const [c, letter] of shown) {
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
        const r = group === "staged" ? await git("--literal-pathspecs", "restore", "--staged", "--", path) : await git("--literal-pathspecs", "add", "--", path)
        if (r.code !== 0) return { kind: "notice", text: `git: ${firstLine(r.stderr) || `exit ${r.code}`}` }
        return { kind: "refresh" }
      }
      return { kind: "none" }
    },
    load: async () => {
      root = await repoRoot(host)
      const status = await git("--no-optional-locks", "status", "--untracked-files=all", "--porcelain=v2", "--branch", "-z")
      if (status.code !== 0) throw new Error(`git status: ${firstLine(status.stderr) || `exit ${status.code}`}`)
      ;({ branch, changes } = parseStatus(status.stdout))
      const [unstaged, staged] = await Promise.all([git("diff", "--no-ext-diff", "--numstat", "-z"), git("diff", "--no-ext-diff", "--cached", "--numstat", "-z")])
      stats = { staged: parseNumstat(staged.stdout), unstaged: parseNumstat(unstaged.stdout) }
      diffs.clear()
      void branch
    },
  }
}

/** The theme color of a status letter: added green, deleted red, modified amber, untracked dim, conflict warning. */
const color = (letter: string): string => (letter === "A" ? "success" : letter === "D" ? "error" : letter === "?" ? "dim" : letter === "U" ? "warning" : "accent")

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? ""
