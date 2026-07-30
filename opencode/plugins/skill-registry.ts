/**
 * skill-registry
 * Refreshes the project skill registry when OpenCode starts.
 *
 * Claude Code runs the same generator from a UserPromptSubmit hook. OpenCode
 * loads plugins at startup, so this plugin provides the equivalent behavior
 * without depending on shell interpolation or command-file parse-time cwd.
 *
 * The generator is ours (claude/hooks/ecomono-skill-registry.js, deployed to
 * ~/.claude/hooks/). It replaced `gentle-ai skill-registry refresh`, which was
 * the last live use of that binary here.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "child_process"
import { promisify } from "util"
import { homedir } from "os"
import { join } from "path"

const execFileAsync = promisify(execFile)
const GENERATOR = join(homedir(), ".claude", "hooks", "ecomono-skill-registry.js")

export const SkillRegistryPlugin: Plugin = async (input) => {
  async function refreshSkillRegistry() {
    const cwd = input.directory || input.worktree || process.cwd()

    try {
      await execFileAsync(
        process.execPath,
        [GENERATOR, "--quiet", "--cwd", cwd],
        { timeout: 30_000 },
      )
    } catch (err) {
      console.error("[skill-registry] refresh failed:", err)
    }
  }

  // Don't await — keep OpenCode startup responsive. The command is
  // fingerprint-cached, so normal startup stays cheap.
  refreshSkillRegistry().catch((err) => {
    console.error("[skill-registry] unexpected refresh error:", err)
  })

  return {}
}

export default SkillRegistryPlugin
