/**
 * The key a focused component's handleInput(data) got, by name. omp decodes keys with pi-tui's matchesKey; the
 * extension cannot import pi-tui (the tests run under plain Bun, no node_modules), so this decodes the few keys
 * the panel uses. omp pushes kitty keyboard flags 1 or 3 only (tui/src/terminal.ts), so unmodified letters stay
 * raw bytes and only modified or ambiguous keys arrive as CSI u (`\x1b[<code>;<mods>u`): tab is `\t` or code 9,
 * shift+tab is `\x1b[Z` or code 9 with modifier 2. The select keys (arrows, page up/down, enter, escape) go
 * through the KeybindingsManager omp hands the component, not here, except the raw forms below.
 */

const CSI_U = /^\x1b\[(\d+)(?:;(\d+))?(?::\d+)?u$/

/** `tab`, `shift+tab`, `escape`, `enter`, `backspace`, a single printable character, or undefined (a paste, an
 *  unknown escape sequence). */
export function keyOf(data: string): string | undefined {
  if (data === "\t") return "tab"
  if (data === "\x1b[Z") return "shift+tab"
  if (data === "\x1b") return "escape"
  if (data === "\r" || data === "\n") return "enter"
  if (data === "\x7f" || data === "\b") return "backspace"
  const csi = CSI_U.exec(data)
  if (csi) {
    const code = Number(csi[1])
    const mods = Number(csi[2] ?? "1")
    if (code === 9) return mods === 2 ? "shift+tab" : mods === 1 ? "tab" : undefined
    if (code === 27 && mods === 1) return "escape"
    if (code === 13 && mods === 1) return "enter"
    return undefined
  }
  // One printable character (a grapheme may be several code units: `é` composed is one, a flag is two).
  if (data.length === 0 || data.startsWith("\x1b") || /[\x00-\x1f\x7f]/.test(data)) return undefined
  const segments = [...new Intl.Segmenter().segment(data)]
  return segments.length === 1 ? data : undefined
}
