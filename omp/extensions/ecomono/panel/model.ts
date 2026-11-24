/**
 * What a side-panel tab is (panel/panel.ts draws one; org-todo.ts, panel/files.ts and panel/log.ts provide
 * them). Types only: nothing here runs, so the tabs stay testable with a fake host.
 */

/** A styled run of a row's text: `color` is a theme color name, `chip` draws it as a padded block. */
export type Span = { text: string; color?: string; chip?: boolean }

/** One drawn row. A head row groups the item rows after it and is never selected. */
export type Row = {
  kind: "head" | "item"
  text: string
  /** Right-aligned suffix, dim on a head row (a count), plain on an item (`:line`, `3 files`). */
  right?: string
  /** Lines added and removed, each drawn in its own right-aligned column; zero or missing leaves it blank. */
  add?: number
  del?: number
  /** Theme color of the row's leading marker (a status letter); the text keeps the row color. */
  color?: string
  /** How an item's text is cut when it is too wide: from its start (a path: the file name survives) or, by default,
   *  from its end on a word boundary. The marker (first grapheme and its space) is never cut. */
  cut?: "start" | "end"
  /** The row drawn as colored runs (a log row: graph lanes, chips); `text` stays what the filter and tests read.
   *  The last span gives way when the row is too wide. */
  spans?: Span[]
  /** A head row that continues the list above it (a graph connector), not the start of a section: no blank row before it. */
  tight?: boolean
  /** What `act` and `detail` get for this row; item rows only. */
  id?: string
}

/** One line of a detail: `no` is its line number in the gutter, `kind` colors a diff line (`hit` marks the line
 *  the detail is about, as a todo's own line among its neighbours). */
export type DetailLine = { text: string; no?: number; kind?: "add" | "del" | "hit" }

/** The selected item's preview, plain text (the panel sanitises it): an accent title, an optional dim note, then lines. */
export type Detail = {
  /** A path or an id; when too wide it is cut at its start. */
  title: string
  /** Kept whole after the title when it fits (a hunk header, branch names). */
  tail?: string
  /** A dim line under the title (author and date). */
  note?: string
  lines: DetailLine[]
  /** What was left out that the panel cannot count, `2 hunks más`; the panel adds the lines it cuts itself. */
  more?: string
}

/** What a key does once an item is acted on. `refresh` re-reads the rows and keeps the selection by id; its
 *  `notice`, when set, is said first. `notice` alone says something without reloading. */
export type Action = { kind: "none" } | { kind: "notice"; text: string } | { kind: "close" } | { kind: "refresh"; notice?: string }

export interface Tab {
  name: string
  /** The tab strip label, with its count once known: `todo 6`, `files 4`; `files` while its data has not loaded,
   *  never a made-up zero. */
  title(): string
  /** The rows for the current filter (a substring match the tab applies to whatever it deems searchable). */
  rows(filter: string): Row[]
  /** The preview of the selected item; the panel clips and caps it. Synchronous: what is not loaded yet is
   *  `undefined`, and `prefetch` fills it. */
  detail(id: string): Detail | undefined
  /** Called once per selected item, after the selection moves: loads what `detail(id)` will show. The panel
   *  redraws when it resolves. Tabs whose detail is known at load time leave it out. */
  prefetch?(id: string): Promise<void>
  /** The key bar: `[key, what it does]`, in order. `enter` is listed here like any other key. */
  keys: Array<[string, string]>
  /** The keys the tab handles, besides the panel's own (j k / tab esc q and the select keys). The panel
   *  sends them outside its filter mode only: while typing a filter every printable key belongs to the filter. */
  act(key: string, id: string): Promise<Action>
  /** Reload from its source: called on open (for every tab, so each strip count is known), on `refresh`, and when the tab becomes active. */
  load(): Promise<void>
}

/** What the tabs take from omp: a process runner (`cwd` defaults to `host.cwd`), a way to open a file in the editor, and a notice. */
export interface Host {
  cwd: string
  exec(cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>
  openEditor(file: string, line: number): Promise<void>
  notify(text: string): void
}
