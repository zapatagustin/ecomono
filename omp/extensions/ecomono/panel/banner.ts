/**
 * The startup banner: omp's own welcome is off (startup.quiet; it drew the pi logo and a wordmark the VGA font
 * lacks glyphs for), and this draws in its place the desktop wallpaper's engraving (Doré, Paradise Lost VI.406,
 * the one nixos-config dithers for hyprpaper) cropped to its winged figure, the `omp` wordmark and the version and
 * working directory beside the block art, or under the picture.
 *
 * Two renderings of the same crop. With a terminal that draws images (omp's inline image support: kitty,
 * iTerm2, or sixel once the DA1 probe answers, which foot does) and a PNG to draw (ECOMONO_OMP_BANNER, the
 * 2-colour file nixos-config builds), omp's Image component places the picture: the engraving as the wallpaper
 * shows it. Otherwise, under a multiplexer that does not forward graphics (Zellij, in practice), the block-glyph fallback: ▀ ▄ █ half-block
 * pairs of the engraving thresholded at 30%, two colors, base00 and the theme's text.
 *
 * It is a widget above the editor (ctx.ui.setWidget, a component: no line cap, never sent to the model), shown
 * at session_start and taken down at the first prompt, as omp retires its welcome. A custom message would
 * also draw in the transcript, but every custom message goes to the model as a developer turn
 * (agent/src/compaction/messages.ts convertMessageToLlm), which a picture must not.
 *
 * @oh-my-pi/pi-tui (Image, TERMINAL) is imported lazily and only when a PNG is set: omp's loader resolves it,
 * the tests (plain Bun, no node_modules) never reach that import.
 *
 * Regenerate the art with: magick <plate.jpg> -colorspace Gray -gravity center -crop 62%x40%+0+12% +repage
 * -resize '72x36!' -auto-level -threshold 30% gray:- | half-block pairs (top pixel ▀, bottom ▄, both █).
 */

import { readFile } from "node:fs/promises"
import { fit, fitTail } from "./text.ts"

/** The omp theme methods drawn with (tui/src/theme/theme-class.ts). */
type Theme = { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string }

export const KEY = "ecomono-banner"

/** 72 columns, the figure's rows of the crop (the sky above it is solid and cut). */
export const ART = [
  "  ▀▀▀▀██████████████████████▄▄          ▀▀▀▀▀▀▀█████████████████████████",
  "       ████████████████████████▄       ▀▀  ▄▄       ▀▀▀▀████████████████",
  "         ▀███████▄   ▄████████▀         ▄    ▀▀            ▀▀▀█▀▀▀▀     ",
  "            ▄▀▀▀▀     ▄▀▀ ▀              ▄███▄▄▄▄   ▀▀▀                 ",
  "                  ▄ █▀   ██▄        ▄▄▄▄▄██████████                     ",
  "                  ▀▀       ▀█▄   ▀████████████████▄                     ",
  "▀▀█▄▄▄                      ▀██  ▄▄▄▀▀▀▀███████▀ ▀                      ",
  "▄▄▄ ▀▀▀▀  ▄                    ▀▀▀████▄▄▄▄▄▀▀███▄                       ",
  "     ▄▄    ▀▀  ▀███▄                 ▀▀▀█████▄▄███                      ",
  "                 ▀       ▀▀▄▄▄▄▄▄       ▀████████                       ",
  "                             ▀▀▀▀         ███████                       ",
]
const ART_WIDTH = 72
// ecomono: IMAGE_COLS/IMAGE_ROWS assume the 640x275 PNG at an 8x16 px cell (the crop's aspect follows the host's
// panelResolution); a different PNG or cell size needs the rows read from the PNG's size.
/** The picture's cells: the PNG is 640x275 at the VGA font's 8x16 px cell, about 80x17; capped to the art's width. */
const IMAGE_COLS = 72
const IMAGE_ROWS = 16

/** The `omp` wordmark in half-blocks, as omp's welcome sets it (tui/src/prompt/welcome.ts WORDMARK). */
const WORDMARK = ["▄▀▀▄ █▀▄▀▄ █▀▀▄", "▀▄▄▀ █ █ █ █▄▄▀", "           █"]

/** Below this many columns the art is left out and only the wordmark block is drawn: the art, its gap and the wordmark. */
const MIN_COLS = ART_WIDTH + 2 + 15

/** What the picture path needs from omp: the Image component and the live terminal capabilities. */
export interface Picture {
  /** omp's Image component for the PNG, or undefined when the terminal draws no images right now. */
  image(theme: Theme, requestRender: () => void): { render(width: number): readonly string[] } | undefined
}

/** The wordmark block: the wordmark, a blank, the version, the cwd (its tail), each cut to `room`. */
const sideBlock = (version: string, cwd: string, theme: Theme, room: number): string[] => [
  ...WORDMARK.map((l) => theme.fg("accent", fit(l, room))),
  "",
  theme.fg("dim", fit(`v${version}`, room)),
  theme.fg("muted", fitTail(cwd, room)),
]

/**
 * The banner component. With a picture and a terminal that draws it: the picture's rows, the wordmark block
 * under them (omp keeps an image line verbatim and reserves its rows, so the block cannot share them). A picture
 * that throws while building or rendering falls through to the art. Else the art at the left, the block at its right; narrow, the block alone.
 */
export function banner(version: string, cwd: string, theme: Theme, picture?: Picture, requestRender: () => void = () => {}): { render(width: number): string[]; invalidate(): void } {
  return {
    render(width: number): string[] {
      const lines: string[] = []
      const wide = width >= MIN_COLS
      // The picture's lines are omp's (reserved rows, then the payload line): untouched. omp's Image can throw in
      // its paint loop, so a throw here means the art draws instead.
      let pic: string[] | undefined
      if (wide) {
        try {
          const img = picture?.image(theme, requestRender)
          if (img) pic = Array.from(img.render(width), String)
        } catch {
          pic = undefined
        }
      }
      // omp crops a widget's lines silently, so every line is cut to its room here; the cwd keeps its tail. The block
      // sits under the picture (full width), beside the art (what the art leaves), or alone when narrow (full width).
      const room = wide && !pic ? width - ART_WIDTH - 2 : width
      const block = sideBlock(version, cwd, theme, room)
      if (pic) {
        // The block cannot share a reserved row, so it goes under the picture.
        for (const l of pic) lines.push(l)
        for (const l of block) lines.push(l)
      } else if (wide) {
        // The wordmark block sits beside the art, aligned to the figure's lower rows.
        const start = Math.max(0, ART.length - block.length - 1)
        for (let i = 0; i < ART.length; i++) {
          const side = block[i - start] ?? ""
          lines.push(theme.fg("text", ART[i]!) + (side ? `  ${side}` : ""))
        }
      } else {
        for (const l of block) lines.push(l)
      }
      lines.push("")
      return lines
    },
    invalidate() {},
  }
}

/**
 * The picture for `file`, through omp's own Image component, when the terminal draws images. The import is
 * dynamic: omp resolves @oh-my-pi/pi-tui, the tests never ask for a picture. `TERMINAL.imageProtocol` is live
 * (the sixel probe sets it after the first paint), so it is read on every render, and the Image is built once
 * it is set. A PNG that cannot be read means no picture: the art draws instead.
 */
export async function loadPicture(file: string, importTui: () => Promise<any> = () => import("@oh-my-pi/pi-tui")): Promise<Picture | undefined> {
  let bytes: string
  let tui: any
  try {
    // ecomono: no size cap and a hardcoded image/png: the path is a nix store file. If it ever stops being one,
    // stat a size cap and sniff the PNG signature here.
    bytes = (await readFile(file)).toString("base64")
    tui = await importTui()
  } catch {
    return undefined
  }
  let built: { render(width: number): readonly string[] } | undefined
  return {
    image(theme, requestRender) {
      if (!tui.TERMINAL?.imageProtocol) return undefined
      // ecomono: built once, with the first render's theme in fallbackColor; rebuild on a theme change.
      // Built once per banner; omp re-sends an inline placement on repaint, which a 29 KB PNG affords.
      built ??= new tui.Image(bytes, "image/png", { fallbackColor: (s: string) => theme.fg("dim", s) }, {
        maxWidthCells: IMAGE_COLS,
        maxHeightCells: IMAGE_ROWS,
        filename: "omp-banner.png",
        requestRender,
      })
      return built
    },
  }
}

/** Shows the banner above the editor; the returned function takes it down. */
export async function showBanner(ctx: any, version: string, pngFile: string | undefined = process.env.ECOMONO_OMP_BANNER): Promise<() => void> {
  const picture = pngFile ? await loadPicture(pngFile) : undefined
  ctx.ui.setWidget(KEY, (tui: any, theme: Theme) => banner(version, String(ctx.cwd ?? ""), theme, picture, () => tui?.requestRender?.()), { placement: "aboveEditor" })
  return () => ctx.ui.setWidget(KEY, undefined)
}
