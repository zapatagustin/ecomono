#!/usr/bin/env bun
// Prints the omp user settings that bind each routing rung's role to its ordered candidates:
//
//   bun omp/roles-snippet.ts
//
// Merge the output into ~/.omp/agent/config.yml; ecomono never writes that file. Merge, do not paste: if the
// file already has `modelRoles`, `retry` or `contextPromotion` (`/model` writes `modelRoles`), add these entries
// under the existing key, or the file ends up with a duplicate top-level key. Source: `candidates` in
// claude/hooks/routing.json (rung -> ordered `provider/id` selectors) and TIER_ROLE (rung -> omp role).

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO, TIER_ROLE } from "./extensions/ecomono/index.ts"

// Same rule as check-routing-drift.sh: omp stores a role's list comma-joined, so a selector holds no comma or space.
const SELECTOR = /^[a-z0-9-]+\/[A-Za-z0-9._/-]+$/

export function renderRolesSnippet(candidates: Record<string, string[]>, tierRole: Record<string, string>): string {
  const rungs = Object.keys(candidates)
  const unlisted = Object.keys(tierRole).find((tier) => !rungs.includes(tier))
  if (unlisted !== undefined) throw new Error(`${unlisted} has a role but no candidates`)
  const roles = rungs.map((rung) => {
    if (!Object.hasOwn(tierRole, rung)) throw new Error(`${rung} has no omp role`)
    const list = candidates[rung]
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${rung} has no candidates`)
    const bad = list.find((s) => typeof s !== "string" || !SELECTOR.test(s))
    if (bad !== undefined) throw new Error(`${rung}: ${JSON.stringify(bad)} is not a provider/id selector`)
    return `  ${tierRole[rung].replace(/^@/, "")}: [${list.join(", ")}]`
  })
  // omp takes the first authenticated selector of a role's list when a session or subagent starts. These three
  // keep it there: none of them lets omp move a running session to another model, so a usage limit ends the run.
  return [
    "modelRoles:",
    ...roles,
    "retry:",
    "  modelFallback: false",
    "  usageAwareFallback: false",
    "contextPromotion:",
    "  enabled: false",
    "",
  ].join("\n")
}

if (import.meta.main) {
  try {
    const routing = JSON.parse(readFileSync(join(REPO, "claude/hooks/routing.json"), "utf8"))
    process.stdout.write("# Merge into the keys already in ~/.omp/agent/config.yml; a second copy of a key breaks it.\n")
    process.stdout.write(renderRolesSnippet(routing.candidates ?? {}, TIER_ROLE))
  } catch (e) {
    console.error(`roles-snippet: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
