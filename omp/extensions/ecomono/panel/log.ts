/**
 * The `log` tab of the side panel: the commit graph (`git log --graph`) redrawn with box glyphs, a branch chip
 * on the row of the commit it points to, the selected commit's stat as the detail. enter on a row with a local
 * branch switches to it (git refuses a conflicting dirty tree; the notice carries its reason), on a remote-only
 * row creates the tracking branch, on a plain commit opens its first changed file in the editor. a toggles
 * --all. One `git log` per load; the detail is one `git show --stat` per selected commit (prefetch), cached
 * until the next load. Every git command runs at the repository root, where git's paths are relative to.
 */

import { join } from "node:path"
import { type GraphLine, branchTargets, parseGraph, repoRoot } from "./git.ts"
import type { Action, Host, Row, Tab } from "./model.ts"

const LIMIT = 200
const DETAIL_LINES = 8

export function logTab(host: Host): Tab {
  let all = true
  let lines: GraphLine[] = []
  const details = new Map<string, string[]>()

  let root = host.cwd

  const git = (...args: string[]) => host.exec("git", args, { timeout: 10_000, cwd: root })
  const commit = (sha: string) => lines.find((l) => l.commit?.sha === sha)?.commit

  return {
    name: "log",
    title: () => (all ? "log" : "log ·"),
    rows: (filter) => {
      const q = filter.toLowerCase()
      const rows: Row[] = []
      for (const l of lines) {
        if (!l.commit) {
          if (!q) rows.push({ kind: "head", text: l.graph })
          continue
        }
        const { sha, refs, subject } = l.commit
        const chips = refs.map((r) => (r.startsWith("HEAD -> ") ? r.slice("HEAD -> ".length) : r.startsWith("tag: ") ? r.slice("tag: ".length) : r)).map((r) => `[${r}]`)
        const text = `${l.graph} ${sha} ${chips.length ? `${chips.join(" ")} ` : ""}${subject}`
        if (q && !subject.toLowerCase().includes(q) && !sha.includes(q) && !chips.join(" ").toLowerCase().includes(q)) continue
        rows.push({ kind: "item", text, id: sha, color: l.commit.head ? "accent" : undefined })
      }
      return rows
    },
    detail: (sha) => details.get(sha) ?? [],
    prefetch: async (sha) => {
      const r = await git("show", "--no-ext-diff", "--stat=60", "--format=%s%n%an · %ar", sha)
      details.set(sha, r.stdout.split("\n").filter((l) => l.trim() !== "").slice(0, DETAIL_LINES))
    },
    keys: [
      ["enter", "switch · nvim"],
      ["a", "todas"],
      ["d", "diff"],
    ],
    act: async (key, sha): Promise<Action> => {
      if (key === "a") {
        all = !all
        return { kind: "refresh" }
      }
      const c = commit(sha)
      if (!c) return { kind: "refresh" }
      const { local, remote } = branchTargets(c.refs)
      if (key === "d" || (key === "enter" && local.length === 0 && remote.length === 0)) {
        // The commit's first changed file, at its first hunk: `git show` would need a diff buffer (panel/files.ts
        // says why there is none).
        const r = await git("show", "--no-ext-diff", "--format=", "--name-only", "-z", sha)
        const file = r.stdout.split("\0").find((l) => l.trim() !== "")
        if (!file) return { kind: "notice", text: `git: ${sha} changes no file` }
        await host.openEditor(join(root, file), 1)
        return { kind: "close" }
      }
      if (key === "enter") {
        const r = local[0] ? await git("switch", local[0]) : remote[0] ? await git("switch", "--track", remote[0]) : undefined
        if (!r) return { kind: "notice", text: `git: ${sha} carries no branch` }
        if (r.code !== 0) return { kind: "notice", text: `git: ${firstLine(r.stderr) || `exit ${r.code}`}` }
        return { kind: "refresh" }
      }
      return { kind: "none" }
    },
    load: async () => {
      root = await repoRoot(host)
      const r = await git("log", "--graph", ...(all ? ["--all"] : []), "--format=%h%x00%D%x00%s", `-n${LIMIT}`)
      if (r.code !== 0) throw new Error(`git log: ${firstLine(r.stderr) || `exit ${r.code}`}`)
      lines = parseGraph(r.stdout)
      details.clear()
    },
  }
}

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? ""
