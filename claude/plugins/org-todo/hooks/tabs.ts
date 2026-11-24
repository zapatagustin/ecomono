/**
 * The `files` and `log` tabs of the pane, ported from omp/extensions/ecomono/panel/files.ts and log.ts with the
 * same git commands, rows and keys. The differences are the host's: there is no editor to open a file in from a
 * pane, so enter on a file shows its whole diff in the pane (the Client does that) and enter on a branchless
 * commit says so; there is no node:fs, so an untracked file is read through the Host. Every git command runs at
 * the repository root with a 10 s timeout. Text is drawn as it is here; register.tsx sanitises what it hands the
 * Client.
 */

import type { Detail, DetailLine, Row, Span } from '../types'
import { type Change, type GraphLine, branchTargets, parseGraph, parseNumstat, parseStatus } from './git'

/** What the tabs take from the engine (`$.process.run`, `$.fs`), so the tests run them on fixtures. */
export type Host = {
  cwd: string
  run(argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }>
  stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other'; isLink: boolean }>
  /** The first `length` bytes of a regular file as text; rejects on anything else. */
  read(path: string, length: number): Promise<string>
}

/** What a key does once an item is acted on: `refresh` reloads the tab (its `notice` said first). */
export type Action = { kind: 'none' } | { kind: 'notice'; text: string } | { kind: 'refresh'; notice?: string }

/** A tab as omp's panel/model.ts has it, less the editor and close actions this host cannot take. */
export interface Tab {
  name: string
  /** The strip label with its count once loaded; never a zero that is not known. */
  title(): string
  rows(filter: string): Row[]
  detail(id: string): Detail | undefined
  prefetch?(id: string): Promise<void>
  keys: [string, string][]
  /** What enter does: the tab's `act`, or the detail drawn full-height by the Client. */
  enter: 'act' | 'full'
  act(key: string, id: string): Promise<Action>
  load(): Promise<void>
}

const TIMEOUT_MS = 10_000
/** Lines of an untracked file held as its detail. */
const HEAD_LINES = 40
/** Lines of a diff held as its detail, every hunk: the Client shows what fits, enter shows them all. */
const DIFF_LINES = 400
/** An untracked directory with more files than this is one row. */
const COLLAPSE_OVER = 20
const LIMIT = 200
/** Theme keys the graph lanes cycle through, by lane position. `suggestion` is left out: it marks the current branch. */
const LANES = ['permission', 'success', 'warning', 'merged', 'planMode', 'autoAccept']
const ACCENT = 'suggestion'

/** The engine keeps a run's first 4 MiB of stdout: a parse of more would list a cut output as the whole. */
const TOO_LARGE = 'git output too large (over 4 MiB)'
const CUT = 'output cut at 4 MiB'

const firstLine = (s: string): string => s.split('\n')[0]?.trim() ?? ''
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')

/** The engine's text for a run stopped at its timeout (`aborted: still running after <ms>ms`). Undocumented: read
 *  from engine 2.1.329, so a reworded one would show the raw error until this is updated. */
const STILL_RUNNING = 'still running after'

/** A git command at `cwd` with the timeout. The engine rejects a run still going then (`aborted: still running
 *  after <ms>ms`, no exit code): that one is said as the git command that timed out, any other kept as it is. */
const gitAt = (host: Host, cwd: string, args: string[]) =>
  host.run(['git', ...args], { cwd, timeoutMs: TIMEOUT_MS }).catch((err: unknown) => {
    if (!String(err instanceof Error ? err.message : err).includes(STILL_RUNNING)) throw err
    throw new Error(`git ${args.find(a => !a.startsWith('-'))} timed out (${TIMEOUT_MS / 1000} s)`)
  })

/** The repository's top directory, `git rev-parse --show-toplevel` from the session's cwd: git prints paths
 *  relative to it, so the tabs run every git command there. */
async function repoRoot(host: Host): Promise<string> {
  const r = await gitAt(host, host.cwd, ['rev-parse', '--show-toplevel'])
  const root = r.stdout.replace(/\n$/, '')
  if (r.isStdoutTruncated) throw new Error(TOO_LARGE)
  if (r.exitCode !== 0 || !root) throw new Error(`git rev-parse: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`)
  return root
}

/** The theme key of a status letter: added green, deleted red, modified accent, untracked dim, conflict warning. */
const color = (letter: string): string =>
  letter === 'A' ? 'success' : letter === 'D' ? 'error' : letter === '?' ? 'inactive' : letter === 'U' ? 'warning' : ACCENT

export function filesTab(host: Host): Tab {
  let changes: Change[] = []
  let stats = { staged: new Map<string, { add: number; del: number }>(), unstaged: new Map<string, { add: number; del: number }>() }
  const diffs = new Map<string, Detail>()
  let loaded = false
  let root = host.cwd

  const git = (...args: string[]) => gitAt(host, root, args)
  /** A diff as a detail: every hunk, the first one's header in the title's tail and each later one as a `hunk`
   *  line; lines numbered by the new file, a removed line by the old one. The file headers are dropped by
   *  position, not by prefix, so a removed `-- comment` stays. A diff without a hunk (binary, mode only, pure
   *  rename) is said in one line from its extended headers instead. */
  const diffDetail = (path: string, out: string): Detail => {
    const lines = out.split('\n').filter(l => l !== '')
    const at = lines.findIndex(l => l.startsWith('@@'))
    if (at >= 0) {
      const header = (l: string) => /^@@ [^@]*@@/.exec(l)?.[0] ?? l
      const body: DetailLine[] = []
      let [from, to] = [1, 1]
      for (const [i, l] of lines.slice(at).entries()) {
        if (l.startsWith('@@')) {
          const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
          ;[from, to] = [Number(m?.[1] ?? 1), Number(m?.[2] ?? 1)]
          if (i > 0) body.push({ text: header(l), kind: 'hunk' })
        } else if (l.startsWith('+')) body.push({ text: l, no: to++, kind: 'add' })
        else if (l.startsWith('-')) body.push({ text: l, no: from++, kind: 'del' })
        else if (l.startsWith('\\')) body.push({ text: l })
        else body.push({ text: l, no: (from++, to++) })
      }
      const hidden = body.length - DIFF_LINES
      const detail: Detail = { title: path, tail: header(lines[at]!), lines: body.slice(0, DIFF_LINES) }
      if (hidden > 0) detail.more = `${hidden} more line${hidden > 1 ? 's' : ''}`
      return detail
    }
    const head = (prefix: string) => lines.find(l => l.startsWith(prefix))?.slice(prefix.length)
    const parts: string[] = []
    if (lines.some(l => l.startsWith('Binary files ') || l === 'GIT binary patch')) parts.push('binary file')
    const [oldMode, newMode] = [head('old mode '), head('new mode ')]
    if (oldMode && newMode) parts.push(`mode change ${oldMode} → ${newMode}`)
    const [added, deleted] = [head('new file mode '), head('deleted file mode ')]
    if (added) parts.push(`new file · mode ${added}`)
    if (deleted) parts.push(`deleted file · mode ${deleted}`)
    const renamed = head('rename from ')
    if (renamed) parts.push(`renamed from ${renamed}`)
    return { title: path, lines: parts.length ? [{ text: parts.join(' · ') }] : [] }
  }
  /** An untracked file has no diff: its first lines, or `binary file` when the head holds a NUL. Only a regular
   *  file is read (the Host's ranged read rejects a FIFO without blocking); a symlink or anything else is named
   *  in one line. ecomono: a path swapped for a symlink between the stat and the read is followed, as the
   *  engine's read has no O_NOFOLLOW; the ceiling is a file outside the repository shown read-only in the pane.
   *  Upgrade when `$.fs.read` takes a no-follow option. */
  const headOf = async (path: string): Promise<DetailLine[]> => {
    const st = await host.stat(`${root}/${path}`).catch(() => undefined)
    if (!st) return []
    if (st.isLink) return [{ text: 'symbolic link' }]
    if (st.kind !== 'file') return [{ text: st.kind === 'dir' ? 'directory or nested repository' : 'special file' }]
    const text = await host.read(`${root}/${path}`, 4096).catch(() => undefined)
    if (text === undefined) return []
    if (text.includes('\0')) return [{ text: 'binary file' }]
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.slice(0, HEAD_LINES).map((t, i) => ({ text: t, no: i + 1 }))
  }
  /** The untracked directories shown as one row each, with their file counts. ecomono: only the directory that
   *  directly holds the files counts; fold by ancestor if a build tree of many small subdirectories shows. */
  const bigDirs = (): Map<string, number> => {
    const n = new Map<string, number>()
    for (const c of changes) if (c.untracked && dirname(c.path) !== '.') n.set(dirname(c.path), (n.get(dirname(c.path)) ?? 0) + 1)
    for (const [d, k] of n) if (k <= COLLAPSE_OVER) n.delete(d)
    return n
  }
  const collapsedCount = (path: string): number | undefined => (path.endsWith('/') ? bigDirs().get(path.slice(0, -1)) : undefined)
  /** Rows are `<group>:<path>` so a path staged and unstaged at once has two selectable rows. */
  const id = (group: string, path: string): string => `${group}:${path}`
  const parse = (rowId: string): { group: string; path: string } => {
    const at = rowId.indexOf(':')
    return { group: rowId.slice(0, at), path: rowId.slice(at + 1) }
  }

  const prefetch = async (rowId: string): Promise<void> => {
    const { group, path } = parse(rowId)
    if (group === 'untracked') {
      const n = collapsedCount(path)
      diffs.set(rowId, { title: path, lines: n !== undefined ? [{ text: `${n} untracked files` }] : await headOf(path) })
      return
    }
    // A staged rename is diffed with its old path too: on the new path alone git sees a new file, not a rename.
    const from = group === 'staged' ? changes.find(c => c.path === path)?.from : undefined
    const r = await git('--literal-pathspecs', 'diff', '--no-ext-diff', ...(group === 'staged' ? ['--cached'] : []), '-U2', '--', path, ...(from ? [from] : []))
    if (r.exitCode !== 0) throw new Error(`git diff: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`)
    const detail = diffDetail(path, r.stdout)
    if (r.isStdoutTruncated) detail.more = detail.more ? `${detail.more} · ${CUT}` : CUT
    diffs.set(rowId, detail)
  }

  return {
    name: 'files',
    title: () => (loaded ? `files ${changes.length}` : 'files'),
    rows: filter => {
      const q = filter.toLowerCase()
      const groups: Array<[string, Array<[Change, string]>]> = [
        ['staged', changes.filter(c => c.staged !== '.' && !c.untracked).map(c => [c, c.staged])],
        ['unstaged', changes.filter(c => c.unstaged !== '.' && !c.untracked).map(c => [c, c.unstaged])],
        ['untracked', changes.filter(c => c.untracked).map(c => [c, '?'])],
      ]
      const rows: Row[] = []
      // While a filter is active nothing is collapsed: the folded row would carry the unfiltered count.
      const big = q ? new Map<string, number>() : bigDirs()
      for (const [group, list] of groups) {
        const shown = list.filter(([c]) => !q || c.path.toLowerCase().includes(q))
        if (shown.length === 0) continue
        rows.push({ kind: 'head', text: group, right: String(shown.length) })
        const folded = new Set<string>()
        for (const [c, letter] of shown) {
          const dir = group === 'untracked' ? dirname(c.path) : '.'
          if (big.has(dir)) {
            if (!folded.has(dir)) rows.push({ kind: 'item', text: `? ${dir}/`, right: `${big.get(dir)} files`, id: id(group, `${dir}/`), color: color('?'), cut: 'start' })
            folded.add(dir)
            continue
          }
          const stat = group === 'staged' ? stats.staged.get(c.path) : group === 'unstaged' ? stats.unstaged.get(c.path) : undefined
          rows.push({ kind: 'item', text: `${letter} ${c.path}`, add: stat?.add, del: stat?.del, id: id(group, c.path), color: color(letter), cut: 'start' })
        }
      }
      return rows
    },
    detail: rowId => diffs.get(rowId),
    prefetch,
    // ecomono: no editor opens from a pane (the plugin API has no call for it), so omp's enter (nvim) and d
    // (nvim at the hunk) become the full diff in the pane. Add them back if the API grows an open-in-editor.
    keys: [
      ['enter', 'full diff'],
      ['s', 'stage/unstage'],
    ],
    enter: 'full',
    act: async (key, rowId): Promise<Action> => {
      if (key !== 's') return { kind: 'none' }
      const { group, path } = parse(rowId)
      if (group !== 'staged' && group !== 'unstaged' && group !== 'untracked') return { kind: 'refresh' }
      // A staged rename is two staged entries: unstage the old path with the new one, or its deletion stays staged.
      const from = group === 'staged' ? changes.find(c => c.path === path)?.from : undefined
      // A collapsed row adds exactly the untracked files it stands for, as explicit paths: the directory itself
      // would also stage the tracked changes under it. ecomono: one argument per file, so a directory holding
      // many thousands of untracked files can exceed the argv limit and the add fails with a notice. Upgrade to
      // `--pathspec-from-file=-` with the run's `stdin`.
      const stands = group === 'untracked' && collapsedCount(path) !== undefined ? changes.filter(c => c.untracked && dirname(c.path) === path.slice(0, -1)).map(c => c.path) : [path]
      const r = group === 'staged' ? await git('--literal-pathspecs', 'restore', '--staged', '--', path, ...(from ? [from] : [])) : await git('--literal-pathspecs', 'add', '--', ...stands)
      if (r.exitCode !== 0) return { kind: 'notice', text: `git: ${firstLine(r.stderr) || `exit ${r.exitCode}`}` }
      return { kind: 'refresh' }
    },
    load: async () => {
      root = await repoRoot(host)
      const status = await git('--no-optional-locks', 'status', '--untracked-files=all', '--porcelain=v2', '--branch', '-z')
      if (status.exitCode !== 0) throw new Error(`git status: ${firstLine(status.stderr) || `exit ${status.exitCode}`}`)
      const [unstaged, staged] = await Promise.all([git('diff', '--no-ext-diff', '--numstat', '-z'), git('diff', '--no-ext-diff', '--cached', '--numstat', '-z')])
      const bad = [unstaged, staged].find(r => r.exitCode !== 0)
      if (bad) throw new Error(`git diff: ${firstLine(bad.stderr) || `exit ${bad.exitCode}`}`)
      if (status.isStdoutTruncated || unstaged.isStdoutTruncated || staged.isStdoutTruncated) throw new Error(TOO_LARGE)
      ;({ changes } = parseStatus(status.stdout))
      stats = { staged: parseNumstat(staged.stdout), unstaged: parseNumstat(unstaged.stdout) }
      diffs.clear()
      loaded = true
    },
  }
}

export function logTab(host: Host): Tab {
  let all = true
  let lines: GraphLine[] = []
  const details = new Map<string, Detail>()
  let loaded = false
  let root = host.cwd

  const git = (...args: string[]) => gitAt(host, root, args)
  const commit = (sha: string) => lines.find(l => l.commit?.sha === sha)?.commit
  const name = (r: string) => (r.startsWith('HEAD -> ') ? r.slice('HEAD -> '.length) : r.startsWith('tag: ') ? r.slice('tag: '.length) : r)

  return {
    name: 'log',
    // The load stops at LIMIT, so a full list is a floor, not a total.
    title: () => {
      const n = lines.filter(l => l.commit).length
      return !loaded ? 'log' : `log ${n >= LIMIT ? `${LIMIT}+` : n}${all ? '' : ' ·'}`
    },
    rows: filter => {
      const q = filter.toLowerCase()
      const rows: Row[] = []
      // The sha column lines up across rows: the graph is padded to the widest one. Every graph glyph is one
      // column wide, so its length is its width.
      const graphWidth = Math.max(0, ...lines.map(l => l.graph.length))
      for (const l of lines) {
        if (!l.commit) {
          if (!q) rows.push({ kind: 'head', text: l.graph, spans: laneSpans(l.graph, graphWidth), tight: true })
          continue
        }
        const { sha, refs, subject } = l.commit
        const names = refs.map(name)
        const chips = names.map(r => `[${r}]`)
        const text = `${l.graph} ${sha} ${chips.length ? `${chips.join(' ')} ` : ''}${subject}`
        if (q && !subject.toLowerCase().includes(q) && !sha.includes(q) && !chips.join(' ').toLowerCase().includes(q)) continue
        // A chip takes the color of the lane its commit sits on; the current branch is the accent.
        const lane = LANES[Math.floor(Math.max(0, l.graph.indexOf('●')) / 2) % LANES.length]
        const spans: Span[] = [
          ...laneSpans(l.graph, graphWidth),
          { text: ' ' },
          { text: sha, color: 'inactive' },
          { text: ' ' },
          ...names.flatMap((n, i): Span[] => [{ text: n, color: refs[i]!.startsWith('HEAD -> ') ? ACCENT : lane, chip: true }, { text: ' ' }]),
          { text: subject },
        ]
        rows.push({ kind: 'item', text, id: sha, color: l.commit.head ? ACCENT : undefined, spans })
      }
      return rows
    },
    detail: sha => details.get(sha),
    prefetch: async sha => {
      const r = await git('show', '--no-ext-diff', '--stat=60', '--format=%s%n%an · %ar', sha)
      if (r.exitCode !== 0) throw new Error(`git show: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`)
      // The two format lines by position: an empty subject must not pull the author line into the title.
      const [subject, note] = r.stdout.split('\n')
      const stat = r.stdout.split('\n').slice(2).filter(l => l.trim() !== '')
      const names = (commit(sha)?.refs ?? []).map(name)
      const detail: Detail = { title: sha, tail: names.join(' '), note, lines: [subject, ...stat].filter((t): t is string => t !== undefined && t.trim() !== '').map(text => ({ text })) }
      if (r.isStdoutTruncated) detail.more = CUT
      details.set(sha, detail)
    },
    // ecomono: omp's enter on a branchless commit and d open its first file in nvim; no editor opens from a
    // pane, so that row says it has no branch. Add them back if the plugin API grows an open-in-editor.
    keys: [
      ['enter', 'switch branch'],
      ['a', 'all branches'],
    ],
    enter: 'act',
    act: async (key, sha): Promise<Action> => {
      if (key === 'a') {
        all = !all
        return { kind: 'refresh' }
      }
      const c = commit(sha)
      if (!c) return { kind: 'refresh' }
      if (key !== 'enter') return { kind: 'none' }
      const { local, remote } = branchTargets(c.refs)
      // The row's other local branches are the ones worth switching to; several of them are not guessed between.
      const current = c.refs.find(r => r.startsWith('HEAD -> '))?.slice('HEAD -> '.length)
      const others = local.filter(b => b !== current)
      if (others.length > 1) return { kind: 'notice', text: `git: ${sha} carries several local branches (${others.join(', ')}); this row cannot be switched from the panel` }
      const target = others[0] ?? current
      const r = target ? await git('switch', target) : remote[0] ? await git('switch', '--track', remote[0]) : undefined
      if (!r) return { kind: 'notice', text: `git: ${sha} carries no branch` }
      if (r.exitCode !== 0) return { kind: 'notice', text: `git: ${firstLine(r.stderr) || `exit ${r.exitCode}`}` }
      return { kind: 'refresh' }
    },
    load: async () => {
      root = await repoRoot(host)
      const r = await git('log', '--graph', ...(all ? ['--all'] : []), '--format=%h%x00%D%x00%s', `-n${LIMIT}`)
      if (r.exitCode !== 0) throw new Error(`git log: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`)
      if (r.isStdoutTruncated) throw new Error(TOO_LARGE)
      lines = parseGraph(r.stdout)
      details.clear()
      loaded = true
    },
  }
}

/** A graph prefix as colored runs, one color per lane (git lays lanes two columns apart), padded to `cols`. */
function laneSpans(graph: string, cols: number): Span[] {
  const spans: Span[] = []
  let pos = 0
  for (const ch of graph) {
    const color = ch === ' ' ? undefined : LANES[Math.floor(pos / 2) % LANES.length]
    const last = spans.at(-1)
    if (last && last.color === color) last.text += ch
    else spans.push(color ? { text: ch, color } : { text: ch })
    pos += 1
  }
  if (pos < cols) spans.push({ text: ' '.repeat(cols - pos) })
  return spans
}
