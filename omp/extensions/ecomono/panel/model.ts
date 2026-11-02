/**
 * What a side-panel tab is (panel/panel.ts draws one; org-todo.ts, panel/files.ts and panel/log.ts provide
 * them). Types only: nothing here runs, so the tabs stay testable with a fake host.
 */

/** One drawn row. A head row groups the item rows after it and is never selected. */
export type Row = {
  kind: "head" | "item"
  text: string
  /** Right-aligned suffix, dim on a head row (a count), plain on an item (`:line`, `+a -d`). */
  right?: string
  /** Theme color of the row's leading marker (a status letter, a graph lane); the text keeps the row color. */
  color?: string
  /** What `act` and `detail` get for this row; item rows only. */
  id?: string
}

/** What a key does once an item is acted on. `refresh` re-reads the rows and keeps the selection by id; its
 *  `notice`, when set, is said first. `notice` alone says something without reloading. */
export type Action = { kind: "none" } | { kind: "notice"; text: string } | { kind: "close" } | { kind: "refresh"; notice?: string }

export interface Tab {
  name: string
  /** The tab strip label, with its count: `todo 6`, `files 4`, `log`. */
  title(): string
  /** The rows for the current filter (a substring match the tab applies to whatever it deems searchable). */
  rows(filter: string): Row[]
  /** Preview lines for the selected item, plain text; the panel clips and caps them. Synchronous: what is not
   *  loaded yet is `[]`, and `prefetch` fills it. */
  detail(id: string): string[]
  /** Called once per selected item, after the selection moves: loads what `detail(id)` will show. The panel
   *  redraws when it resolves. Tabs whose detail is known at load time leave it out. */
  prefetch?(id: string): Promise<void>
  /** The key bar: `[key, what it does]`, in order. `enter` is listed here like any other key. */
  keys: Array<[string, string]>
  /** The keys the tab handles, besides the panel's own (j k / tab esc q and the select keys). The panel
   *  sends them outside its filter mode only: while typing a filter every printable key belongs to the filter. */
  act(key: string, id: string): Promise<Action>
  /** Reload from its source: called on open, on `refresh`, and when the tab becomes active. */
  load(): Promise<void>
}

/** What the tabs take from omp: a process runner (`cwd` defaults to `host.cwd`), a way to open a file in the editor, and a notice. */
export interface Host {
  cwd: string
  exec(cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>
  openEditor(file: string, line: number): Promise<void>
  notify(text: string): void
}
