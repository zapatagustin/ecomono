/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const CYNDAQUILL = [
  "      ╭──────────────────╮",
  "      │  ╭────────────╮  │",
  "      │  │  ◕   ═   ◕  │🔥│",
  "      │  │   ╰────╯   │  │",
  "      │  ╰────────────╯  │",
  "      ╰────────┬─────────╯",
  "              ╱│╲",
  "             ╱ │ ╲",
]

const CYNDAQUILL_NO_FIRE = [
  "      ╭──────────────────╮",
  "      │  ╭────────────╮  │",
  "      │  │  ◕   ═   ◕  │  │",
  "      │  │   ╰────╯   │  │",
  "      │  ╰────────────╯  │",
  "      ╰────────┬─────────╯",
  "              ╱│╲",
  "             ╱ │ ╲",
]

const tui: TuiPlugin = async (_api: unknown, options: unknown) => {
  const opts = (options ?? {}) as Record<string, unknown>
  const showFlames = opts.flames !== false
  const lines = showFlames ? CYNDAQUILL : CYNDAQUILL_NO_FIRE

  const api = _api as {
    slots: {
      register: (config: {
        mode: string
        slots: Record<string, (ctx: { theme: { current: Record<string, string> } }) => unknown>
      }) => void
    }
  }

  api.slots.register({
    id: "cyndaquill",
    order: 999,
    mode: "replace",
    slots: {
      home_logo(ctx) {
        const primary = ctx.theme.current?.primary ?? "#FFFFFF"
        const muted = ctx.theme.current?.textMuted ?? "#888888"
        const accent = ctx.theme.current?.accent ?? "#E0C15A"

        return (
          <box flexDirection="column" alignItems="center">
            {lines.map((line) => (
              <text fg={primary}>{line}</text>
            ))}
            <box flexDirection="row" gap={0} marginTop={1}>
              <text fg={muted}>╭ </text>
              <text fg={accent}>C y n d a q u i l l</text>
              <text fg={muted}> ╮</text>
            </box>
            <text> </text>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "cyndaquill",
  tui,
}

export default plugin
