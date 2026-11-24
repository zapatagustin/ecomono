/**
 * The `log` tab of the side panel: the commit graph (`git log --graph`) redrawn with box glyphs, a branch chip
 * on the row of the commit it points to, the selected commit's stat as the detail. enter on a row with a local
 * branch switches to it (git refuses a conflicting dirty tree; the notice carries its reason), on a remote-only
 * row creates the tracking branch, on a plain commit opens its first changed file in the editor. a toggles
 * --all. One `git log` per load; the detail is one `git show --stat` per selected commit (prefetch), cached
 * until the next load. Every git command runs at the repository root, where git's paths are relative to.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { type GraphLine, branchTargets, parseGraph, repoRoot } from "./git.ts"
import type { Action, Detail, Host, Row, Span, Tab } from "./model.ts"
import { width } from "./text.ts"

const LIMIT = 200
/** Theme colors the graph lanes cycle through, by lane position. `accent` is left out: it marks the current branch. */
const LANES = ["mdLink", "success", "warning", "syntaxKeyword", "syntaxType", "syntaxString"]

export function logTab(host: Host): Tab {
  let all = true
  let lines: GraphLine[] = []
  const details = new Map<string, Detail>()
  /** False until the first load worked: the strip shows no count before that, never a zero that is not known. */
  let loaded = false

  let root = host.cwd

  const git = (...args: string[]) => host.exec("git", args, { timeout: 10_000, cwd: root })
  const commit = (sha: string) => lines.find((l) => l.commit?.sha === sha)?.commit

  return {
    name: "log",
    // The load stops at LIMIT, so a full list is a floor, not a total.
    title: () => {
      const n = lines.filter((l) => l.commit).length
      return !loaded ? "log" : `log ${n >= LIMIT ? `${LIMIT}+` : n}${all ? "" : " ·"}`
    },
    rows: (filter) => {
      const q = filter.toLowerCase()
      const rows: Row[] = []
      // The sha column lines up across rows: the graph is padded to the widest one (filtered-out rows included).
      const graphWidth = Math.max(0, ...lines.map((l) => width(l.graph)))
      for (const l of lines) {
        if (!l.commit) {
          if (!q) rows.push({ kind: "head", text: l.graph, spans: laneSpans(l.graph, graphWidth), tight: true })
          continue
        }
        const { sha, refs, subject } = l.commit
        const names = refs.map((r) => (r.startsWith("HEAD -> ") ? r.slice("HEAD -> ".length) : r.startsWith("tag: ") ? r.slice("tag: ".length) : r))
        const chips = names.map((r) => `[${r}]`)
        const text = `${l.graph} ${sha} ${chips.length ? `${chips.join(" ")} ` : ""}${subject}`
        if (q && !subject.toLowerCase().includes(q) && !sha.includes(q) && !chips.join(" ").toLowerCase().includes(q)) continue
        // A chip takes the color of the lane its commit sits on; the current branch is the accent.
        const lane = LANES[Math.floor(Math.max(0, l.graph.indexOf("●")) / 2) % LANES.length]!
        const spans: Span[] = [
          ...laneSpans(l.graph, graphWidth),
          { text: " " },
          { text: sha, color: "muted" },
          { text: " " },
          ...names.flatMap((n, i): Span[] => [{ text: n, color: refs[i]!.startsWith("HEAD -> ") ? "accent" : lane, chip: true }, { text: " " }]),
          { text: subject },
        ]
        rows.push({ kind: "item", text, id: sha, color: l.commit.head ? "accent" : undefined, spans })
      }
      return rows
    },
    detail: (sha) => details.get(sha),
    prefetch: async (sha) => {
      const r = await git("show", "--no-ext-diff", "--stat=60", "--format=%s%n%an · %ar", sha)
      // The two format lines by position: an empty subject must not pull the author line into the title.
      const [subject, note] = r.stdout.split("\n")
      const stat = r.stdout.split("\n").slice(2).filter((l) => l.trim() !== "")
      const names = (commit(sha)?.refs ?? []).map((x) => (x.startsWith("HEAD -> ") ? x.slice("HEAD -> ".length) : x.startsWith("tag: ") ? x.slice("tag: ".length) : x))
      details.set(sha, { title: sha, tail: names.join(" "), note, lines: [subject, ...stat].filter((t): t is string => t !== undefined && t.trim() !== "").map((text) => ({ text })) })
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
        const names = r.stdout.split("\0").filter((l) => l.trim() !== "")
        if (names.length === 0) return { kind: "notice", text: `git: ${sha} changes no file` }
        // The first file the commit changed may be a deletion: open the first one the working tree still has.
        const file = names.find((n) => existsSync(join(root, n)))
        if (!file) return { kind: "notice", text: `git: ${sha} changes no file that exists now` }
        await host.openEditor(join(root, file), 1)
        return { kind: "close" }
      }
      if (key === "enter") {
        // The row's other local branches are the ones worth switching to; several of them are not guessed between.
        const current = c.refs.find((r) => r.startsWith("HEAD -> "))?.slice("HEAD -> ".length)
        const others = local.filter((b) => b !== current)
        if (others.length > 1) return { kind: "notice", text: `git: ${sha} carries several local branches (${others.join(", ")}); this row cannot be switched from the panel` }
        const target = others[0] ?? current
        const r = target ? await git("switch", target) : remote[0] ? await git("switch", "--track", remote[0]) : undefined
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
      loaded = true
    },
  }
}

/** A graph prefix as colored runs, one color per lane (git lays lanes two columns apart), padded to `cols`. A
 *  glyph keeps its own lane's color, so no lane is ever drawn in another's. */
function laneSpans(graph: string, cols: number): Span[] {
  const spans: Span[] = []
  let pos = 0
  for (const { segment } of new Intl.Segmenter().segment(graph)) {
    const color = segment === " " ? undefined : LANES[Math.floor(pos / 2) % LANES.length]
    const last = spans.at(-1)
    if (last && last.color === color) last.text += segment
    else spans.push({ text: segment, color })
    pos += width(segment)
  }
  if (pos < cols) spans.push({ text: " ".repeat(cols - pos) })
  return spans
}

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? ""
