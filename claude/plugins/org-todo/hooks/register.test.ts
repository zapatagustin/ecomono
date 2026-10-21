import { expect, test } from 'claude-code/testing'

import { parse } from './register'

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
