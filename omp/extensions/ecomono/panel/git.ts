import type { Host } from "./model.ts"

/**
 * Parsers for what the side panel asks git (panel/files.ts, panel/log.ts). Pure: no process, no fs, so
 * omp/tests/test_panel_git.ts feeds them the line shapes git prints. The one exception is `repoRoot`, which
 * runs through the Host it is given.
 */

/** The repository's top directory, `git rev-parse --show-toplevel` from `host.cwd`. git prints paths relative to
 *  it (and `status` to its own cwd): the tabs run every git command there and join the paths to it. */
export async function repoRoot(host: Host): Promise<string> {
  const r = await host.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 10_000 })
  const root = r.stdout.replace(/\n$/, "")
  if (r.code !== 0 || !root) throw new Error(`git rev-parse: ${r.stderr.split("\n")[0]?.trim() || `exit ${r.code}`}`)
  return root
}

/** One working-tree entry of `git status --porcelain=v2 --branch`: XY as two fields, a rename keeps its old name. */
export type Change = { path: string; staged: string; unstaged: string; untracked: boolean; from?: string }

/**
 * `git status --porcelain=v2 --branch -z`: NUL-terminated records, paths verbatim (no C-quoting, newlines and
 * spaces intact). Record shapes (git-status(1)): `# branch.head <name>`; ordinary
 * `1 XY sub mH mI mW hH hI <path>`; rename `2 XY sub mH mI mW hH hI Xscore <new>` whose old name is the NEXT
 * NUL field; unmerged `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`; untracked `? <path>`; ignored `! <path>` (dropped).
 * The path is the remainder after a fixed count of space-separated fields. Paths are relative to the directory
 * git ran in (the repo root, for panel/files.ts).
 */
export function parseStatus(porcelainV2: string): { branch: string; changes: Change[] } {
  let branch = ""
  const changes: Change[] = []
  const records = porcelainV2.split("\0")
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (rec.startsWith("# branch.head ")) branch = rec.slice("# branch.head ".length)
    else if (rec.startsWith("? ")) changes.push({ path: rec.slice(2), staged: ".", unstaged: ".", untracked: true })
    else if (rec.startsWith("1 ") || rec.startsWith("u ")) {
      changes.push({ path: afterFields(rec, rec.startsWith("1 ") ? 8 : 10), staged: rec[2]!, unstaged: rec[3]!, untracked: false })
    } else if (rec.startsWith("2 ")) {
      changes.push({ path: afterFields(rec, 9), staged: rec[2]!, unstaged: rec[3]!, untracked: false, from: records[++i] })
    }
  }
  return { branch, changes }
}

/** The text after the first `n` space-separated fields of `line`. */
const afterFields = (line: string, n: number): string => {
  let i = 0
  for (let k = 0; k < n; k++) i = line.indexOf(" ", i) + 1
  return line.slice(i)
}

/**
 * `git diff --numstat -z`: `<add>\t<del>\t<path>\0`; a binary file is `-\t-` (0/0 here); a rename is
 * `<add>\t<del>\t\0<old>\0<new>\0` (the path field empty, two NUL fields after it), keyed by the new name.
 */
export function parseNumstat(out: string): Map<string, { add: number; del: number }> {
  const stats = new Map<string, { add: number; del: number }>()
  const records = out.split("\0")
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    const t1 = rec.indexOf("\t")
    const t2 = rec.indexOf("\t", t1 + 1)
    if (t1 === -1 || t2 === -1) continue
    const path = rec.slice(t2 + 1)
    const key = path === "" ? (i += 2, records[i]) : path
    if (key !== undefined) stats.set(key, { add: Number(rec.slice(0, t1)) || 0, del: Number(rec.slice(t1 + 1, t2)) || 0 })
  }
  return stats
}

export type Commit = { sha: string; refs: string[]; subject: string; head: boolean }
export type GraphLine = { graph: string; commit?: Commit }

/**
 * `git log --graph --format=%h%x00%D%x00%s`: git's graph prefix sits on the line before the NUL-separated
 * fields; a line without a NUL is graph only. The graph is redrawn with the box glyphs PxPlus IBM VGA8 has:
 * `*` ● (the commit), `|` │, `_` and `-` ─, `\` opens a lane (┐, or ┤ after a bar), `/` closes one (┘, or ├
 * before a bar). git's own padding after the marker stays, so the column width is git's.
 */
export function parseGraph(out: string): GraphLine[] {
  const lines: GraphLine[] = []
  for (const line of out.split("\n")) {
    if (line === "") continue
    const nul = line.indexOf("\0")
    if (nul === -1) {
      lines.push({ graph: glyphs(line) })
      continue
    }
    const [shaPart, refs, subject] = line.slice(0, nul).concat("\0", line.slice(nul + 1)).split("\0")
    // The sha is the last word of the prefix; what precedes it (and the spaces git pads after `*`) is the graph.
    const sha = shaPart!.slice(shaPart!.lastIndexOf(" ") + 1)
    const graph = glyphs(shaPart!.slice(0, shaPart!.length - sha.length).replace(/ $/, ""))
    const refList = refs ? refs.split(", ") : []
    lines.push({ graph, commit: { sha, refs: refList, subject: subject ?? "", head: refList.some((r) => r.startsWith("HEAD -> ")) } })
  }
  return lines
}

const glyphs = (prefix: string): string => {
  const out: string[] = []
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]!
    const prev = prefix[i - 1]
    const next = prefix[i + 1]
    if (c === "*") out.push("●")
    else if (c === "|") out.push("│")
    else if (c === "_" || c === "-") out.push("─")
    else if (c === "\\") {
      // A lane opening to the right: the bar before it forks (├), the diagonal is the corner (┐).
      if (prev === "|") out[out.length - 1] = "├"
      out.push(next === "|" ? "┤" : "┐")
    } else if (c === "/") {
      // A lane closing to the left: the bar before it takes the join (├), the diagonal ends the lane (┘).
      if (prev === "|") out[out.length - 1] = "├"
      out.push("┘")
    } else out.push(c)
  }
  return out.join("")
}

/** The branches a commit's refs name: `HEAD -> x` and `x` are local, `origin/x` remote; tags, a bare `HEAD`
 *  (detached), `refs/*` (the stash) and `origin/HEAD` are neither. */
export function branchTargets(refs: string[]): { local: string[]; remote: string[] } {
  const local: string[] = []
  const remote: string[] = []
  for (const raw of refs) {
    const ref = raw.startsWith("HEAD -> ") ? raw.slice("HEAD -> ".length) : raw
    if (ref.startsWith("tag: ") || ref.startsWith("refs/") || ref === "HEAD" || ref.endsWith("/HEAD")) continue
    if (ref.includes("/") && /^[^/]+\//.test(ref) && isRemote(ref)) remote.push(ref)
    else local.push(ref)
  }
  return { local, remote }
}

/** ecomono: a remote ref is `<remote>/<branch>` with `origin` the only remote this repo set uses. Pass the remote
 *  list in (git remote) if a local branch named `origin/x` or a second remote ever appears. */
const isRemote = (ref: string): boolean => ref.startsWith("origin/")
