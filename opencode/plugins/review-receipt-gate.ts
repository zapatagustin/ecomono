/**
 * review-receipt-gate (opencode)
 *
 * The opencode half of the RDD delivery gate: refuse a `git push` / `gh pr create`
 * issued through the `shell` tool unless a review receipt exists for the exact bytes
 * being delivered. Claude Code gets this from a `PreToolUse` hook registered in
 * `claude/settings.template.json`; until this file existed, a push from opencode was
 * ungated even in a repository with review mode armed.
 *
 * IT DOES NOT REIMPLEMENT THE GATE. It shells out to the same
 * `~/.claude/hooks/review-receipt-gate.sh`, feeding it the same
 * `{"tool_input":{"command":...}}` payload on stdin that Claude Code feeds it, and
 * translates the one JSON object it prints. That is the whole plugin.
 *
 * A rewrite would be a second copy of the hash formula, the base-branch candidate list,
 * the delivery detector, the alias chase and the release valve, kept equal to a shell
 * script by nothing but attention. The full argument is in `docs/DESIGN.md`; it is not
 * restated here, because the same reasoning written out twice is the drift this file
 * exists to avoid.
 *
 * `~/.claude/hooks/` rather than a path relative to this file, because that is where
 * both install paths put it — `install.sh` symlinks `claude/hooks` there and
 * `flake.nix` sets `".claude/hooks".source`. `skill-registry.ts` locates its generator
 * the same way, for the same reason.
 *
 * This is a v2 plugin (opencode 2.x): a default `{ id, setup }` whose `setup` registers
 * one `ctx.tool.hook("execute.before")`. v2 runs it inside the managed background
 * service, one instance per opened location, so `process.env` and stderr belong to that
 * service, not to the terminal that started opencode — both matter below.
 *
 * ecomono: AN `ask` DECISION BECOMES A REFUSAL HERE. The script has three outcomes and
 * `execute.before` has two — throw or return, with throwing the only way to block.
 * v1's `permission.ask` was rejected because it only fires when the tool requests a
 * permission, so a ruleset that allows the shell outright would switch the gate off
 * silently. v2's `ctx.permission.hook("evaluate")` lacks that hole (it runs on every
 * `shell` call whose command parses, `allow` included) and could prompt, but its event
 * carries no `workdir`, so it would gate the wrong repository (see the workdir note
 * below). Stricter beats wrong; see `docs/DESIGN.md` for the full call.
 *
 * ecomono: this fails OPEN on a missing script, a spawn failure, a timeout, or output
 * that is not the JSON the script promises — the same convention as the script's own
 * header, for the same reason: a review gate that fails closed on a broken environment
 * leaves the operator unable to push the fix for the gate. The enforcement lost is
 * nominal, since anything that can hide the script can also prefix the command with
 * ECOMONO_ALLOW_UNREVIEWED_PUSH=1. Deleting the script is the cheaper bypass of the two
 * and it is silent and lasts the session, which the prefix does not — named here
 * because a reviewer looked for it and found only the implication.
 *
 * Every fail-open path says so, on stderr AND in
 * `${XDG_STATE_HOME:-$HOME/.local/state}/ecomono/review-receipt-gate.log`. Without that
 * line the operator cannot tell "the gate ran and allowed" from "the gate could not
 * run", and those are the two states this whole mechanism exists to keep apart — the
 * Claude hook distinguishes them with an `ask`, which opencode has no way to express.
 * The file is the line that survives: the managed service discards its stderr once it
 * has started, `--standalone` does too unless `--print-logs` is passed, and the v2 ctx
 * has no log API.
 *
 * ecomono: THE RELEASE VALVE IS PREFIX-ONLY HERE. The script also honours an exported
 * ECOMONO_ALLOW_UNREVIEWED_PUSH=1, and under v2 the script runs with the SERVICE's env —
 * frozen when whichever CLI first started it spawned it — while the command itself runs
 * with the session's. A valve exported into that one shell would open the gate for
 * every session until the service restarts: a silent allow. So `runGate` strips it, and
 * only the per-command prefix still stands the gate down. Upgrade path, if the exported
 * form is ever wanted back: read it from the session env instead, which the hook event
 * does not carry today.
 *
 * ecomono: the ceiling is the `shell` tool. A command the user runs themselves through
 * opencode's `!` shell path does not go through `execute.before` at all — it is
 * dispatched by the session's own shell handler — so it is ungated. That is the same
 * boundary as the user running `git push` in a terminal: this gates the agent, and the
 * override already belongs to the user. Everything the script cannot see in a command
 * string it still cannot see here; that ceiling is written in the script and is not
 * repeated. Upgrade path is the same one: enforce in CI, where the party being gated
 * does not control the environment.
 *
 * The other half of that ceiling, and a different risk class: an MCP tool that can
 * deliver. `e.tool !== "shell"` returns early, so a hypothetical
 * `mcp__github__create_pull_request` is invisible here — and to the Claude hook too,
 * whose matcher is the equally narrow `Bash`. (Under v2 such a call runs inside a Code
 * Mode `execute` script, whose inner calls fire this hook under their own names, so it
 * would still reach here and still be skipped.) The distinction from the `!` path is
 * that the user initiates that one and already owns the override, while an MCP call is
 * the agent's, which is exactly who this gates.
 *
 * Not built, and the reason is not just that no such server is configured today
 * (`context7` and `ecomono-memory`, neither of which executes anything). It is that the
 * check does not transfer: this gate scans a command STRING for a delivery written in
 * the clear, and an MCP tool has structured arguments and no command string —
 * `{owner, repo, head, base}` contains no `push` to find. Gating it means a different
 * mechanism, deny-by-tool-name, sharing no code with this one, and today its list would
 * be empty. Build it the day an exec- or delivery-capable MCP server is installed: the
 * set of tools to refuse is knowable at that moment, which is the thing that makes
 * deny-by-name workable then and impossible now.
 *
 * ecomono: three more v2 ceilings, none of them reachable today, so none has code.
 * (a) A location with a `workspaceID` runs the shell remotely while this gate runs on
 * the host, against a local path that is the wrong repository or none (fail-open on
 * ENOENT). (b) Another plugin's `shell` `create.before` hook runs after this one and can
 * rewrite the command the gate already judged. (c) A `context` hook that renames the
 * shell tool's key makes this hook see the advertised name, not `shell`. Upgrade paths,
 * in order: remote-workspace handling, a gate in `create.before` (which cannot block
 * and sees no session, so not instead of this one), and a `bash` alias.
 *
 * Subagent `shell` calls ARE covered: the `execute.before` trigger lives in the tool
 * registry's `execute` (opencode core `tool.ts`, `beforeExecute`), which every session's
 * tool calls go through, a subagent's child session included.
 *
 * ecomono: a timeout kills the direct child, not its process group, so a `git diff` the
 * script spawned outlives it as an orphan. Bounded — one per timed-out call, and it
 * exits when the diff finishes — and closing it means dropping `execFile` for a detached
 * `spawn` with manual group signalling, which is more machinery than this plugin is.
 * Upgrade path if slow-repo retries ever pile up: `spawn` with `detached: true` and
 * `process.kill(-pid)`.
 */

import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// The script's slow path is one `git diff` per distinct merge-base. Generous, because
// the cost of being wrong is a fail-open push on a large repository. Not measured
// against a genuinely large diff — on this repo a call is 10-40ms — so read it as a
// bound chosen to be safe, not as a number anything established.
const TIMEOUT_MS = 30_000

// The script prints one small JSON object. Sized well past that so an ordinary run never
// gets near the limit. Exceeding it does NOT truncate-and-continue: Node and Bun both
// kill the child and deliver ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The captured bytes DO
// reach the callback's `stdout` argument — measured: exactly `maxBuffer` of them on
// Node 24 and Bun 1.3.13; Bun 1.4.2 delivers at least that many and often more, up to
// 176 KiB over in the runs measured. The branch below deliberately does not read them:
// a truncated JSON object is not a decision, so this is a fail-open like any other.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/**
 * Say that the gate did not run. Every caller treats "" as allow, and without this line
 * an allow because the gate passed and an allow because the gate broke are the same
 * observation. stderr is kept for `--print-logs`, but under the managed service nothing
 * reads it, so the line is also appended to a state file. A failure to write that file
 * is swallowed, because an allow must stay an allow. Thrown from the hook body it would
 * refuse; thrown from the execFile callback it would skip `settle` and leave the shell
 * call pending forever, since opencode only logs an uncaught exception.
 */
function failedOpen(why: string) {
  const line = `[review-receipt-gate] failing open: ${why} — this delivery was NOT checked`
  console.error(line)
  try {
    // `||`, not `??`: an empty XDG_STATE_HOME means unset, as `${XDG_STATE_HOME:-...}` does.
    const dir = join(process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), ".local", "state"), "ecomono")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "review-receipt-gate.log"), `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/**
 * Run the gate and return its stdout, or "" for every failure mode. Never rejects:
 * every caller of this treats "no output" as allow, and an exception here would turn a
 * broken environment into a blocked push.
 */
function runGate(script: string, payload: string, cwd: string): Promise<string> {
  // The service env minus the exported valve — see the header. Filtered rather than set
  // to `undefined`, which a child env can receive as the literal string "undefined".
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ECOMONO_ALLOW_UNREVIEWED_PUSH"))
  return new Promise((settle) => {
    let child
    try {
      child = execFile(
        script,
        [],
        { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES },
        (err: any, stdout) => {
          if (!err) return settle(stdout)
          // Ordered most specific first, which is the only reason `maxBuffer` comes
          // before `killed`. There is no collision to disambiguate: measured on Node 24
          // and Bun 1.3.13 and 1.4.2, an overrun sets `code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
          // with `killed: undefined`, so `killed` is true only for a real timeout. An
          // earlier version of this comment claimed the two collided — one judge
          // asserted it, another measured it, and the measurement won. Named separately
          // because they are different operator problems: a repository too slow for the
          // budget, versus the script breaking its own small-JSON contract.
          if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            failedOpen(`the gate printed more than ${MAX_STDOUT_BYTES} bytes and was killed`)
          else if (err.killed) failedOpen(`the gate did not finish within ${TIMEOUT_MS}ms`)
          // execFile also returns ENOENT when `cwd` itself does not exist, not only when
          // the script is missing — the message covers both rather than asserting one.
          else if (err.code === "ENOENT") failedOpen(`no gate script at ${script}, or no such cwd (${cwd})`)
          else failedOpen(`the gate exited with ${err.code ?? err.signal ?? "an error"}`)
          settle("")
        },
      )
    } catch (err: any) {
      // execFile itself throwing is a synchronous argument or spawn error. Untested:
      // with a fixed path and no arguments there is no input that reaches it. Kept
      // rather than deleted because without it the throw would propagate out of the
      // hook and refuse a delivery the gate never judged — fail-closed, on an
      // environment fault.
      failedOpen(`the gate could not be spawned (${err?.message ?? err})`)
      settle("")
      return
    }
    // The script exits before reading stdin on its early-allow paths — the release
    // valve and a missing `jq`. (Its empty-command check is NOT one of them: that runs
    // after `cat | jq` has already drained stdin, and the plugin filters empty commands
    // before getting here anyway.) Writing into a pipe whose only reader is gone raises
    // EPIPE on the stream, and an unhandled 'error' event on a stream takes down the
    // PROCESS, not the tool call: opencode dies on an ordinary allowed command.
    //
    // Guarded by tests/test_review_receipt_gate_epipe.ts — see that file for the current
    // measurement rather than a copy of it here. It is threadbare on purpose: the fault
    // only surfaces while the event loop is still cold, and enough work before the spawn
    // hides it. Measured, so as not to overstate it: a bare extra statement or one more
    // import did not move the rate; a `node:assert` import together with
    // `mkdtempSync`/`rmSync` took it to zero. Read that file's header before touching it.
    child.stdin?.on("error", () => {})
    child.stdin?.end(payload)
  })
}

export default {
  id: "review-receipt-gate",
  async setup(ctx: any) {
    // `$HOME` before `homedir()`, which is the order Node documents for `homedir()`
    // itself on POSIX. Bun does not follow it — measured: it resolves HOME once at
    // process start and ignores later assignment — so reading the variable directly is
    // what makes the plugin honour the HOME it actually runs under, and is what lets a
    // test point at a fixture. Resolved per instance, not at module load, for the same
    // reason.
    const script = join(process.env.HOME || homedir(), ".claude", "hooks", "review-receipt-gate.sh")
    // `location.directory`, not `location.project.directory`: the project directory is
    // the VCS root, and the shell tool runs in the location directory.
    const base: string = ctx.location.directory

    await ctx.tool.hook("execute.before", async (e: any) => {
      if (e.tool !== "shell") return

      const command = e.input?.command
      if (typeof command !== "string" || command === "") return

      // The script resolves the repository from its own cwd, exactly as the Claude
      // hook does. But opencode's `shell` tool takes an optional `workdir` and RUNS THE
      // COMMAND THERE: its schema has `workdir: Schema.optionalKey(Schema.String)`, and
      // the cwd it runs in is `FileAccess.resolvePath(location.directory, workdir)` —
      // a leading `~` or `~/` expanded against opencode's home, then a lexical resolve
      // against the location directory, an absolute path left untouched. Gating only
      // the location directory evaluated the wrong repository whenever a call set
      // `workdir`: a silent allow when the location was unarmed and the workdir target
      // was armed, and a wrong approval the other way round. So the workdir is resolved
      // the same way here. Claude Code's Bash tool has no per-call cwd override, which
      // is why the shell hook this plugin shells out to needs no equivalent.
      //
      // ecomono: a copy of `resolvePath` (opencode core `file-access.ts`), minus its
      // Windows path normalisation. `OPENCODE_TEST_HOME ?? homedir()` is opencode's own
      // home (util `global.ts`) — read from the same in-process env, so it agrees.
      // Upgrade path if the two drift: a test against the host's resolver.
      const w = e.input?.workdir
      const home = process.env.OPENCODE_TEST_HOME ?? homedir()
      const t =
        typeof w === "string" && w !== "" ? (w === "~" ? home : w.startsWith("~/") ? join(home, w.slice(2)) : w) : ""
      const cwd = t ? resolve(base, t) : base

      const stdout = await runGate(script, JSON.stringify({ tool_input: { command } }), cwd)
      if (stdout.trim() === "") return // allow: the script prints nothing to permit

      let parsed: any
      try {
        parsed = JSON.parse(stdout)
      } catch {
        failedOpen("the gate printed something that is not JSON")
        return
      }

      const decision = parsed?.hookSpecificOutput?.permissionDecision
      if (decision === undefined) {
        // JSON, but not the contract. Distinct from a recognised allow-shaped decision
        // below, which is the script deliberately permitting.
        failedOpen("the gate printed JSON with no permissionDecision")
        return
      }
      if (decision !== "deny" && decision !== "ask") return

      const reason =
        parsed?.hookSpecificOutput?.permissionDecisionReason ||
        parsed?.systemMessage ||
        "Review receipt gate refused this delivery."
      // The only hook that may throw: the host turns this into a failed `shell` call
      // with `reason` as its message, and the model continues.
      throw new Error(reason)
    })
  },
}
