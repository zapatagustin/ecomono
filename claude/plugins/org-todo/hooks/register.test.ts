import { expect, test } from 'claude-code/testing'

import { isSameTodo, parse } from './register'

test('parse keeps pending org headings and markdown boxes only', async () => {
  const roots = ['/repo/docs', '/home/u/work/org']
  const out = parse(
    [
      '/home/u/work/org/1.6.26.org:5:** TODO Ship it',
      '/repo/docs/plan.md:7:  - [ ] Write tests',
      '/home/u/work/org/1.6.26.org:6:** DONE Old',
      '/home/u/work/org/x.org:2:* BLOCKED Waiting on Henry',
      'garbage',
    ].join('\n'),
    roots,
  )
  expect(out).toEqual([
    { file: '/home/u/work/org/1.6.26.org', line: 5, text: 'Ship it', kind: 'org', src: '1.6.26.org' },
    { file: '/repo/docs/plan.md', line: 7, text: 'Write tests', kind: 'md', src: 'plan.md' },
    { file: '/home/u/work/org/x.org', line: 2, text: 'BLOCKED: Waiting on Henry', kind: 'org', src: 'x.org' },
  ])
})

test('isSameTodo accepts the todo it was listed from, refuses a shifted neighbour', async () => {
  const roots = ['/home/u/work/org']
  const [b] = parse('/home/u/work/org/x.org:1:* TODO b', roots)

  // Same line, same todo: passes (surrounding whitespace is parse()'s trim).
  expect(isSameTodo('* TODO b', b)).toBe(true)
  expect(isSameTodo('* TODO b  ', b)).toBe(true)
  // Another todo shifted into line 1 by an insert above: refused.
  expect(isSameTodo('* TODO c', b)).toBe(false)
  // Line no longer a todo at all, or past the end of the file: refused.
  expect(isSameTodo('* DONE b', b)).toBe(false)
  expect(isSameTodo('plain text', b)).toBe(false)
  expect(isSameTodo('', b)).toBe(false)
  // Same text, other kind: refused.
  expect(isSameTodo('- [ ] b', b)).toBe(false)
})

test('isSameTodo round-trips what parse() lists, BLOCKED headings and markdown boxes included', async () => {
  const roots = ['/repo/docs', '/home/u/work/org']
  const listed = parse(
    [
      '/home/u/work/org/x.org:2:* BLOCKED Waiting on Henry',
      '/home/u/work/org/x.org:3:** TODO   padded  ',
      '/repo/docs/plan.md:7:  - [ ] Write tests',
    ].join('\n'),
    roots,
  )
  const lines = ['* BLOCKED Waiting on Henry', '** TODO   padded  ', '  - [ ] Write tests']
  listed.forEach((t, i) => expect(isSameTodo(lines[i], t)).toBe(true))
  // A neighbour never passes for another entry.
  listed.forEach((t, i) => expect(isSameTodo(lines[(i + 1) % lines.length], t)).toBe(false))
  // A TODO heading is not the BLOCKED one listed, nor vice versa.
  expect(isSameTodo('* TODO Waiting on Henry', listed[0])).toBe(false)
})
