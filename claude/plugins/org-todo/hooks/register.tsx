import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Todo } from '../types'

const PANE = 'org-todo'
// ecomono: fixed under $HOME; upgrade path is a userConfig option.
const ORG_DIR = 'work/org'
const POLL_MS = 3000

const ORG = /^(\*+) (TODO|BLOCKED) (.*)$/
const MD = /^(\s*[-*] )\[ \] (.*)$/

const todos = atom({ plugin: 'org-todo', key: 'todos' } as const, [] as Todo[])

// The one rule for what a line means as a todo. parse() lists todos with it and
// complete() re-checks the line with it, so the two cannot disagree.
function classify(raw: string): Pick<Todo, 'text' | 'kind'> | null {
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
  return parse(run.stdout, dirs)
}

async function refresh($: EngineInterface, cwd: string) {
  const next = await scan($, cwd)
  const prev = await read($, todos)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, todos, () => next)
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

export const register: Register = on => {
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'org-todo', description: 'Open the todo pane (org + markdown)' })
    void $.ui.open({ id: PANE, title: 'Todo' })
    void refresh($, cwd)
    $.clock.every(POLL_MS, () => void refresh($, cwd))

    return next(e)
  })

  on('command.run', { command: 'org-todo' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Todo', focus: true })

    return { text: 'Todo pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
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
              onPress={() => void complete($, t, cwd)}
            />
            <Text> {t.text} </Text>
            <Text dimColor>{t.src}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
