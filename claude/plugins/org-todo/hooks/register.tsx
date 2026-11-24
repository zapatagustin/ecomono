import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, PanelProps, Row, Todo } from '../types'
import { plain } from './git'
import { type Host, type Tab, filesTab, logTab } from './tabs'

const PANE = 'org-todo'
// ecomono: fixed under $HOME; upgrade path is a userConfig option.
const ORG_DIR = 'work/org'
const POLL_MS = 3000

const ORG = /^(\*+) (TODO|BLOCKED) (.*)$/
const MD = /^(\s*[-*] )\[ \] (.*)$/
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

const todos = atom({ plugin: 'org-todo', key: 'todos' } as const, [] as Todo[])
const EMPTY: PanelProps = { tabs: [], tab: 0, rows: [], keys: [], enter: 'act', done: 0 }
const panel = atom({ plugin: 'org-todo', key: 'panel' } as const, EMPTY)
/** What one post may carry: the Client's props are refused past 100,000 characters serialized. */
const ROWS_BUDGET = 68_000
const DETAIL_BUDGET = 24_000
/** A row's text is cut to this many characters on its own cut side: a docked pane is at most 45% of a terminal. */
const ROW_CHARS = 200

// The one rule for what a line means as a todo. parse() lists todos with it and
// complete() re-checks the line with it, so the two cannot disagree.
function classify(rawLine: string): Pick<Todo, 'text' | 'kind'> | null {
  // A TAB becomes one space; the other C0, DEL and C1 bytes are dropped: the text drawn is the text complete() compares.
  const raw = rawLine.replace(/\t/g, ' ').replace(CONTROL, '')
  const org = ORG.exec(raw)
  const md = org ? null : MD.exec(raw)
  if (!org && !md) return null
  const text = org ? (org[2] === 'BLOCKED' ? `BLOCKED: ${org[3]}` : org[3]) : md![2]
  return { text: text.trim(), kind: org ? 'org' : 'md' }
}

// True only if `cur` (the line as it is on disk now) is still the todo `t`
// that was listed. Line numbers alone are not identity: the list is up to
// POLL_MS stale, and an insert or delete above shifts a neighbouring todo into
// `t.line`.
export function isSameTodo(cur: string, t: Pick<Todo, 'text' | 'kind'>): boolean {
  const now = classify(cur)
  return now !== null && now.kind === t.kind && now.text === t.text
}

export function parse(stdout: string, roots: readonly string[]): Todo[] {
  const out: Todo[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line)
    if (!m) continue
    const [, file, n, raw] = m
    const c = classify(raw)
    if (!c) continue
    const root = roots.find(r => file.startsWith(r + '/')) ?? ''
    out.push({
      file,
      line: Number(n),
      ...c,
      src: root ? file.slice(root.length + 1) : file,
    })
  }
  return out
}

async function roots($: EngineInterface, cwd: string) {
  const home = (await $.env.get('HOME')) ?? ''
  return [`${cwd}/docs`, `${home}/${ORG_DIR}`]
}

// ecomono: one grep per poll instead of stat+read per file; 100+ org files stay cheap.
async function scan($: EngineInterface, cwd: string): Promise<Todo[]> {
  const dirs = await roots($, cwd)
  const run = await $.process.run([
    'grep', '-rnHsE', '--include=*.org', '--include=*.md',
    '^\\*+ (TODO|BLOCKED) |^[[:space:]]*[-*] \\[ \\] ',
    ...dirs,
  ])
  // A list cut at the stream cap would be a partial todo list read as the whole.
  if (run.isStdoutTruncated) throw new Error('grep output too large (over 4 MiB)')
  return parse(run.stdout, dirs)
}

async function refresh($: EngineInterface, cwd: string): Promise<Todo[]> {
  const next = await scan($, cwd)
  const prev = await read($, todos)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, todos, () => next)
  return next
}

async function complete($: EngineInterface, t: Todo, cwd: string) {
  const text = await $.fs.read(t.file)
  const lines = text.split('\n')
  const cur = lines[t.line - 1] ?? ''
  if (!isSameTodo(cur, t)) {
    // The file moved under us; never write a line that is not the todo listed.
    $.ui.toast('Todo changed on disk, rescanned')
    return refresh($, cwd)
  }
  lines[t.line - 1] = t.kind === 'org' ? cur.replace(ORG, '$1 DONE $3') : cur.replace(MD, '$1[x] $2')
  await $.fs.write(t.file, lines.join('\n'))
  return refresh($, cwd)
}

/**
 * The `todo` tab, as omp's org-todo.ts draws it: rows grouped by source file with their counts, enter marks one
 * done (complete() re-checks the line and rescans). Its detail is the todo's own line; omp's `e` (open in the
 * editor) has no counterpart, as no editor opens from a pane.
 */
function todoTab(list: () => Todo[], rescan: () => Promise<unknown>, done: (t: Todo) => Promise<unknown>): Tab {
  const byId = (id: string) => list().find(t => `${t.file}:${t.line}` === id)
  return {
    name: 'todo',
    title: () => `todo ${list().length}`,
    rows: filter => {
      const q = filter.toLowerCase()
      const rows: Row[] = []
      let last: string | undefined
      for (const t of list()) {
        if (q && !t.text.toLowerCase().includes(q) && !t.src.toLowerCase().includes(q)) continue
        if (t.src !== last) {
          last = t.src
          rows.push({ kind: 'head', text: t.src, right: String(list().filter(x => x.src === t.src).length) })
        }
        rows.push({ kind: 'item', text: `○ ${t.text}`, right: `:${t.line}`, id: `${t.file}:${t.line}` })
      }
      return rows
    },
    detail: id => {
      const t = byId(id)
      return t && { title: `${t.file}:${t.line}`, lines: [{ no: t.line, text: t.kind === 'org' ? `* TODO ${t.text}` : `- [ ] ${t.text}`, kind: 'hit' }] }
    },
    keys: [['enter', 'done']],
    enter: 'act',
    act: async (_key, id) => {
      const t = byId(id)
      // complete() rescans either way, so the pane only has to redraw.
      await (t ? done(t) : rescan())
      return { kind: 'none' }
    },
    load: async () => void (await rescan()),
  }
}

/** The longest head of `list` whose JSON fits `budget` characters. */
function within<T>(list: T[], budget: number): T[] {
  let used = 0
  const at = list.findIndex(x => (used += JSON.stringify(x).length + 1) > budget)
  return at === -1 ? list : list.slice(0, at)
}

/** The props with every text that came from a file or git made safe to draw (plain()), cut to what a post
 *  carries. ecomono: rows past ROWS_BUDGET are dropped with a note to filter; the ceiling is a tree with
 *  thousands of changes not listed whole. Upgrade by sending a window of rows around the selection. */
function sanitise(p: PanelProps): PanelProps {
  const cut = (t: string, start?: boolean) => (t.length <= ROW_CHARS ? t : start ? `${t.slice(0, 2)}…${t.slice(-(ROW_CHARS - 3))}` : `${t.slice(0, ROW_CHARS - 1)}…`)
  const row = (r: Row): Row => ({
    ...r,
    text: cut(plain(r.text), r.cut === 'start'),
    ...(r.right !== undefined && { right: plain(r.right) }),
    ...(r.spans && { spans: r.spans.map(x => ({ ...x, text: plain(x.text) })) }),
  })
  const rows = within(p.rows.map(row), ROWS_BUDGET)
  if (rows.length < p.rows.length) rows.push({ kind: 'head', text: `${p.rows.length - rows.length} more rows: filter with / to narrow` })
  let detail: Detail | undefined
  if (p.detail) {
    const lines = within(p.detail.lines.map(l => ({ ...l, text: plain(l.text) })), DETAIL_BUDGET)
    const cut = p.detail.lines.length - lines.length
    const more = [cut > 0 ? `${cut} more lines` : '', p.detail.more ? plain(p.detail.more) : ''].filter(Boolean).join(' · ')
    detail = { title: plain(p.detail.title), lines }
    if (p.detail.tail) detail.tail = plain(p.detail.tail)
    if (p.detail.note) detail.note = plain(p.detail.note)
    if (more) detail.more = more
  }
  return {
    ...p,
    tabs: p.tabs.map(t => ({ ...t, title: plain(t.title) })),
    rows,
    detail,
    ...(p.failed !== undefined && { failed: plain(p.failed) }),
  }
}

type View = { tab: number; filter: string; id?: string }
type Act = { tab: number; key: string; id: string; seq: number }

/** The pane's session: the tabs, what the Client last asked, and the work drain() still has to do. */
type PanelSession = {
  tabs: Tab[]
  /** Why each tab's last load failed; undefined once one works. */
  failed: (string | undefined)[]
  /** The view the Client last posted, its selection resolved to a row (`id`) by settle(). */
  view: View
  /** Where the selection was among the items, so a row that leaves (a file staged) selects its neighbour. */
  lastAt: number
  /** The last act finished, by the Client's sequence number: the Client takes no key until it is. */
  done: number
  /** The details asked for since the last load, by `<tab>:<id>`: a prefetch that fails is not retried each poll. */
  fetched: Set<string>
  // The work the Client's posts and the poll ask for, done one at a time by drain(): two git loads of one tab
  // never overlap, and the newest view wins over one not yet applied.
  wanted?: View
  acts: Act[]
  stale: Set<number>
  /** The loop doing that work, while it runs: every caller waits for the same one. */
  draining?: Promise<void>
}

function say($: EngineInterface, text: string) {
  $.ui.toast(plain(text))
}

async function load(ps: PanelSession, i: number) {
  ps.fetched.clear()
  try {
    await ps.tabs[i]!.load()
    ps.failed[i] = undefined
  } catch (err) {
    ps.failed[i] = err instanceof Error ? err.message : String(err)
  }
}

/** Resolves the selection, loads its detail, and hands the Client what it draws. */
async function settle($: EngineInterface, ps: PanelSession) {
  const tab = ps.tabs[ps.view.tab]!
  const failed = ps.failed[ps.view.tab]
  const rows = failed === undefined ? tab.rows(ps.view.filter) : []
  const items = rows.filter(r => r.kind === 'item')
  const pick = items.find(r => r.id === ps.view.id) ?? items[Math.min(ps.lastAt, items.length - 1)]
  ps.lastAt = pick ? items.indexOf(pick) : 0
  ps.view = { ...ps.view, id: pick?.id }
  const id = ps.view.id
  if (id !== undefined && tab.prefetch && !ps.fetched.has(`${ps.view.tab}:${id}`)) {
    ps.fetched.add(`${ps.view.tab}:${id}`)
    try {
      await tab.prefetch(id)
    } catch (err) {
      say($, `panel: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const next = sanitise({
    tabs: ps.tabs.map((t, i) => ({ title: t.title(), lost: ps.failed[i] !== undefined })),
    tab: ps.view.tab,
    rows,
    ...(id !== undefined && { id, detail: tab.detail(id) }),
    keys: tab.keys,
    enter: tab.enter,
    ...(failed !== undefined && { failed }),
    done: ps.done,
  })
  const prev = await read($, panel)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, panel, () => next)
}

async function runAct($: EngineInterface, ps: PanelSession, a: Act) {
  try {
    const result = await ps.tabs[a.tab]!.act(a.key, a.id)
    if (result.kind === 'notice') say($, result.text)
    if (result.kind === 'refresh') {
      if (result.notice) say($, result.notice)
      await load(ps, a.tab)
    }
  } catch (err) {
    say($, `panel: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    ps.done = Math.max(ps.done, a.seq)
  }
}

function drain($: EngineInterface, ps: PanelSession): Promise<void> {
  ps.draining ??= drainLoop($, ps)
  return ps.draining
}

async function drainLoop($: EngineInterface, ps: PanelSession) {
  // Yield first, so `ps.draining` holds this loop before its `finally` can clear it; the clear then runs in the
  // same step as the last check for work, so no work is left behind a loop that has ended.
  await undefined
  try {
    while (ps.wanted || ps.acts.length || ps.stale.size) {
      const a = ps.acts.shift()
      if (a) await runAct($, ps, a)
      if (ps.wanted) {
        // A tab becoming active is loaded again, as omp's panel does.
        if (ps.wanted.tab !== ps.view.tab) ps.stale.add(ps.wanted.tab)
        ps.view = ps.wanted
        ps.wanted = undefined
      }
      for (const i of [...ps.stale]) {
        ps.stale.delete(i)
        await load(ps, i)
      }
      await settle($, ps)
    }
  } finally {
    ps.draining = undefined
  }
}

export const register: Register = on => {
  let cwd = ''
  let shown: Todo[] = []
  const ps: PanelSession = { tabs: [], failed: [], view: { tab: 0, filter: '' }, lastAt: 0, done: 0, fetched: new Set(), acts: [], stale: new Set() }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const host: Host = {
      cwd,
      run: (argv, init) => $.process.run(argv, init),
      stat: path => $.fs.stat(path),
      read: async (path, length) => String(await $.fs.read(path, { length })),
    }
    const rescan = async () => void (shown = await refresh($, cwd))
    ps.tabs = [todoTab(() => shown, rescan, t => complete($, t, cwd).then(list => void (shown = list))), filesTab(host), logTab(host)]
    // A reload starts this module over while the Client keeps its count of acts: carry on from the last one.
    ps.done = (await read($, panel)).done
    await $.command.register({ name: 'org-todo', description: 'Open the todo and git pane (todo, files, log)' })
    void $.ui.open({ id: PANE, title: 'Todo' })
    ps.tabs.forEach((_, i) => ps.stale.add(i))
    void drain($, ps)
    // ecomono: the active git tab is re-read on every tick while the pane is shown (open, placed and the one
    // drawn; `$.ui.panes()`), as the pane stays open beside the chat while files change; `--no-optional-locks`
    // keeps git status off the index lock. The ceiling is a large repository's status every POLL_MS; upgrade to
    // reloading on tool.call results and on tab activation only.
    // A refresh that keeps failing toasts once, not on every tick; a success re-arms it.
    let refreshFailed: string | undefined
    $.clock.every(POLL_MS, async () => {
      try {
        shown = await refresh($, cwd)
        refreshFailed = undefined
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg !== refreshFailed) say($, `panel: ${msg}`)
        refreshFailed = msg
      }
      // A failed panes() counts as the pane not shown for this tick, so the drain below still runs.
      if (ps.view.tab !== 0 && (await $.ui.panes().then(list => list.some(p => p.id === PANE && p.isPlaced && p.isShown)).catch(() => false))) ps.stale.add(ps.view.tab)
      void drain($, ps)
    })

    return next(e)
  })

  on('command.run', { command: 'org-todo' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Todo', focus: true })

    return { text: 'Todo pane opened.' }
  })

  // What the Client posts is code's word, not the person's: every field is checked before it is used.
  on('ui.message', async ($, e, next) => {
    const data = (e.data ?? {}) as { view?: { tab?: unknown; filter?: unknown; id?: unknown }; act?: { key?: unknown; id?: unknown; seq?: unknown } }
    const v = data.view
    if (!v || !Number.isInteger(v.tab) || (v.tab as number) < 0 || (v.tab as number) >= ps.tabs.length || typeof v.filter !== 'string' || v.filter.length > 256) return next(e)
    if (v.id !== null && v.id !== undefined && typeof v.id !== 'string') return next(e)
    const tab = v.tab as number
    ps.wanted = { tab, filter: v.filter, ...(typeof v.id === 'string' && { id: v.id }) }
    const a = data.act
    if (a && typeof a.key === 'string' && typeof a.id === 'string' && Number.isInteger(a.seq)) {
      const known = ps.tabs[tab]!.keys.some(([k]) => k === a.key) && !(a.key === 'enter' && ps.tabs[tab]!.enter !== 'act')
      if (known) ps.acts.push({ tab, key: a.key, id: a.id, seq: a.seq as number })
      else ps.done = Math.max(ps.done, a.seq as number)
    }
    // Awaited, so the post settles once its work is drawn; a post that arrives meanwhile joins the loop running.
    await drain($, ps)
    return next(e)
  })

  // A Client that fails falls back to the todo list drawn with Buttons, as on a surface without Client.
  let clientFailed = false
  on('ui.fault', ($, e, next) => {
    clientFailed = true
    $.ui.log(`org-todo: the pane fell back to the todo list: ${e.reason}`)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    // The element table lists Client on every surface at runtime; `mobile` and `vscode` draw none.
    if ('Client' in elements && !clientFailed && e.surface !== 'mobile' && e.surface !== 'vscode') {
      const { Client } = elements
      return <Client key="panel" module="./panel.tsx" props={await read($, panel)} width="100%" height={Math.max(1, e.props.scroll.bodyRows)} />
    }
    const { Box, Text, Button } = elements
    const list = await read($, todos)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 2)

    return (
      <Box flexDirection="column">
        <Text dimColor>{list.length === 0 ? 'No pending todos.' : `${list.length} pending`}</Text>
        {list.slice(0, room).map((t, i) => (
          <Box flexDirection="row">
            <Button
              key={`todo-${i}`}
              hotkey={i < 9 ? String(i + 1) : undefined}
              label="[ ]"
              onPress={() => void complete($, t, cwd).catch(err => say($, `panel: ${err instanceof Error ? err.message : String(err)}`))}
            />
            <Text> {t.text} </Text>
            <Text dimColor>{plain(t.src)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
