/**
 * review-receipt-gate (opencode)
 *
 * The opencode half of the RDD delivery gate: refuse a `git push` / `gh pr create`
 * issued through the `bash` tool unless a review receipt exists for the exact bytes
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
 * ecomono: AN `ask` DECISION BECOMES A REFUSAL HERE. The script has three outcomes and
 * `tool.execute.before` has two — throw or return, with throwing the documented way to
 * block. `permission.ask` carries a ternary status but only fires when the tool requests
 * a permission, so a ruleset that allows `bash` outright would switch the gate off
 * silently. Stricter beats absent; see `docs/DESIGN.md` for the full call.
 *
 * ecomono: this fails OPEN on a missing script, a spawn failure, a timeout, or output
 * that is not the JSON the script promises — the same convention as the script's own
 * header, for the same reason: a review gate that fails closed on a broken environment
 * leaves the operator unable to push the fix for the gate. The enforcement lost is
 * nominal, since anything that can hide the script can also set
 * ECOMONO_ALLOW_UNREVIEWED_PUSH=1. Deleting the script is the cheaper bypass of the two
 * and it is silent and lasts the session, which the env var does not — named here
 * because a reviewer looked for it and found only the implication.
 *
 * Every fail-open path says so on stderr. Without that line the operator cannot tell
 * "the gate ran and allowed" from "the gate could not run", and those are the two states
 * this whole mechanism exists to keep apart — the Claude hook distinguishes them with an
 * `ask`, which opencode has no way to express.
 *
 * ecomono: the ceiling is the `bash` tool. A command the user runs themselves through
 * opencode's `!` shell path does not go through `tool.execute.before` at all — it is
 * dispatched by the session's own shell handler — so it is ungated. That is the same
 * boundary as the user running `git push` in a terminal: this gates the agent, and the
 * override already belongs to the user. Everything the script cannot see in a command
 * string it still cannot see here; that ceiling is written in the script and is not
 * repeated. Upgrade path is the same one: enforce in CI, where the party being gated
 * does not control the environment.
 *
 * Subagent `bash` calls ARE covered — verified from the shipped binary, not reasoned
 * about: `SessionTools.resolve` wraps every tool's `execute`, bash included, with
 * `i.trigger("tool.execute.before", ...)`, for a top-level session and a subagent
 * session alike, and `SessionPrompt.handleSubtask` fires that same trigger itself
 * before resolving the subagent's tools through that path. Two reviewers previously
 * raised this as unsettled from a read-only pass; it is now settled in the
 * affirmative.
 *
 * ecomono: a timeout kills the direct child, not its process group, so a `git diff` the
 * script spawned outlives it as an orphan. Bounded — one per timed-out call, and it
 * exits when the diff finishes — and closing it means dropping `execFile` for a detached
 * `spawn` with manual group signalling, which is more machinery than this plugin is.
 * Upgrade path if slow-repo retries ever pile up: `spawn` with `detached: true` and
 * `process.kill(-pid)`.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
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
// reach the callback's `stdout` argument — measured, exactly `maxBuffer` of them, on
// Node 24 and Bun 1.3.13 — and the branch below deliberately does not read them: a
// truncated JSON object is not a decision, so this is a fail-open like any other.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/**
 * Say on stderr that the gate did not run. Every caller treats "" as allow, and without
 * this line an allow because the gate passed and an allow because the gate broke are the
 * same observation. opencode captures plugin stderr in its logs.
 */
function failedOpen(why: string) {
  console.error(`[review-receipt-gate] failing open: ${why} — this delivery was NOT checked`)
}

/**
 * Run the gate and return its stdout, or "" for every failure mode. Never rejects:
 * every caller of this treats "no output" as allow, and an exception here would turn a
 * broken environment into a blocked push.
 */
function runGate(script: string, payload: string, cwd: string): Promise<string> {
  return new Promise((settle) => {
    let child
    try {
      child = execFile(
        script,
        [],
        { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES },
        (err: any, stdout) => {
          if (!err) return settle(stdout)
          // Ordered most specific first, which is the only reason `maxBuffer` comes
          // before `killed`. There is no collision to disambiguate: measured on Node 24
          // and Bun 1.3.13, an overrun sets `code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
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

export const ReviewReceiptGatePlugin: Plugin = async (input) => {
  // `$HOME` before `homedir()`, which is the order Node documents for `homedir()`
  // itself on POSIX. Bun does not follow it — measured: it resolves HOME once at
  // process start and ignores later assignment — so reading the variable directly is
  // what makes the plugin honour the HOME its session actually runs under, and is
  // what lets a test point at a fixture. Resolved per instance, not at module load,
  // for the same reason.
  const script = join(process.env.HOME || homedir(), ".claude", "hooks", "review-receipt-gate.sh")

  return {
    "tool.execute.before": async (hook, output) => {
      if (hook.tool !== "bash") return

      const command = output?.args?.command
      if (typeof command !== "string" || command === "") return

      // The script resolves the repository from its own cwd, exactly as the Claude
      // hook does. But opencode's `bash` tool takes an optional `workdir` and RUNS THE
      // COMMAND THERE — verified against the shipped binary (opencode 1.18.11): the
      // tool's schema is `workdir: p.optional(p.String)`, its cwd is computed as
      // `w.workdir ? resolve(w.workdir, U.directory) : U.directory`, and the tool's own
      // description tells the model to prefer `workdir` over an embedded `cd <dir> &&`.
      // Reading only `input.directory`/`input.worktree` evaluated the wrong repository
      // whenever a call set `workdir`: a silent allow when the session directory was
      // unarmed and the workdir target was armed, and a wrong approval the other way
      // round. So `output.args.workdir` is resolved the same way the tool resolves it —
      // relative to the session directory, an absolute path left untouched — and only
      // the fallback chain below is used when it is absent. Claude Code's Bash tool has
      // no per-call cwd override, which is why the shell hook this plugin shells out to
      // needs no equivalent.
      const sessionDir = input.directory || input.worktree || process.cwd()
      const workdir = output?.args?.workdir
      const cwd = typeof workdir === "string" && workdir !== "" ? resolve(sessionDir, workdir) : sessionDir

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
      throw new Error(reason)
    },
  }
}

export default ReviewReceiptGatePlugin
