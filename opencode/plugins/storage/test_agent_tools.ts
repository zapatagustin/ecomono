/**
 * Agent tool-name test — run: bun run test_agent_tools.ts
 *
 * Agent definitions name MCP tools as strings in frontmatter. A typo there does not
 * fail anywhere: the agent simply launches without the tool and discovers it mid-run,
 * with no way to recover. This is the only thing that ties those strings to the
 * server that has to answer them.
 */
import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import assert from "assert"

const { registryByName } = await import("./tools")
const AGENTS = join(import.meta.dir, "..", "..", "..", "claude", "agents")
const PREFIX = "mcp__ecomono-memory__"

const files = readdirSync(AGENTS).filter((f) => f.endsWith(".md"))
assert(files.length > 0, `no agent definitions under ${AGENTS}`)

let checked = 0
for (const file of files) {
  const body = readFileSync(join(AGENTS, file), "utf8")
  const tools = body.match(/^tools:.*$/m)?.[0] ?? ""
  for (const named of tools.matchAll(new RegExp(`${PREFIX}(\\w+)`, "g"))) {
    assert(
      registryByName[named[1]],
      `${file} declares ${named[0]}, which the tool registry does not serve`
    )
    checked++
  }
}
assert(checked > 0, "no mem_* tools declared by any agent — did the frontmatter format change?")

// The phases that persist an artifact upsert a stable topic_key, so their saves come
// back needing judgment. Without mem_judge they cannot finish what mem_save started.
for (const file of files) {
  const body = readFileSync(join(AGENTS, file), "utf8")
  const tools = body.match(/^tools:.*$/m)?.[0] ?? ""
  if (!tools.includes(`${PREFIX}mem_save`)) continue
  assert(
    tools.includes(`${PREFIX}mem_judge`),
    `${file} can mem_save but not mem_judge — it cannot resolve the candidates its own saves return`
  )
}

console.log(`✓ agent tools: ${checked} declarations across ${files.length} agents all served`)
