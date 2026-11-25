// omp/roles-snippet.ts: the printed omp settings for the routing rungs — bun run test_roles_snippet.ts
import { ISOLATED } from "./fake-pi.ts"

import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { REPO, TIER_ROLE } from "../extensions/ecomono/index.ts"
import { SELECTOR, renderRolesSnippet } from "../roles-snippet.ts"

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

// (4) check-routing-drift.sh holds the same selector rule in jq, anchored with `\z` where JS has `$`. One edited
// without the other makes the drift check pass a table this script refuses, or the reverse.
const jqRule = /test\("(\^[^"]+)"\)/.exec(readFileSync(join(REPO, "check-routing-drift.sh"), "utf8"))?.[1]
assert.equal(jqRule?.replace("\\\\z", () => "$"), SELECTOR.source.replaceAll("\\/", "/"))

// (5) Run as a script, the merge note and the settings go to stdout.
const script = join(REPO, "omp/roles-snippet.ts")
const run = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, script, ...args])
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const printed = run()
assert.equal(printed.code, 0)
assert.match(printed.out, /^# Merge into the keys already in .*\nmodelRoles:\n  smol: \[/)

// (6) A selector listed twice in a rung is refused, as the drift check refuses it.
assert.throws(() => renderRolesSnippet({ low: ["a/x", "b/y", "a/x"], high: ["c/z"] }, roles), /low: "a\/x" is listed twice/)

// (7) A table the script refuses prints nothing on stdout, names the reason on stderr and exits 1. The table is
// the optional path argument; without it the script reads this repo's routing.json.
const table = join(ISOLATED, "routing.json")
writeFileSync(table, JSON.stringify({ candidates: { haiku: [], sonnet: ["a/b"], opus: ["a/b"], fable: ["a/b"] } }))
const refused = run(table)
assert.equal(refused.code, 1)
assert.equal(refused.out, "")
assert.match(refused.err, /^roles-snippet: haiku has no candidates$/m)

console.log("ok   roles snippet")
