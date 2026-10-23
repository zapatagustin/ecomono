/**
 * skill-registry
 * Refreshes the project skill registry (.atl/skill-registry.md) when OpenCode
 * opens a directory and on every user prompt.
 *
 * Claude Code runs the same generator from a UserPromptSubmit hook. This plugin
 * provides the equivalent behavior without depending on shell interpolation or
 * command-file parse-time cwd.
 *
 * OpenCode 2.x runs plugins inside one long-lived background service and calls
 * `setup` once per location activation (first access, after idle eviction, on
 * reload), not once per launch. So `setup` refreshes for its location and a
 * `prompt` hook refreshes again on every prompt; without it a newly added skill
 * is missed until the next activation. The service also activates a `$HOME`
 * location shortly after every start, so the generator runs with `--cwd $HOME`
 * too. That is harmless: the generator is idempotent and fingerprint-cached.
 *
 * Everything here runs in the service, not the terminal: `node` resolves from the
 * PATH the service was spawned with, and console.error output is discarded unless
 * OpenCode runs with `--standalone --print-logs`. The generator itself exits 0
 * under --quiet, so its own failures are silent either way.
 *
 * The generator is ours (claude/hooks/ecomono-skill-registry.js, deployed to
 * ~/.claude/hooks/). It replaced `gentle-ai skill-registry refresh`, which was
 * the last live use of that binary here.
 */

import { execFile } from "child_process"
import { promisify } from "util"
import { homedir } from "os"
import { join } from "path"

const execFileAsync = promisify(execFile)
const GENERATOR = join(homedir(), ".claude", "hooks", "ecomono-skill-registry.js")

// Never rejects: every caller fires it without awaiting.
async function refresh(cwd: string) {
  try {
    await execFileAsync(
      // Not process.execPath: inside opencode that is the opencode binary itself
      // (a compiled Bun image), which cannot run a script by argv. The flake ships
      // nodejs and install.sh warns when it is missing, so resolve node from PATH.
      "node",
      [GENERATOR, "--quiet", "--cwd", cwd],
      { timeout: 30_000 },
    )
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      console.error("[skill-registry] node not on PATH; skill registry not refreshed")
    } else {
      console.error("[skill-registry] refresh failed:", err)
    }
  }
}

export default {
  id: "skill-registry",
  async setup(ctx: any) {
    // `directory` is required in v2, so the project fallback is defensive only. No
    // process.cwd() fallback: in the service that is $HOME, never the project.
    const cwd: string | undefined = ctx.location?.directory ?? ctx.location?.project?.directory
    if (!cwd) return

    // Don't await: activation is sequential and prompt admission waits on it.
    void refresh(cwd)
    // ecomono: runs are not deduplicated, so a prompt during a slow refresh starts a
    // second one. Add an in-flight guard if overlapping runs ever cause harm.
    await ctx.session.hook("prompt", () => {
      void refresh(cwd)
    })
    // Return nothing: the host calls any truthy return value as a cleanup.
  },
}
