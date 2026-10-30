/**
 * Open TODOs below the omp editor: the omp counterpart of opencode/tui-plugins/org-todo.tsx, display only.
 *
 * index.ts starts it from the main TUI session and hands in the parser (opencode/tui-plugins/org-todo/core.ts,
 * shared with the OpenCode plugin), so this file imports nothing across trees. One grep per tick over
 * `<cwd>/docs` and the org directory, the same command the OpenCode panel runs; a missing directory is silenced by
 * -s. omp draws at most 10 widget lines, so the widget is a `todo N` header and the first nine rows.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { homedir } from "node:os"
import { join } from "node:path"

/** What the extension takes from org-todo/core.ts. */
export interface OrgTodoCore {
  parse(stdout: string, roots: string[]): Array<{ src: string; line: number; text: string }>
  PATTERN: string
}

const KEY = "org-todo"
const POLL_MS = 3000
const MAX_ROWS = 9
const MAX_CHARS = 80

const clip = (s: string): string => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s)

/**
 * Tick once now, then every POLL_MS through ctx.setInterval (omp contains a throw there and clears the timer on
 * session_shutdown). Every failure leaves the previous widget in place and is logged, once per kind and session;
 * nothing here rejects.
 * pi.exec resolves on a timeout instead of rejecting (omp: exec/exec.ts:57-64), with `killed` set and whatever
 * stdout came before the kill, so a killed grep is a failure too: its partial output is not the answer. The exit
 * code is not checked: `grep -s` exits 2 whenever one of the directories is missing, matches or not.
 * ecomono: ticks are not deduplicated, so a grep slower than POLL_MS overlaps the next one; the exec timeout bounds
 * the pile-up. Add an in-flight guard if a huge org directory ever makes that visible.
 */
export function startOrgTodo(pi: ExtensionAPI, ctx: any, core: OrgTodoCore): void {
  const orgDir = process.env.ECOMONO_ORG_DIR || join(homedir(), "work/org")
  const dirs = [`${ctx.cwd}/docs`, orgDir]
  // One warning per kind and session: a tick runs every POLL_MS, so a failure that repeats would otherwise flood the
  // log. Separate kinds, so a timeout does not hide a failure or the other way round.
  const warned = new Set<string>()
  const warnOnce = (kind: string, text: string): void => {
    if (warned.has(kind)) return
    warned.add(kind)
    pi.logger.warn(text)
  }
  const tick = (): void => {
    pi.exec("grep", ["-rnHsE", "--include=*.org", "--include=*.md", core.PATTERN, ...dirs], {
      cwd: ctx.cwd,
      timeout: 10_000,
    })
      .then((result) => {
        if (result?.killed) {
          warnOnce("timeout", "ecomono: org-todo grep timed out; keeping the previous widget")
          return
        }
        const todos = core.parse(String(result?.stdout ?? ""), dirs)
        if (todos.length === 0) ctx.ui.setWidget(KEY, undefined)
        else {
          const rows = todos.slice(0, MAX_ROWS).map((t) => clip(`${t.src}:${t.line} ${t.text}`))
          ctx.ui.setWidget(KEY, [`todo ${todos.length}`, ...rows], { placement: "belowEditor" })
        }
      })
      .catch((e) => warnOnce("failure", `ecomono: org-todo tick failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  tick()
  ctx.setInterval(tick, POLL_MS)
}
