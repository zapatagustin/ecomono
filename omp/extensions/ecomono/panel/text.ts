/**
 * Column arithmetic for the panel: terminal columns, not code units. Bun.stringWidth measures (it counts a
 * wide character as two and a zero-width joiner as none); Intl.Segmenter keeps a grapheme cluster whole when
 * cutting. Nothing here knows about colors: color a string after fitting it.
 * ecomono: a tab counts 0 here while omp expands it; file text with tabs comes out short. Replace tabs before
 * measuring where that shows.
 */

export const width = (s: string): number => Bun.stringWidth(s)

/** `s` cut to `cols` columns, "…" last when cut; a grapheme cluster is never split. */
export const fit = (s: string, cols: number): string => {
  if (width(s) <= cols) return s
  if (cols <= 0) return ""
  let out = ""
  for (const { segment } of new Intl.Segmenter().segment(s)) {
    if (width(out + segment) > cols - 1) break
    out += segment
  }
  return `${out}…`
}

/** `s` cut to `cols` columns keeping its END, "…" first when cut; a grapheme cluster is never split. */
export const fitTail = (s: string, cols: number): string => {
  if (width(s) <= cols) return s
  if (cols <= 0) return ""
  let out = ""
  for (const { segment } of [...new Intl.Segmenter().segment(s)].reverse()) {
    if (width(segment + out) > cols - 1) break
    out = segment + out
  }
  return `…${out}`
}

/** `s` broken at spaces into lines of at most `cols` columns; a word wider than `cols` is cut with `fit`. */
export const wrap = (s: string, cols: number): string[] => {
  const lines: string[] = []
  let line = ""
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (width(next) <= cols) line = next
    else {
      if (line) lines.push(line)
      line = fit(word, cols)
    }
  }
  if (line) lines.push(line)
  return lines
}

/** `s` padded with spaces to exactly `cols` columns (cut when longer). */
export const pad = (s: string, cols: number): string => {
  const f = fit(s, cols)
  return f + " ".repeat(Math.max(0, cols - width(f)))
}

/** `left` and `right` on one line of `cols` columns; `right` wins the space, `left` is cut. */
export const sides = (left: string, right: string, cols: number): string => {
  const r = fit(right, cols)
  const l = fit(left, Math.max(0, cols - width(r) - (r ? 1 : 0)))
  return l + " ".repeat(Math.max(0, cols - width(l) - width(r))) + r
}

/** Control characters and escape sequences out of text that came from a file or a command: the panel draws
 *  it, and a stray ESC would otherwise reach the terminal. */
export const plain = (s: string): string => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ")
