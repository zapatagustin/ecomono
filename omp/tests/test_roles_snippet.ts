// omp/roles-snippet.ts: the printed omp settings for the routing rungs — bun run test_roles_snippet.ts
import "./fake-pi.ts"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO, TIER_ROLE } from "../extensions/ecomono/index.ts"
import { renderRolesSnippet } from "../roles-snippet.ts"

const roles = { low: "@smol", high: "@deep" }

// (1) One list per role, in the candidates' order, then the settings that keep a run on the model it started with.
assert.equal(
  renderRolesSnippet({ low: ["a/x-1", "b/y.2"], high: ["c/org/z"] }, roles),
  [
    "modelRoles:",
    "  smol: [a/x-1, b/y.2]",
    "  deep: [c/org/z]",
    "retry:",
    "  modelFallback: false",
    "  usageAwareFallback: false",
    "contextPromotion:",
    "  enabled: false",
    "",
  ].join("\n"),
)

// (2) The repo's own table renders, and its rungs are exactly the ladder and exactly the tiers with a role.
const routing = JSON.parse(readFileSync(join(REPO, "claude/hooks/routing.json"), "utf8"))
assert.deepEqual(Object.keys(routing.candidates), routing.ladder)
assert.deepEqual(Object.keys(routing.candidates), Object.keys(TIER_ROLE))
assert.match(renderRolesSnippet(routing.candidates, TIER_ROLE), /^modelRoles:\n  smol: \[/)

// (3) Input that would print a broken or partial binding is refused. omp stores a role's list comma-joined, so a
// comma inside a selector would split it into two.
assert.throws(() => renderRolesSnippet({ low: ["a/x,b/y"], high: ["c/z"] }, roles), /low: "a\/x,b\/y" is not a provider\/id selector/)
assert.throws(() => renderRolesSnippet({ low: ["a/x y"], high: ["c/z"] }, roles), /is not a provider\/id selector/)
assert.throws(() => renderRolesSnippet({ low: [], high: ["c/z"] }, roles), /low has no candidates/)
assert.throws(() => renderRolesSnippet({ low: ["a/x"], mid: ["b/y"], high: ["c/z"] }, roles), /mid has no omp role/)
assert.throws(() => renderRolesSnippet({ low: ["a/x"] }, roles), /high has a role but no candidates/)
assert.throws(() => renderRolesSnippet({ low: ["a/x"], constructor: ["b/y"], high: ["c/z"] }, roles), /constructor has no omp role/)

console.log("ok   roles snippet")
