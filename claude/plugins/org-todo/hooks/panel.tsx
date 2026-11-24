/**
 * The pane's drawing and keys: a `Client` surface module, so it reads every key itself (`surface.onKey`) rather
 * than through Buttons. It mirrors omp's panel/panel.ts layout: the tab strip (each tab with its count, the
 * active one a solid accent block, the selection counter at the right), the filter line and a hairline, the rows
 * (head rows group with their counts, item rows select), the selected item's detail under them (accent title cut
 * at its start, numbered lines in diff colours), free rows, and a key bar that wraps and lists every key.
 *
 * Keys reach it only while it holds the focus (a click on the pane), never while the chat input has it; Escape
 * hands the focus back to the chat and never arrives here, so omp's esc and q (close) have no counterpart. The
 * view (tab, filter, selection, scroll) is local; the hooks module (register.tsx) owns the data. Every key that
 * changes the view posts the whole view, so a later post replacing an undelivered one loses nothing. An act posts
 * a sequence number and the pane takes no key until the props say it is done, as omp's panel takes none while an
 * action runs. Text widths: everything drawn arrives sanitised, and long text is cut by the surface (Text `wrap`),
 * so nothing here measures a string except ASCII (keys, counts) and the graph's one-column glyphs.
 */

import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { DetailLine, PanelProps, Row, Span } from '../types'

type State = { tab: number; filter: string; filtering: boolean; id?: string; top: number; full: boolean; scroll: number; seq: number }
const START: State = { tab: 0, filter: '', filtering: false, top: 0, full: false, scroll: 0, seq: 0 }

const ACCENT = 'suggestion'
/** The pane's own keys, after the tab's. j/k also match h/t, which physical J/K type on us(dvorak), as in omp's panel. */
const PANEL_KEYS: [string, string][] = [['/', 'filter'], ['j/k', 'move'], ['tab', 'next tab'], ['esc', 'back to chat']]
const FULL_KEYS: [string, string][] = [['enter', 'back to list'], ['j/k', 'scroll'], ['tab', 'next tab'], ['esc', 'back to chat']]
/** Lines of a detail's content shown at most under the list, besides its title and cut marker. */
const CONTENT_MAX = 10
/** Rows the list keeps before the detail is made smaller. */
const LIST_FLOOR = 6
/** Rows above the list: the strip, the filter, its hairline. */
const HEAD = 3
/** Rows a detail spends besides its content under the list: the hairline, the title and one blank row. */
const FRAME = 3

/** Rows the last draw gave the list (or the full detail): what a page key moves by. */
let lastArea = 1

const Panel: ClientModule<PanelProps, State> = (p, surface) => {
  const { Box, Text } = surface.elements
  const s = surface.state ?? START
  const W = Math.max(1, surface.columns)
  const H = Math.max(1, surface.rows)
  // The rows are the last ones the hooks module sent; while a tab switch is on its way there are none.
  const rows: Row[] = p.tab === s.tab && p.failed === undefined ? p.rows : []
  const items = rows.flatMap((r, i) => (r.kind === 'item' ? [i] : []))
  const selOf = (st: State): number => {
    const own = rows.findIndex(r => r.kind === 'item' && r.id === st.id)
    const theirs = rows.findIndex(r => r.kind === 'item' && r.id === p.id)
    return own !== -1 ? own : theirs !== -1 ? theirs : (items[0] ?? -1)
  }
  const sel = selOf(s)
  const selId = rows[sel]?.id
  // The detail is for the row the hooks module resolved; a selection still on its way shows none yet.
  const d = p.detail && selId !== undefined && selId === p.id ? p.detail : undefined
  const busy = s.seq > p.done

  // The key bar, wrapped as omp's: the tab's keys start the first row, the pane's the next; nothing is dropped.
  const groups = s.full && d ? [FULL_KEYS] : [p.keys, PANEL_KEYS]
  const keyRows: [string, string][][] = []
  for (const group of groups) {
    let row: [string, string][] = []
    let used = 0
    for (const pair of group) {
      const piece = pair[0].length + 3 + pair[1].length
      if (used > 0 && used + 3 + piece > W) {
        keyRows.push(row)
        ;[row, used] = [[], 0]
      }
      row.push(pair)
      used += (used > 0 ? 3 : 0) + piece
    }
    keyRows.push(row)
  }

  const R = Math.max(1, H - HEAD - keyRows.length)
  const fixed = d ? FRAME + (d.note ? 1 : 0) : 0
  const count = d ? d.lines.length + (d.more ? 1 : 0) : 0
  const wants = d ? fixed + Math.min(CONTENT_MAX, count) : 0
  const smallest = d ? Math.min(wants, fixed + 2) : 0
  let room = 0
  if (rows.length + wants > R) {
    const give = Math.min(wants, R - Math.min(rows.length, LIST_FLOOR))
    if (give >= smallest) room = give
  } else room = wants
  const full = s.full && d !== undefined
  const area = full ? R : Math.max(1, R - room)
  lastArea = area
  const top = scrollTop(s.top, sel, area, rows.length)

  surface.onKey(k => onKey(k, surface.state ?? START))

  function onKey(k: ClientKeyEvent, st: State): void {
    if (st.seq > p.done) return
    const at = selOf(st)
    const post = (n: State, act?: string) => {
      surface.setState(n)
      const id = rows[selOf(n)]?.id
      surface.post({ view: { tab: n.tab, filter: n.filter, id: id ?? null }, ...(act && id !== undefined ? { act: { key: act, id, seq: n.seq } } : {}) })
    }
    const move = (by: number) => {
      if (items.length === 0) return
      const i = items[Math.max(0, Math.min(items.length - 1, Math.max(0, items.indexOf(at)) + by))]!
      post({ ...st, id: rows[i]!.id, top: scrollTop(st.top, i, lastArea, rows.length), scroll: 0, full: false })
    }
    const page = Math.max(1, lastArea)
    const char = k.key.length === 1 && !k.ctrl && !k.meta ? k.key : undefined
    if (k.key === 'tab') {
      const n = p.tabs.length || 1
      return post({ ...START, seq: st.seq, tab: (st.tab + (k.shift ? -1 : 1) + n) % n })
    }
    if (st.filtering) {
      if (k.key === 'return') return surface.setState({ ...st, filtering: false })
      if (k.key === 'backspace') return post({ ...st, filter: st.filter.slice(0, -1), id: undefined, top: 0 })
      if (k.key === 'down') return move(1)
      if (k.key === 'up') return move(-1)
      if (char !== undefined) return post({ ...st, filter: st.filter + char, id: undefined, top: 0 })
      return
    }
    if (st.full && d) {
      const max = Math.max(0, d.lines.length - 1)
      const by = k.key === 'j' || k.key === 'h' || k.key === 'down' ? 1 : k.key === 'k' || k.key === 't' || k.key === 'up' ? -1 : k.key === 'pagedown' ? page : k.key === 'pageup' ? -page : 0
      if (by !== 0) return surface.setState({ ...st, scroll: Math.max(0, Math.min(max, st.scroll + by)) })
      if (k.key === 'return') return surface.setState({ ...st, full: false, scroll: 0 })
      return
    }
    if (char === '/') return surface.setState({ ...st, filtering: true })
    if (k.key === 'j' || k.key === 'h' || k.key === 'down') return move(1)
    if (k.key === 'k' || k.key === 't' || k.key === 'up') return move(-1)
    if (k.key === 'pagedown') return move(page)
    if (k.key === 'pageup') return move(-page)
    // An act needs the rows of the tab it is meant for.
    if (at === -1 || p.tab !== st.tab) return
    if (k.key === 'return') {
      if (p.enter === 'full') return d ? surface.setState({ ...st, id: rows[at]!.id, full: true, scroll: 0 }) : undefined
      if (p.keys.some(([key]) => key === 'enter')) return post({ ...st, id: rows[at]!.id, seq: st.seq + 1 }, 'enter')
      return
    }
    if (char !== undefined && p.keys.some(([key]) => key === char)) return post({ ...st, id: rows[at]!.id, seq: st.seq + 1 }, char)
  }

  const line = (text: string, props: Record<string, unknown> = {}) => (
    <Text wrap="truncate-end" {...props}>
      {text}
    </Text>
  )
  const hairline = line('─'.repeat(W), { color: 'subtle' })

  // The tab strip: every tab with its count, the active one a solid block, a failed one marked `!`.
  const pos = `${sel === -1 ? 0 : items.indexOf(sel) + 1} / ${items.length}`
  const strip = (
    <Box flexDirection="row" width={W} height={1}>
      {p.tabs.map((t, i) => (
        <Box flexDirection="row" flexShrink={0}>
          {i > 0 ? <Text color="subtle">│</Text> : ''}
          {i === s.tab ? (
            <Text backgroundColor={ACCENT} color="inverseText">{` ${t.title} `}</Text>
          ) : (
            <Text>
              {` ${t.title}`}
              {t.lost ? <Text color="warning"> !</Text> : ''}{' '}
            </Text>
          )}
        </Box>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>{busy ? 'working…' : p.loading ? 'loading…' : pos}</Text>
    </Box>
  )

  // Right-aligned `+N` and `-N` columns shared by every row, a zero or missing side blank.
  const addW = Math.max(0, ...rows.map(r => (r.add ? `+${r.add}`.length : 0)))
  const delW = Math.max(0, ...rows.map(r => (r.del ? `-${r.del}`.length : 0)))
  const counts = (r: Row, chosen: boolean) => {
    const a = r.add ? `+${r.add}` : ''
    const dl = r.del ? `-${r.del}` : ''
    if (!addW && !delW) return ''
    return (
      <Text color={chosen ? 'inverseText' : undefined}>
        {' '.repeat(addW - a.length + 1)}
        <Text color={chosen ? 'inverseText' : 'success'}>{a}</Text>
        {addW && delW ? '  ' : ''}
        {' '.repeat(delW - dl.length)}
        <Text color={chosen ? 'inverseText' : 'error'}>{dl}</Text>
      </Text>
    )
  }
  const spanText = (x: Span, chosen: boolean) =>
    x.chip ? (
      <Text inverse={!chosen} color={chosen ? 'inverseText' : (x.color ?? 'text')}>{` ${x.text} `}</Text>
    ) : (
      <Text color={chosen ? 'inverseText' : x.color}>{x.text}</Text>
    )
  const drawRow = (r: Row, i: number) => {
    const chosen = i === sel
    const bg = chosen ? { backgroundColor: ACCENT } : {}
    const fg = chosen ? 'inverseText' : undefined
    if (r.kind === 'head' && !r.spans) {
      return (
        <Box flexDirection="row" width={W} height={1}>
          <Box flexGrow={1} flexShrink={1}>{line(r.text, { dimColor: true })}</Box>
          <Box flexShrink={0}>{r.right !== undefined ? <Text dimColor>{` ${r.right}`}</Text> : ''}</Box>
        </Box>
      )
    }
    const lead = <Text color={fg}>{chosen ? '> ' : '  '}</Text>
    if (r.spans) {
      const last = r.spans.length - 1
      return (
        <Box flexDirection="row" width={W} height={1} {...bg}>
          {lead}
          {r.spans.map((x, k) =>
            k === last ? (
              <Box flexShrink={1} flexGrow={1}>
                <Text wrap="truncate-end" color={fg}>{x.chip ? ` ${x.text} ` : x.text}</Text>
              </Box>
            ) : (
              <Box flexShrink={0}>{spanText(x, chosen)}</Box>
            ),
          )}
        </Box>
      )
    }
    const [mark = '', ...restChars] = Array.from(r.text)
    const rest = restChars.join('')
    return (
      <Box flexDirection="row" width={W} height={1} {...bg}>
        {lead}
        <Text color={fg ?? r.color}>{mark}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={fg} wrap={r.cut === 'start' ? 'truncate-start' : 'truncate-end'}>
            {rest}
          </Text>
        </Box>
        <Box flexShrink={0}>{r.right !== undefined ? <Text color={fg}>{` ${r.right}`}</Text> : counts(r, chosen)}</Box>
      </Box>
    )
  }

  // The detail: title (a path cut at its start) and its tail, a dim note, a blank row, numbered lines, a marker.
  const detailLines = (lines: DetailLine[], hidden: number) => {
    const numbered = lines.some(l => l.no !== undefined)
    const noW = Math.max(3, ...lines.map(l => String(l.no ?? '').length))
    const out = lines.map(l => {
      const gutter = numbered ? ` ${l.no === undefined ? ' '.repeat(noW) : String(l.no).padStart(noW)} │ ` : ''
      const look =
        l.kind === 'add' ? { backgroundColor: 'diffAdded' } : l.kind === 'del' ? { backgroundColor: 'diffRemoved' } : l.kind === 'hit' ? { backgroundColor: ACCENT, color: 'inverseText' } : l.kind === 'hunk' ? { color: ACCENT } : {}
      return (
        <Box flexDirection="row" width={W} height={1}>
          {gutter && <Text dimColor>{gutter}</Text>}
          <Box flexGrow={1} flexShrink={1} {...(l.kind === 'add' || l.kind === 'del' ? look : {})}>
            {line(l.text, l.kind === 'add' || l.kind === 'del' ? {} : look)}
          </Box>
        </Box>
      )
    })
    const marker = [hidden > 0 ? `${hidden} more` : '', d?.more ?? ''].filter(Boolean).join(' · ')
    if (marker) out.push(line(`… ${marker}`, { dimColor: true }))
    return out
  }
  const detailHead = d ? (
    <Box flexDirection="column" width={W}>
      <Box flexDirection="row" width={W} height={1}>
        <Box flexShrink={1}>
          <Text color={ACCENT} wrap="truncate-start">{d.title}</Text>
        </Box>
        {d.tail ? (
          <Box flexShrink={2} marginLeft={3}>
            {line(d.tail, { color: ACCENT })}
          </Box>
        ) : ''}
      </Box>
      {d.note ? line(d.note, { dimColor: true }) : ''}
      <Text> </Text>
    </Box>
  ) : ''
  let detail: ReturnType<typeof line> | string = ''
  if (d && full) {
    const content = Math.max(1, R - (fixed - 1))
    const from = Math.min(s.scroll, Math.max(0, d.lines.length - 1))
    const shown = d.lines.slice(from, from + content - 1)
    detail = (
      <Box flexDirection="column" width={W}>
        {detailHead}
        {...detailLines(shown, d.lines.length - from - shown.length)}
      </Box>
    )
  } else if (d && room > 0) {
    const content = Math.min(CONTENT_MAX, room - fixed)
    const shown = d.more || count > content ? Math.min(d.lines.length, content - 1) : d.lines.length
    detail = (
      <Box flexDirection="column" width={W}>
        {hairline}
        {detailHead}
        {...detailLines(d.lines.slice(0, Math.max(0, shown)), d.lines.length - Math.max(0, shown))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={W} height={H}>
      {strip}
      <Box flexDirection="row" width={W} height={1}>
        <Text color={ACCENT}>{'> '}</Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-start">{`${s.filter}${s.filtering ? '█' : ''}`}</Text>
        </Box>
      </Box>
      {hairline}
      {full ? '' : p.failed !== undefined ? (
        <Box height={area} width={W}>
          <Text color="warning" wrap="wrap">{`  ${p.failed}`}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" height={room > 0 ? Math.min(area, rows.length) : area} width={W}>
          {rows.length === 0 && p.tab === s.tab ? line(p.loading ? '  loading…' : '  Nothing here.', { dimColor: true }) : ''}
          {rows.slice(top, top + area).map((r, k) => drawRow(r, top + k))}
        </Box>
      )}
      {detail}
      <Box flexGrow={1} />
      {keyRows.map(pairs => (
        <Box flexDirection="row" width={W} height={1}>
          {pairs.map(([key, what], i) => (
            <Text>
              {i > 0 ? '   ' : ''}
              <Text backgroundColor="subtle" color={ACCENT}>{` ${key} `}</Text>
              <Text dimColor>{` ${what}`}</Text>
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** The first list row drawn: `top` moved only as far as keeps row `sel` in an `area`-row window. */
function scrollTop(top: number, sel: number, area: number, n: number): number {
  let t = top
  if (sel !== -1 && sel < t) t = sel
  if (sel !== -1 && sel >= t + area) t = sel - area + 1
  return Math.max(0, Math.min(t, n - area))
}

export default Panel
