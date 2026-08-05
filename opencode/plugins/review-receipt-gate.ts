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
 * Subagent `bash` calls are believed covered and that belief is REASONED, not observed:
 * plugins register once per opencode server process, not per session, and the hook's
 * input carries a `sessionID` per call rather than one per plugin instance, which is the
 * shape of a single global interceptor. Nobody has driven a live subagent through it.
 * Two reviewers raised it independently and neither could settle it from a read-only
 * pass. It matters more than the usual unverified caveat, because this repo's own
 * workflow delegates shell work to subagents constantly: if the hook does not fire
 * there, a whole class of delivery is ungated and looks exactly like an allow. Settle it
 * before treating the marker as enforcement.
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
import { join } from "node:path"

// The script's slow path is one `git diff` per distinct merge-base. Generous, because
// the cost of being wrong is a fail-open push on a large repository. Not measured
// against a genuinely large diff — on this repo a call is 10-40ms — so read it as a
// bound chosen to be safe, not as a number anything established.
const TIMEOUT_MS = 30_000

// The script prints one small JSON object. Sized well past that so a stdout that grows
// unexpectedly is truncated rather than silently dropping the decision.
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
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        script,
        [],
        { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES },
        (err: any, stdout) => {
          if (!err) return resolve(stdout)
          // Named separately because they are different operator problems: a timeout is
          // a repository too slow for the budget, a signal is the gate being killed, and
          // the rest is usually a missing or unrunnable script.
          if (err.killed) failedOpen(`the gate did not finish within ${TIMEOUT_MS}ms`)
          else if (err.code === "ENOENT") failedOpen(`no gate script at ${script}`)
          else failedOpen(`the gate exited with ${err.code ?? err.signal ?? "an error"}`)
          resolve("")
        },
      )
    } catch (err: any) {
      // execFile itself throwing is a synchronous argument or spawn error. Untested:
      // with a fixed path and no arguments there is no input that reaches it. Kept
      // rather than deleted because without it the throw would propagate out of the
      // hook and refuse a delivery the gate never judged — fail-closed, on an
      // environment fault.
      failedOpen(`the gate could not be spawned (${err?.message ?? err})`)
      resolve("")
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
      // hook does. `input.directory` is the session's, which is the one the bash tool
      // will run in unless the command itself changes it.
      const cwd = input.directory || input.worktree || process.cwd()

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
