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
 * The reason is the rule `docs/DESIGN.md` keeps returning to: two independent
 * derivations of one subject hash that can disagree is a defect this repo has already
 * shipped once. A TypeScript rewrite would be a second copy of the hash formula, the
 * base-branch candidate list, the token-level delivery detector, the alias chase and
 * the release valve — five things that would each have to be kept equal to a shell
 * script by nothing but attention. Six rounds of judges shaped that script; a port
 * would inherit the prose and not the fixes. Shelling out costs one subprocess on a
 * `bash` call and buys one implementation and one test suite.
 *
 * `~/.claude/hooks/` rather than a path relative to this file, because that is where
 * both install paths put it — `install.sh` symlinks `claude/hooks` there and
 * `flake.nix` sets `".claude/hooks".source`. `skill-registry.ts` locates its generator
 * the same way, for the same reason.
 *
 * ecomono: AN `ask` DECISION BECOMES A REFUSAL HERE. The shell gate has three
 * outcomes — allow, `ask` (armed but no base resolves, or `git diff` failed) and
 * `deny`. opencode's `tool.execute.before` has two: throw or return. Throwing is the
 * documented way to block a tool call (opencode.ai/docs/plugins shows exactly this
 * shape for its .env guard), and there is no third value to return. `permission.ask`
 * does carry a `status: "ask" | "deny" | "allow"`, but it only fires when the tool
 * actually requests a permission, and a ruleset that allows `bash` outright never
 * reaches it — a gate that silently stops existing under a permissive config is worse
 * than one that is stricter than its sibling. So both `ask` states block, and the
 * reason text the script already writes names the fix in each case. The difference is
 * one retry after a `git config ecomono.reviewBase`, in the direction that does not
 * let a delivery through.
 *
 * ecomono: this fails OPEN on a missing script, a spawn failure, a timeout, or output
 * that is not the JSON the script promises — the same convention as the script's own
 * header, for the same reason: a review gate that fails closed on a broken environment
 * leaves the operator unable to push the fix for the gate. The enforcement lost is
 * nominal, since anything that can hide the script can also set
 * ECOMONO_ALLOW_UNREVIEWED_PUSH=1.
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
 * Worth checking before relying on it.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

// The script's slow path is one `git diff` per distinct merge-base. Generous, because
// the cost of being wrong is a fail-open push on a large repository.
const TIMEOUT_MS = 30_000

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
        { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? "" : stdout),
      )
    } catch {
      resolve("")
      return
    }
    // The script exits before reading stdin on its early-allow paths — the release
    // valve, a missing `jq`, an empty command. Writing into a pipe whose only reader
    // is gone raises EPIPE on the stream, and an unhandled 'error' event on a stream
    // takes down the PROCESS, not the tool call: opencode dies on an ordinary allowed
    // command.
    //
    // Guarded by tests/test_review_receipt_gate_epipe.ts, which fails 20/20 with this
    // line deleted. That file is threadbare on purpose: the fault only surfaces while
    // the event loop is still cold, so an extra import or a cleanup call before the
    // spawn hides it. A version built on a shared fixture helper measured 5/20 and led
    // to the wrong conclusion that this could not be tested at all. Read that file's
    // header before adding anything to it.
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
        return // fail open: not the contract, so nothing to enforce
      }

      const decision = parsed?.hookSpecificOutput?.permissionDecision
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
