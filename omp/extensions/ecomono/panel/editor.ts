/**
 * Opens a file at a line in $EDITOR next to omp: a Zellij pane through ctx.ui.openTerminal when omp runs inside
 * Zellij (omp detects it by $ZELLIJ), else a detached foot window, the fallback nvim's <leader>ao uses
 * (nixos-config editors/neovim/lua/keymaps.lua). Without foot, or when the pane cannot open, the notice names
 * `file:line` so the user opens it by hand. Nothing here rejects.
 * ecomono: $EDITOR is split on whitespace (no quoting) and `+<line>` assumes a vi-style editor; an $EDITOR
 * with spaces in its path or another line syntax gets a wrong argv. Parse quotes if that ever matters.
 */

/** What this spawns with: injectable so the tests record the argv instead of opening windows. */
export interface Spawner {
  spawn(argv: string[], opts: { stdio: ["ignore", "ignore", "ignore"] }): { unref(): void }
  which(name: string): string | null
}

const bun: Spawner = {
  spawn: (argv, opts) => Bun.spawn(argv, opts),
  which: (name) => Bun.which(name),
}

export async function openEditor(ctx: any, file: string, line: number, io: Spawner = bun): Promise<void> {
  const where = `${file}:${line}`
  const say = (text: string): void => {
    try {
      ctx.ui.notify(text, "warning")
    } catch {
      // A notice that cannot be shown changes nothing.
    }
  }
  const argv = [...(process.env.EDITOR || "nvim").split(/\s+/).filter(Boolean), `+${line}`, file]
  const cwd: string = ctx.cwd
  if (process.env.ZELLIJ) {
    try {
      await ctx.ui.openTerminal({ multiplexer: "zellij", placement: "pane", command: argv, cwd })
    } catch (e) {
      say(`panel: could not open ${where}: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }
  const foot = io.which("foot")
  if (!foot) return say(`panel: no Zellij session and no foot; open ${where}`)
  try {
    // Detached: omp's stdio stays its own, and the window outlives this process.
    io.spawn([foot, `--working-directory=${cwd}`, ...argv], { stdio: ["ignore", "ignore", "ignore"] }).unref()
  } catch (e) {
    say(`panel: could not open ${where}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
