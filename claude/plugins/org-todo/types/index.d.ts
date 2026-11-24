export type Todo = {
  file: string
  line: number
  text: string
  kind: 'org' | 'md'
  src: string
}

/** A styled run of a row's text: `color` is a theme key, `chip` draws it as a solid block. */
export type Span = { text: string; color?: string; chip?: boolean }

/** One row of a panel tab, the shape omp's panel/model.ts gives it: a head row groups the item rows after it
 *  and is never selected; an item row carries the `id` its acts and detail are addressed by. */
export type Row = {
  kind: 'head' | 'item'
  text: string
  /** Right-aligned suffix: a head row's count, an item's `:line` or `3 files`. */
  right?: string
  /** Lines added and removed, each in its own right-aligned column; zero or missing leaves it blank. */
  add?: number
  del?: number
  /** Theme key of the row's leading marker (a status letter). */
  color?: string
  /** Where an item's text is cut when too wide: at its start (a path) or, by default, at its end. */
  cut?: 'start' | 'end'
  /** The row as colored runs (a log row); `text` stays what the filter reads. The last span gives way. */
  spans?: Span[]
  /** A head row that continues the list above it (a graph connector): no blank row before it. */
  tight?: boolean
  id?: string
}

/** One line of a detail: `no` its number in the gutter, `kind` colors it (`hunk` is a later hunk's header). */
export type DetailLine = { text: string; no?: number; kind?: 'add' | 'del' | 'hit' | 'hunk' }

/** The selected item's preview: a title (cut at its start), a tail kept after it, a dim note, then lines. */
export type Detail = { title: string; tail?: string; note?: string; lines: DetailLine[]; more?: string }

/** Everything the pane's Client draws, sanitised by the hooks module: the strip, and the active tab's rows,
 *  keys and the detail of `id` (the row the hooks module resolved the selection to). */
export type PanelProps = {
  tabs: { title: string; lost: boolean }[]
  /** The tab the rows are for. */
  tab: number
  rows: Row[]
  id?: string
  detail?: Detail
  /** The tab's own keys for the key bar, `[key, what it does]`. */
  keys: [string, string][]
  /** What enter does: the tab's act, or the detail shown full-height (the files tab). */
  enter: 'act' | 'full'
  /** Why the tab's last load failed, drawn in place of its rows. */
  failed?: string
  /** The last act the hooks module finished, by the Client's sequence number. */
  done: number
}

declare module 'claude-code' {
  interface PluginState {
    'org-todo': { todos: Todo[]; panel: PanelProps }
  }
}
