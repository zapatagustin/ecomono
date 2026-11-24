import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

import { branchTargets, parseGraph, parseNumstat, parseStatus, plain } from './git'
import { filesTab, logTab } from './tabs'
import type { Host } from './tabs'

const H = '0000000000000000000000000000000000000000'
const N = '\0'

const STATUS = [
  `# branch.oid ${H}`,
  '# branch.head master',
  `1 MM N... 100644 100644 100644 ${H} ${H} both.ts`,
  `1 .M N... 100644 100644 100644 ${H} ${H} dir with space/un staged.md`,
  `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts${N}old => name.ts`,
  `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
  '? untracked/new.ts',
  '! ignored.log',
  '',
].join(N)
const NUMSTAT_STAGED = ['4\t1\tboth.ts', `0\t0\t${N}old => name.ts${N}new name.ts`, ''].join(N)
const NUMSTAT_UNSTAGED = ['2\t0\tboth.ts', '0\t3\tdir with space/un staged.md', '1\t1\tconflict.ts', ''].join(N)
const LOG = [
  `* 18ace7a${N}HEAD -> master, origin/master, origin/HEAD${N}chore: tip`,
  `| *   6690559${N}feat, fix${N}merge two`,
  '| |\\',
  `| | * 741a467${N}origin/only-remote${N}remote work`,
  '| |/',
  '|/',
  `* 0d82ddc${N}tag: v1${N}plain commit`,
  '',
].join('\n')

type Call = { argv: string[]; cwd?: string; timeoutMs?: number }

/** What the engine rejects a run with when it is still running at its timeout (Claude Code 2.1.329). */
const STILL_RUNNING = '$.process.run (org-todo): git: aborted: still running after 10000ms'

/** A Host whose git answers by argv prefix (the arguments after `git`), recording every call. */
function fakeHost(answers: Array<[string, string]>, fail: Record<string, string> = {}, truncated: string[] = [], timedOut: string[] = []) {
  const calls: Call[] = []
  const host: Host = {
    cwd: '/repo/sub',
    run: async (argv, init) => {
      calls.push({ argv: [...argv], cwd: init?.cwd, timeoutMs: init?.timeoutMs })
      const args = argv.slice(1).join(' ')
      if (timedOut.some(k => args.startsWith(k))) throw new Error(STILL_RUNNING)
      const failed = Object.keys(fail).find(k => args.startsWith(k))
      if (failed) return { exitCode: 1, stdout: '', stderr: `${fail[failed]}\nmore` }
      return { exitCode: 0, stdout: answers.find(([k]) => args.startsWith(k))?.[1] ?? '', stderr: '', isStdoutTruncated: truncated.some(k => args.startsWith(k)) }
    },
    stat: async () => ({ kind: 'file', isLink: false }),
    read: async () => 'first line\nsecond\n',
  }
  return { host, calls }
}

const gitAnswers: Array<[string, string]> = [
  ['rev-parse --show-toplevel', '/repo\n'],
  ['--no-optional-locks status', STATUS],
  ['diff --no-ext-diff --cached --numstat -z', NUMSTAT_STAGED],
  ['diff --no-ext-diff --numstat -z', NUMSTAT_UNSTAGED],
  ['log --graph', LOG],
]

test('the copied parsers read status (rename, untracked, conflict), numstat (rename) and a merge graph', async () => {
  const { branch, changes } = parseStatus(STATUS)
  expect(branch).toBe('master')
  expect(changes).toEqual([
    { path: 'both.ts', staged: 'M', unstaged: 'M', untracked: false },
    { path: 'dir with space/un staged.md', staged: '.', unstaged: 'M', untracked: false },
    { path: 'new name.ts', staged: 'R', unstaged: '.', untracked: false, from: 'old => name.ts' },
    { path: 'conflict.ts', staged: 'U', unstaged: 'U', untracked: false },
    { path: 'untracked/new.ts', staged: '.', unstaged: '.', untracked: true },
  ])
  const staged = parseNumstat(NUMSTAT_STAGED)
  expect(staged.get('new name.ts')).toEqual({ add: 0, del: 0 })
  expect(staged.has('old => name.ts')).toBe(false)
  expect(staged.get('both.ts')).toEqual({ add: 4, del: 1 })
  const lines = parseGraph(LOG)
  expect(lines.map(l => l.graph)).toEqual(['●', '│ ●  ', '│ ├┐', '│ │ ●', '│ ├┘', '├┘', '●'])
  expect(lines[1]!.commit).toEqual({ sha: '6690559', refs: ['feat', 'fix'], subject: 'merge two', head: false })
  expect(branchTargets(lines[0]!.commit!.refs)).toEqual({ local: ['master'], remote: ['origin/master'] })
})

test('plain strips escape sequences and control bytes, and flattens newlines and tabs', async () => {
  expect(plain('a\x1b[31mred\x1b[0m\x07b')).toBe('aredb')
  expect(plain('line\nbreak\r')).toBe('line break')
  expect(plain('a\tb\x9b')).toBe('a  b')
})

test('the files tab groups staged, unstaged and untracked with counts and +/- stats, at the repo root', async () => {
  const { host, calls } = fakeHost(gitAnswers)
  const tab = filesTab(host)
  expect(tab.title()).toBe('files')
  await tab.load()
  expect(tab.title()).toBe('files 5')
  const rows = tab.rows('')
  expect(rows.map(r => [r.kind, r.text, r.right, r.add, r.del])).toEqual([
    ['head', 'staged', '3', undefined, undefined],
    ['item', 'M both.ts', undefined, 4, 1],
    ['item', 'R new name.ts', undefined, 0, 0],
    ['item', 'U conflict.ts', undefined, undefined, undefined],
    ['head', 'unstaged', '3', undefined, undefined],
    ['item', 'M both.ts', undefined, 2, 0],
    ['item', 'M dir with space/un staged.md', undefined, 0, 3],
    ['item', 'U conflict.ts', undefined, 1, 1],
    ['head', 'untracked', '1', undefined, undefined],
    ['item', '? untracked/new.ts', undefined, undefined, undefined],
  ])
  expect(rows.filter(r => r.kind === 'item').every(r => r.cut === 'start')).toBe(true)
  // The filter narrows the rows and the head counts with them.
  expect(tab.rows('UN STAGED').map(r => r.text)).toEqual(['unstaged', 'M dir with space/un staged.md'])
  // Every git command ran at the repository root with a 10 s timeout, with omp's exact flags.
  expect(calls.slice(1).every(c => c.cwd === '/repo' && c.timeoutMs === 10_000)).toBe(true)
  expect(calls[0]).toEqual({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: '/repo/sub', timeoutMs: 10_000 })
  expect(calls[1]!.argv).toEqual(['git', '--no-optional-locks', 'status', '--untracked-files=all', '--porcelain=v2', '--branch', '-z'])
})

test('s stages an unstaged or untracked file and unstages a staged one, a rename with both its paths', async () => {
  const { host, calls } = fakeHost(gitAnswers)
  const tab = filesTab(host)
  await tab.load()
  const id = (text: string, head: string) => {
    const rows = tab.rows('')
    const from = rows.findIndex(r => r.kind === 'head' && r.text === head)
    return rows.slice(from).find(r => r.text === text)!.id!
  }
  const argvOf = async (rowId: string) => {
    calls.length = 0
    expect(await tab.act('s', rowId)).toEqual({ kind: 'refresh' })
    return calls[0]!
  }
  expect(await argvOf(id('R new name.ts', 'staged'))).toEqual({
    argv: ['git', '--literal-pathspecs', 'restore', '--staged', '--', 'new name.ts', 'old => name.ts'],
    cwd: '/repo',
    timeoutMs: 10_000,
  })
  expect((await argvOf(id('M both.ts', 'staged'))).argv).toEqual(['git', '--literal-pathspecs', 'restore', '--staged', '--', 'both.ts'])
  expect((await argvOf(id('M dir with space/un staged.md', 'unstaged'))).argv).toEqual(['git', '--literal-pathspecs', 'add', '--', 'dir with space/un staged.md'])
  expect((await argvOf(id('? untracked/new.ts', 'untracked'))).argv).toEqual(['git', '--literal-pathspecs', 'add', '--', 'untracked/new.ts'])
})

test('a refused stage is a notice with git\'s first line', async () => {
  const { host } = fakeHost(gitAnswers, { '--literal-pathspecs add': 'fatal: nope' })
  const tab = filesTab(host)
  await tab.load()
  const row = tab.rows('').find(r => r.text === '? untracked/new.ts')!
  expect(await tab.act('s', row.id!)).toEqual({ kind: 'notice', text: 'git: fatal: nope' })
})

test('the selected file\'s diff is the detail, numbered by the new file, a removed line by the old one', async () => {
  const diff = ['diff --git a/both.ts b/both.ts', '--- a/both.ts', '+++ b/both.ts', '@@ -10,3 +10,3 @@ fn', ' keep', '-old', '+new', '@@ -40,1 +40,2 @@', ' x', '+y', ''].join('\n')
  const { host, calls } = fakeHost([...gitAnswers, ['--literal-pathspecs diff', diff]])
  const tab = filesTab(host)
  await tab.load()
  const row = tab.rows('').find(r => r.text === 'R new name.ts')!
  await tab.prefetch!(row.id!)
  expect(calls.at(-1)!.argv).toEqual(['git', '--literal-pathspecs', 'diff', '--no-ext-diff', '--cached', '-U2', '--', 'new name.ts', 'old => name.ts'])
  expect(tab.detail(row.id!)).toEqual({
    title: 'new name.ts',
    tail: '@@ -10,3 +10,3 @@',
    lines: [
      { text: ' keep', no: 10 },
      { text: '-old', no: 11, kind: 'del' },
      { text: '+new', no: 11, kind: 'add' },
      { text: '@@ -40,1 +40,2 @@', kind: 'hunk' },
      { text: ' x', no: 40 },
      { text: '+y', no: 41, kind: 'add' },
    ],
  })
})

test('enter on a log row switches: a local branch, a remote-only one with --track, several is a notice', async () => {
  const { host, calls } = fakeHost(gitAnswers)
  const tab = logTab(host)
  await tab.load()
  expect(tab.title()).toBe('log 4')
  expect(calls.at(-1)!.argv).toEqual(['git', 'log', '--graph', '--all', '--format=%h%x00%D%x00%s', '-n200'])
  const switched = async (sha: string) => {
    calls.length = 0
    const action = await tab.act('enter', sha)
    return { action, argv: calls[0]?.argv }
  }
  // Current branch only: switching to it is git's no-op, as in omp.
  expect(await switched('18ace7a')).toEqual({ action: { kind: 'refresh' }, argv: ['git', 'switch', 'master'] })
  expect(await switched('741a467')).toEqual({ action: { kind: 'refresh' }, argv: ['git', 'switch', '--track', 'origin/only-remote'] })
  expect(await switched('6690559')).toEqual({
    action: { kind: 'notice', text: 'git: 6690559 carries several local branches (feat, fix); this row cannot be switched from the panel' },
    argv: undefined,
  })
  // A commit without a branch: there is no editor to open it in, so it says so and runs nothing.
  expect(await switched('0d82ddc')).toEqual({ action: { kind: 'notice', text: 'git: 0d82ddc carries no branch' }, argv: undefined })
  // a toggles --all.
  expect(await tab.act('a', '0d82ddc')).toEqual({ kind: 'refresh' })
  await tab.load()
  expect(calls.at(-1)!.argv).toEqual(['git', 'log', '--graph', '--format=%h%x00%D%x00%s', '-n200'])
  expect(tab.title()).toBe('log 4 ·')
})

test('a log row is the graph in lane colors, the sha, a chip per ref and the subject; a connector is a tight head', async () => {
  const { host } = fakeHost(gitAnswers)
  const tab = logTab(host)
  await tab.load()
  const rows = tab.rows('')
  expect(rows[2]).toEqual({ kind: 'head', text: '│ ├┐', spans: expect.any(Array), tight: true })
  expect(rows[0]!.text).toBe('● 18ace7a [master] [origin/master] [origin/HEAD] chore: tip')
  expect(rows[0]!.spans!.filter(s => s.chip).map(s => [s.text, s.color])).toEqual([
    ['master', 'suggestion'],
    ['origin/master', expect.any(String)],
    ['origin/HEAD', expect.any(String)],
  ])
  // Filtering drops the connectors and keeps matching commits.
  expect(tab.rows('remote').map(r => r.id)).toEqual(['741a467'])
})

const PANE = {
  plugin: 'org-todo',
  component: 'Pane',
  requestId: 'org-todo',
  props: { title: 'Todo', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the pane: tab reaches files, enter shows the full diff, j/k move, s stages the selected row, git text is drawn sanitised', async ($, on) => {
  const runs: string[][] = []
  const status = STATUS.replace('? untracked/new.ts', '? evil\x1b[31mname\x07.ts')
  on('command.register', () => ({ value: { command: 'org-todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'org-todo', title: 'Todo', isShown: true, isFocused: false, isPlaced: true }] }))
  on('env.get', () => ({ value: '/home/u' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const args = e.argv.slice(1).join(' ')
    const diff = ['diff --git a/both.ts b/both.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n')
    const out = e.argv[0] === 'grep' ? '' : ([...gitAnswers, ['--no-optional-locks status', status], ['--literal-pathspecs diff', diff]] as Array<[string, string]>).reverse().find(([k]) => args.startsWith(k))?.[1] ?? ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.resize({ columns: 60, rows: 30 })
    // The strip carries every tab with its count, the git ones loaded at session start.
    expect(await ui.find({ type: 'Text', text: ' todo 0 ', in: 'panel' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: / files 5/, in: 'panel' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: / log 4/, in: 'panel' })).toBeTruthy()

    await ui.key({ key: 'tab' })
    expect(await ui.find({ type: 'Text', text: ' files 5 ', in: 'panel' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: '1 / 7', in: 'panel' })).toBeTruthy()
    const texts = (await ui.findAll({ type: 'Text', in: 'panel' })).map(t => t.text ?? '')
    expect(texts.some(t => t.includes('evilname.ts'))).toBe(true)
    expect(texts.some(t => /[\x00-\x08\x0b-\x1f\x7f]/.test(t))).toBe(false)

    // enter shows the selected file's whole diff in place of the list; enter again goes back.
    await ui.key({ key: 'return' })
    expect(await ui.find({ type: 'Text', text: ' back to list', in: 'panel' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeUndefined()
    await ui.key({ key: 'return' })
    expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeTruthy()
    // Down to the untracked row (the last of 7, past the end stays there), then s adds it as git listed it.
    for (let i = 0; i < 7; i++) await ui.key({ key: 'j' })
    expect(await ui.find({ type: 'Text', text: '7 / 7', in: 'panel' })).toBeTruthy()
    await ui.key({ key: 'k' })
    await ui.key({ key: 'j' })
    // h/t are what physical J/K type on us(dvorak): they move like j/k.
    await ui.key({ key: 't' })
    expect(await ui.find({ type: 'Text', text: '6 / 7', in: 'panel' })).toBeTruthy()
    await ui.key({ key: 'h' })
    expect(await ui.find({ type: 'Text', text: '7 / 7', in: 'panel' })).toBeTruthy()
    runs.length = 0
    await ui.key({ key: 's' })
    // The poll may run git too (its 3 s tick fires under the test clock): the add is among the runs, once.
    expect(runs.filter(r => r.includes('add'))).toEqual([['git', '--literal-pathspecs', 'add', '--', 'evil\x1b[31mname\x07.ts']])
    // Back to todo for the next surface.
    await ui.key({ key: 'tab' })
    await ui.key({ key: 'tab' })
    await ui.unmount()
  }
})

const TOO_LARGE = 'git output too large (over 4 MiB)'
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e)))

test('a status, numstat or log over the stream cap fails the load instead of listing a cut output', async () => {
  const status = fakeHost(gitAnswers, {}, ['--no-optional-locks status'])
  expect(await failure(filesTab(status.host).load())).toBe(TOO_LARGE)
  const numstat = fakeHost(gitAnswers, {}, ['diff --no-ext-diff --cached --numstat'])
  expect(await failure(filesTab(numstat.host).load())).toBe(TOO_LARGE)
  const unstaged = fakeHost(gitAnswers, {}, ['diff --no-ext-diff --numstat'])
  expect(await failure(filesTab(unstaged.host).load())).toBe(TOO_LARGE)
  const root = fakeHost(gitAnswers, {}, ['rev-parse'])
  expect(await failure(filesTab(root.host).load())).toBe(TOO_LARGE)
  expect(await failure(logTab(root.host).load())).toBe(TOO_LARGE)
  const log = fakeHost(gitAnswers, {}, ['log --graph'])
  const tab = logTab(log.host)
  expect(await failure(tab.load())).toBe(TOO_LARGE)
  expect(tab.title()).toBe('log')
})

test('a truncated detail diff is shown with a cut marker; a failed diff or show is an error with git\'s first line', async () => {
  const diff = ['diff --git a/both.ts b/both.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n')
  const cut = fakeHost([...gitAnswers, ['--literal-pathspecs diff', diff]], {}, ['--literal-pathspecs diff'])
  const files = filesTab(cut.host)
  await files.load()
  const row = files.rows('').find(r => r.text === 'U conflict.ts')!
  await files.prefetch!(row.id!)
  expect(files.detail(row.id!)!.more).toBe('output cut at 4 MiB')
  expect(files.detail(row.id!)!.lines).toHaveLength(2)

  const bad = fakeHost(gitAnswers, { '--literal-pathspecs diff': 'fatal: bad revision' })
  const failing = filesTab(bad.host)
  await failing.load()
  expect(await failure(failing.prefetch!(row.id!))).toBe('git diff: fatal: bad revision')
  expect(failing.detail(row.id!)).toBeUndefined()

  const show = fakeHost(gitAnswers, { show: 'fatal: bad object' })
  const log = logTab(show.host)
  await log.load()
  expect(await failure(log.prefetch!('18ace7a'))).toBe('git show: fatal: bad object')
  expect(log.detail('18ace7a')).toBeUndefined()
})

test('a directory that is not a repository fails both git tabs with git\'s first line; an empty one lists nothing without a crash', async () => {
  const { host } = fakeHost(gitAnswers, { 'rev-parse': 'fatal: not a git repository' })
  expect(await failure(filesTab(host).load())).toBe('git rev-parse: fatal: not a git repository')
  expect(await failure(logTab(host).load())).toBe('git rev-parse: fatal: not a git repository')
  // `git log --all` with no commits exits 0 with nothing; the rows are empty, not a crash.
  const empty = logTab(fakeHost([['rev-parse --show-toplevel', '/repo\n']]).host)
  await empty.load()
  expect(empty.title()).toBe('log 0')
  expect(empty.rows('')).toEqual([])
})

const ORG_LINE = '/home/u/work/org/x.org:1:* TODO Ship it'
const SHOWN = { id: 'org-todo', title: 'Todo', isShown: true, isFocused: false, isPlaced: true }

type Run = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean }

/** The engine beneath the plugin: `answer` gives a git command's result, grep lists one todo. An answer held on
 *  the test's clock (`clock.sleep`) lets the act that asked for it return. */
function wire(
  on: On,
  answer: (args: string) => Run | Promise<Run> = () => ({}),
  panes: () => unknown[] = () => [SHOWN],
  grep: () => Run | Promise<Run> = () => ({ stdout: ORG_LINE }),
) {
  const runs: string[][] = []
  on('ui.panes', () => ({ value: panes() as never }))
  on('command.register', () => ({ value: { command: 'org-todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/u' }))
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    const args = e.argv.slice(1).join(' ')
    const r = e.argv[0] === 'grep' ? await grep() : await answer(args)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r } }
  })
  return runs
}

const start = ($: Engine) => $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

test('the poll reloads the active git tab only while the pane is shown', async ($, on) => {
  const clock = mock.clock(on)
  let panes: unknown[] = [SHOWN]
  const runs = wire(on, args => (args.startsWith('rev-parse') ? { stdout: '/repo\n' } : args.startsWith('--no-optional-locks status') ? { stdout: STATUS } : {}), () => panes)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'tab' })
  const git = () => runs.filter(r => r[0] === 'git')
  const tick = async () => {
    runs.length = 0
    await clock.advance(3000)
  }

  await tick()
  expect(git().some(r => r.includes('status'))).toBe(true)
  // Closed, behind another pane, or undrawn: the tick runs no git command at all.
  for (const hidden of [[], [{ ...SHOWN, isShown: false }], [{ ...SHOWN, isPlaced: false }]]) {
    panes = hidden
    await tick()
    expect(git()).toEqual([])
  }
  panes = [SHOWN]
  await tick()
  expect(git().some(r => r.includes('status'))).toBe(true)
  await ui.unmount()
})

test('the fallback list draws the todos as buttons on a surface without Client', async ($, on) => {
  on('clock.every', () => ({ value: undefined }))
  wire(on)
  await start($)
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1 pending' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Ship it/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the pane shows the files tab\'s load error in a directory that is not a repository', async ($, on) => {
  on('clock.every', () => ({ value: undefined }))
  wire(on, args => (args.startsWith('rev-parse') ? { exitCode: 128, stderr: 'fatal: not a git repository\n' } : {}))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'tab' })
  expect(await ui.find({ type: 'Text', text: /git rev-parse: fatal: not a git repository/, in: 'panel' })).toBeTruthy()
  await ui.unmount()
})

test('a cut git show is marked; a cut diff already holding a more joins both markers', async () => {
  const show = fakeHost([...gitAnswers, ['show', 'subject\nauthor · now\n a.ts | 1 +\n']], {}, ['show'])
  const log = logTab(show.host)
  await log.load()
  await log.prefetch!('18ace7a')
  expect(log.detail('18ace7a')!.more).toBe('output cut at 4 MiB')

  const body = Array.from({ length: 402 }, (_, i) => `+l${i}`)
  const diff = ['diff --git a/both.ts b/both.ts', '@@ -1,0 +1,402 @@', ...body, ''].join('\n')
  const { host } = fakeHost([...gitAnswers, ['--literal-pathspecs diff', diff]], {}, ['--literal-pathspecs diff'])
  const files = filesTab(host)
  await files.load()
  const row = files.rows('').find(r => r.text === 'U conflict.ts')!
  await files.prefetch!(row.id!)
  expect(files.detail(row.id!)!.more).toBe('2 more lines · output cut at 4 MiB')
})

const TICK_FAILED = 'panel: grep output too large (over 4 MiB)'
const toastsOf = (on: On) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

test('a todo refresh that keeps failing toasts once; a success in between toasts the same failure again', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = toastsOf(on)
  let big = true
  wire(on, undefined, undefined, () => ({ stdout: ORG_LINE, isStdoutTruncated: big }))
  await start($)
  await clock.advance(3000)
  await clock.advance(3000)
  expect(toasts).toEqual([TICK_FAILED])
  big = false
  await clock.advance(3000)
  expect(toasts).toEqual([TICK_FAILED])
  big = true
  await clock.advance(3000)
  expect(toasts).toEqual([TICK_FAILED, TICK_FAILED])
})

// A hook that throws is skipped, so the broken answer is a non-list: reading it throws, as a rejection would.
test('a ui.panes that rejects ends the tick without git and does not throw out of it: the next tick runs', async ($, on) => {
  const clock = mock.clock(on)
  let broken = false
  const runs = wire(on, args => (args.startsWith('rev-parse') ? { stdout: '/repo\n' } : args.startsWith('--no-optional-locks status') ? { stdout: STATUS } : {}), () => (broken ? (42 as never) : [SHOWN]))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'tab' })
  const git = () => runs.filter(r => r[0] === 'git')
  broken = true
  runs.length = 0
  await clock.advance(3000)
  expect(git()).toEqual([])
  broken = false
  runs.length = 0
  await clock.advance(3000)
  expect(git().some(r => r.includes('status'))).toBe(true)
  await ui.unmount()
})

test('a fallback button whose completion fails toasts the error instead of leaving it unhandled', async ($, on) => {
  on('clock.every', () => ({ value: undefined }))
  const toasts = toastsOf(on)
  // A read that answers a non-string makes complete() reject (a hook that throws is skipped, not rejected).
  on('fs.read', () => ({ value: 42 as never }))
  wire(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'todo-0' })
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(1)
  await ui.unmount()
})

/** The fixture repository's git, by argv prefix, with a six-line diff for any file. */
const DIFF6 = ['diff --git a/x b/x', '@@ -1,0 +1,6 @@', ...Array.from({ length: 6 }, (_, i) => `+l${i}`), ''].join('\n')
const repo = (args: string): Run => ({ stdout: ([...gitAnswers, ['--literal-pathspecs diff', DIFF6]] as Array<[string, string]>).find(([k]) => args.startsWith(k))?.[1] ?? '' })
const MOVES = ['add', 'restore', 'switch']

test('a forged act (an unlisted path, ../x, an unknown group, an unlisted sha or todo) runs no git command and writes nothing', async ($, on) => {
  on('clock.every', () => ({ value: undefined }))
  const runs = wire(on, repo)
  let writes = 0
  on('fs.write', () => {
    writes += 1
    return { value: undefined }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const forged: Array<[number, string, string]> = [
    [1, 's', 'unstaged:secret.txt'],
    [1, 's', 'unstaged:../x'],
    [1, 's', 'untracked:../x'],
    [1, 's', 'bogus:both.ts'],
    [1, 's', 'staged:dir with space/un staged.md'],
    [2, 'enter', 'deadbee'],
    [0, 'enter', '/etc/passwd:1'],
  ]
  let seq = 0
  for (const [tab, key, id] of forged) {
    runs.length = 0
    await ui.post({ view: { tab, filter: '', id }, act: { key, id, seq: ++seq } })
    expect([id, runs.filter(r => MOVES.some(m => r.includes(m)))]).toEqual([id, []])
  }
  expect(writes).toBe(0)
  // A listed row still acts, under the filter the Client listed it with.
  runs.length = 0
  await ui.post({ view: { tab: 1, filter: 'staged.md', id: 'unstaged:dir with space/un staged.md' }, act: { key: 's', id: 'unstaged:dir with space/un staged.md', seq: ++seq } })
  expect(runs.filter(r => MOVES.some(m => r.includes(m)))).toEqual([['git', '--literal-pathspecs', 'add', '--', 'dir with space/un staged.md']])
  // A view whose id is past the cap is refused whole, as an over-long filter is: the pane (on todo) keeps the
  // files view and draws no rows until a view with a short id brings todo back.
  await ui.post({ view: { tab: 0, filter: '', id: 'x'.repeat(5000) } })
  expect(await ui.find({ type: 'Text', text: ' Ship it', in: 'panel' })).toBeUndefined()
  await ui.post({ view: { tab: 0, filter: '', id: 'x' } })
  expect(await ui.find({ type: 'Text', text: ' Ship it', in: 'panel' })).toBeTruthy()
  await ui.unmount()
})

test('s with an id of an unknown group runs no git command', async () => {
  const { host, calls } = fakeHost(gitAnswers)
  const tab = filesTab(host)
  await tab.load()
  calls.length = 0
  expect(await tab.act('s', 'bogus:both.ts')).toEqual({ kind: 'refresh' })
  expect(calls).toEqual([])
})

test('a git command the engine stops at its timeout says which one timed out', async () => {
  const stopped = (k: string) => fakeHost(gitAnswers, {}, [], [k]).host
  expect(await failure(filesTab(stopped('rev-parse')).load())).toBe('git rev-parse timed out (10 s)')
  expect(await failure(filesTab(stopped('--no-optional-locks status')).load())).toBe('git status timed out (10 s)')
  expect(await failure(filesTab(stopped('diff --no-ext-diff --cached --numstat')).load())).toBe('git diff timed out (10 s)')
  expect(await failure(logTab(stopped('log --graph')).load())).toBe('git log timed out (10 s)')
  const add = filesTab(stopped('--literal-pathspecs add'))
  await add.load()
  expect(await failure(add.act('s', add.rows('').find(r => r.text === '? untracked/new.ts')!.id!))).toBe('git add timed out (10 s)')
  // Any other rejection is the engine's own.
  const broken: Host = { ...fakeHost(gitAnswers).host, run: async () => Promise.reject(new Error('spawn git ENOENT')) }
  expect(await failure(filesTab(broken).load())).toBe('spawn git ENOENT')
})

test('a failed numstat fails the files load with git\'s first line instead of drawing +0 -0', async () => {
  for (const k of ['diff --no-ext-diff --numstat', 'diff --no-ext-diff --cached --numstat']) {
    const tab = filesTab(fakeHost(gitAnswers, { [k]: 'fatal: bad index' }).host)
    expect(await failure(tab.load())).toBe('git diff: fatal: bad index')
    expect(tab.title()).toBe('files')
  }
})

test('a poll tick still running when the next one is due is not stacked under it', async ($, on) => {
  const clock = mock.clock(on)
  let slow = false
  let greps = 0
  wire(on, undefined, () => [], async () => {
    greps += 1
    if (slow) await clock.sleep(5000)
    return { stdout: ORG_LINE }
  })
  await start($)
  slow = true
  greps = 0
  await clock.advance(3000)
  expect(greps).toBe(1)
  // Due again while the first is still waiting on its grep: skipped.
  await clock.advance(3000)
  expect(greps).toBe(1)
  slow = false
  await clock.advance(3000)
  expect(greps).toBe(2)
})

test('a post does not wait on a slow git load: the pane says loading until it ends, then draws the rows', async ($, on) => {
  const clock = mock.clock(on)
  let slow = false
  wire(
    on,
    async args => {
      if (!args.startsWith('--no-optional-locks status')) return repo(args)
      if (!slow) return {}
      await clock.sleep(1000)
      return { stdout: STATUS }
    },
    () => [],
  )
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 30 })
  slow = true
  await ui.key({ key: 'tab' })
  expect(await ui.find({ type: 'Text', text: 'loading…', in: 'panel' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeUndefined()
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'loading…', in: 'panel' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '1 / 7', in: 'panel' })).toBeTruthy()
  await ui.unmount()
})

test('the files filter: typed, backspaced and closed, the rows and the counter follow it, and j then s act on the filtered rows', async ($, on) => {
  on('clock.every', () => ({ value: undefined }))
  const runs = wire(on, repo)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 30 })
  await ui.key({ key: 'tab' })
  expect(await ui.find({ type: 'Text', text: '1 / 7', in: 'panel' })).toBeTruthy()
  await ui.key({ key: '/' })
  for (const key of ['c', 'o', 'x']) await ui.key({ key })
  expect(await ui.find({ type: 'Text', text: 'cox█', in: 'panel' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '0 / 0', in: 'panel' })).toBeTruthy()
  await ui.key({ key: 'backspace' })
  expect(await ui.find({ type: 'Text', text: 'co█', in: 'panel' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '1 / 2', in: 'panel' })).toBeTruthy()
  expect(await ui.findAll({ type: 'Text', text: ' conflict.ts', in: 'panel' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: ' both.ts', in: 'panel' })).toBeUndefined()
  // Return closes the filter and keeps it; j now moves instead of typing.
  await ui.key({ key: 'return' })
  expect(await ui.find({ type: 'Text', text: 'co', in: 'panel' })).toBeTruthy()
  await ui.key({ key: 'j' })
  expect(await ui.find({ type: 'Text', text: '2 / 2', in: 'panel' })).toBeTruthy()
  runs.length = 0
  await ui.key({ key: 's' })
  expect(runs.filter(r => MOVES.some(m => r.includes(m)))).toEqual([['git', '--literal-pathspecs', 'add', '--', 'conflict.ts']])
  await ui.unmount()
})

test('the full diff: enter opens it, j scrolls it, enter goes back to the list with the selection kept', async ($, on) => {
  on('clock.every', () => ({ value: undefined }))
  wire(on, repo)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 30 })
  await ui.key({ key: 'tab' })
  await ui.key({ key: 'j' })
  expect(await ui.find({ type: 'Text', text: '2 / 7', in: 'panel' })).toBeTruthy()
  await ui.key({ key: 'return' })
  expect(await ui.find({ type: 'Text', text: ' back to list', in: 'panel' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '+l0', in: 'panel' })).toBeTruthy()
  await ui.key({ key: 'j' })
  expect(await ui.find({ type: 'Text', text: '+l0', in: 'panel' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '+l1', in: 'panel' })).toBeTruthy()
  await ui.key({ key: 'return' })
  expect(await ui.find({ type: 'Text', text: ' back to list', in: 'panel' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '2 / 7', in: 'panel' })).toBeTruthy()
  await ui.unmount()
})

const GONE = 'unstaged:dir with space/un staged.md'

test('an act whose row a poll reload removed first is refused with a notice, and runs no git add', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = toastsOf(on)
  let changed = false
  const runs = wire(on, async args => {
    if (!args.startsWith('--no-optional-locks status') || !changed) return repo(args)
    await clock.sleep(1000)
    return { stdout: '' }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'tab' })
  changed = true
  // The tick's reload of the files tab hangs on git; the act is posted meanwhile and queues behind it.
  await clock.advance(3000)
  runs.length = 0
  await ui.post({ view: { tab: 1, filter: '', id: GONE }, act: { key: 's', id: GONE, seq: 1 } })
  await clock.advance(1000)
  expect(runs.filter(r => MOVES.some(m => r.includes(m)))).toEqual([])
  expect(toasts).toContain('row changed, nothing done')
  await ui.unmount()
})

test('a drain that fails toasts once and clears loading; the next drain works', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = toastsOf(on)
  let slow = false
  let breakNext = false
  wire(
    on,
    async args => {
      if (!args.startsWith('--no-optional-locks status') || !slow) return repo(args)
      await clock.sleep(1000)
      return { stdout: STATUS }
    },
    () => [],
  )
  on('state.set', (_, e, next) => {
    if (e.key === 'panel' && breakNext) {
      breakNext = false
      return { deny: 'state down' } as never
    }
    return next(e)
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 30 })
  slow = true
  await ui.key({ key: 'tab' })
  expect(await ui.find({ type: 'Text', text: 'loading…', in: 'panel' })).toBeTruthy()
  breakNext = true
  await clock.advance(1000)
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'loading…', in: 'panel' })).toBeUndefined()
  // The same failure again is not toasted again.
  breakNext = true
  await ui.key({ key: 'tab' })
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(1)
  // A clean drain re-arms it: the same failure toasts a second time.
  slow = false
  await ui.key({ key: 'tab' })
  await ui.key({ key: 'tab' })
  breakNext = true
  await ui.key({ key: 'tab' })
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(2)
  await ui.key({ key: 'tab' })
  await ui.key({ key: 'tab' })
  await ui.key({ key: 'j' })
  expect(await ui.find({ type: 'Text', text: 'staged', in: 'panel' })).toBeTruthy()
  await ui.unmount()
})

test('a drain that fails at session start toasts and leaves no loading', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = toastsOf(on)
  wire(on, undefined, () => [])
  let breakNext = true
  on('state.set', (_, e, next) => {
    if (e.key === 'panel' && breakNext) {
      breakNext = false
      return { deny: 'state down' } as never
    }
    return next(e)
  })
  await start($)
  await clock.advance(1)
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'loading…', in: 'panel' })).toBeUndefined()
  await ui.unmount()
})

test('a drain whose clearing write also fails still toasts, and nothing rejects out of it', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = toastsOf(on)
  wire(on, undefined, () => [])
  let deny = 2
  on('state.set', (_, e, next) => {
    if (e.key === 'panel' && deny > 0) {
      deny--
      return { deny: 'state down' } as never
    }
    return next(e)
  })
  await start($)
  await clock.advance(1)
  expect(deny).toBe(0)
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(1)
})

test('a drain that fails on a poll tick toasts and leaves no loading', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = toastsOf(on)
  let empty = false
  wire(on, args => (empty && args.startsWith('--no-optional-locks status') ? { stdout: '' } : repo(args)), () => [SHOWN])
  let breakNext = false
  on('state.set', (_, e, next) => {
    if (e.key === 'panel' && breakNext) {
      breakNext = false
      return { deny: 'state down' } as never
    }
    return next(e)
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'tab' })
  // The tick's reload draws other rows, so the drain writes the state, and that write fails.
  empty = true
  breakNext = true
  await clock.advance(3000)
  expect(toasts.filter(t => t.startsWith('panel: '))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'loading…', in: 'panel' })).toBeUndefined()
  await ui.unmount()
})
