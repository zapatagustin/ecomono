// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

const id = "cyndaquill"

const PIXEL_GRID: string[][] = [
  [
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    "▄|#000000|",
    "▄|#000000|",
    " |#000000|",
    " |#000000|",
    "▄|#000000|",
    "▀|#000000|#ef5a29",
    "▀|#000000|#000000",
    " ||",
    "▄|#000000|",
    "▀|#000000|#ef5a29",
    "▀|#000000|#000000"
  ],
  [
    " ||",
    " ||",
    " ||",
    "▄|#000000|",
    "▀|#000000|#638c9c",
    "▀|#000000|#638c9c",
    "▀|#000000|#638c9c",
    "▀|#000000|#638c9c",
    "▄|#000000|",
    "▀|#000000|#414141",
    "▀|#ef5a29|#ef5a29",
    "▀|#000000|#ef5a29",
    "▀|#000000|#414141",
    "▀|#ef5a29|#ef5a29",
    "▀|#ef5a29|#ef5a29",
    "▀|#000000|#ef5a29",
    "▀|#000000|#ef5a29",
    "▀|#ef5a29|#ef5a29",
    "▀|#ef5a29|#000000",
    "▀|#000000|"
  ],
  [
    " ||",
    " ||",
    "▀|#000000|#000000",
    "▀|#638c9c|#638c9c",
    "▀|#638c9c|#638c9c",
    "▀|#638c9c|#526b7b",
    "▀|#526b7b|#f7e684",
    "▀|#526b7b|#f7e684",
    "▀|#638c9c|#e6ce6b",
    "▀|#414141|#638c9c",
    "▀|#ef5a29|#414141",
    "▀|#ff9c29|#ffd629",
    "▀|#ef5a29|#ef5a29",
    "▀|#ffd629|#ffd629",
    "▀|#ef5a29|#ef5a29",
    "▀|#ef5a29|#ffd629",
    "▀|#ef5a29|#ef5a29",
    "▀|#ef5a29|#414141",
    "▀|#000000|#000000",
    "▄|#000000|"
  ],
  [
    " ||",
    "▀|#000000|#000000",
    "▀|#638c9c|#638c9c",
    "▀|#638c9c|#638c9c",
    "▀|#526b7b|#526b7b",
    "▀|#f7e684|#f7e684",
    "▀|#f7e684|#f7e684",
    "▀|#f7e684|#000000",
    "▀|#f7e684|#414141",
    "▀|#e6ce6b|#e6ce6b",
    "▀|#414141|#638c9c",
    "▀|#ffd629|#ff9c29",
    "▀|#ffd629|#ffd629",
    "▀|#ffd629|#ffd629",
    "▀|#ffd629|#ffd629",
    "▀|#ef5a29|#ffd629",
    "▀|#ef5a29|#ff9c29",
    "▀|#ef5a29|#ef5a29",
    "▀|#ef5a29|#000000",
    "▀|#000000|"
  ],
  [
    "▀|#000000|#000000",
    "▀|#638c9c|#638c9c",
    "▀|#638c9c|#638c9c",
    "▀|#638c9c|#f7e684",
    "▀|#f7e684|#f7e684",
    "▀|#f7e684|#f7e684",
    "▀|#000000|#f7e684",
    "▀|#f7e684|#f7e684",
    "▀|#f7e684|#e6ce6b",
    "▀|#e6ce6b|#a58c3a",
    "▀|#526b7b|#638c9c",
    "▀|#526b7b|#526b7b",
    "▀|#ff9c29|#526b7b",
    "▀|#ffd629|#526b7b",
    "▀|#ffd629|#ffd629",
    "▀|#ff9c29|#ffd629",
    "▀|#ef5a29|#ff9c29",
    "▀|#414141|#ef5a29",
    "▀|#000000|#ef5a29",
    "▄|#000000|"
  ],
  [
    "▀|#000000|",
    "▀|#638c9c|#000000",
    "▀|#f7e684|#000000",
    "▀|#000000|",
    "▀|#000000|#000000",
    "▀|#414141|#e6ce6b",
    "▀|#a58c3a|#414141",
    "▀|#a58c3a|#f7e684",
    "▀|#e6ce6b|#f7e684",
    "▀|#e6ce6b|#414141",
    "▀|#e6ce6b|#a58c3a",
    "▀|#e6ce6b|#e6ce6b",
    "▀|#638c9c|#e6ce6b",
    "▀|#526b7b|#526b7b",
    "▀|#414141|#000000",
    "▀|#ef5a29|#000000",
    "▀|#414141|#000000",
    "▀|#000000|",
    "▀|#000000|",
    "▀|#000000|"
  ],
  [
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    "▀|#000000|",
    "▀|#000000|#000000",
    "▀|#f7e684|#a58c3a",
    "▀|#414141|#f7e684",
    "▀|#f7e684|#414141",
    "▀|#e6ce6b|#414141",
    "▀|#414141|#e6ce6b",
    "▀|#e6ce6b|#e6ce6b",
    "▀|#e6ce6b|#e6ce6b",
    "▀|#000000|#000000",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||"
  ],
  [
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    "▀|#000000|",
    "▀|#ffffff|#000000",
    "▀|#e6ce6b|#000000",
    "▀|#a58c3a|#000000",
    "▀|#e6ce6b|#000000",
    "▀|#a58c3a|#414141",
    "▀|#e6ce6b|#414141",
    "▀|#e6ce6b|#a58c3a",
    "▀|#000000|#000000",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||"
  ],
  [
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    " ||",
    "▀|#000000|",
    "▀|#ffffff|#000000",
    "▀|#e6ce6b|#000000",
    "▀|#000000|",
    " |#000000|",
    " |#000000|",
    " |#000000|",
    " |#000000|",
    " |#000000|",
    " |#000000|"
  ]
]

type Cell = { ch: string; fg: string | null; bg: string | null }

const parseCell = (s: string): Cell => {
  const [ch, fg, bg] = s.split("|")
  return { ch, fg: fg || null, bg: bg || null }
}

const Logo = (props: { theme: TuiThemeCurrent }) => {
  const muted = props.theme?.textMuted ?? "#888888"
  const accent = props.theme?.accent ?? "#FCBF49"

  return (
    <box flexDirection="column" alignItems="center">
      {PIXEL_GRID.map((row) => (
        <box flexDirection="row" gap={0}>
          {row.map((s) => {
            const c = parseCell(s)
            return (
              <text fg={c.fg ?? "#FFFFFF"} bg={c.bg ?? undefined}>{c.ch}</text>
            )
          })}
        </box>
      ))}
      <box flexDirection="row" gap={0} marginTop={1}>
        <text fg={muted}>╭ </text>
        <text fg={accent}>C y n d a q u i l</text>
        <text fg={muted}> ╮</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    id,
    order: 999,
    slots: {
      home_logo(ctx) {
        return <Logo theme={ctx.theme.current} />
      },
    },
  })
}

const plugin = { id, tui }
export default plugin
