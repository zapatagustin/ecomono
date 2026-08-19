/**
 * Tool-registry test — run: bun run test_tools.ts
 * Exercises the shared mem_* handlers directly (no opencode / no MCP runtime).
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-tools-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const { registryByName } = await import("./tools")
const Obs = await import("./observations")
const call = (name: string, args: any = {}) => registryByName[name].handler(args)

// every tool has a name, description, args shape, handler
const { registry } = await import("./tools")
for (const t of registry) {
  assert(t.name.startsWith("mem_"), `tool named ${t.name}`)
  assert(t.description.length > 5, `${t.name} has description`)
  assert(typeof t.handler === "function", `${t.name} has handler`)
  assert(t.args && typeof t.args === "object", `${t.name} has args shape`)
}

const saved = call("mem_save", { title: "Ported engram to bun", content: "native sqlite", type: "architecture", project: "ecomono" }) as any
assert(saved.id > 0, "mem_save returns id")

const found = call("mem_search", { query: "engram bun", project: "ecomono" }) as any
assert(found.match_mode === "all" && found.results.length === 1 && found.results[0].id === saved.id, "mem_search finds it")

const got = call("mem_get_observation", { id: saved.id }) as any
assert(got.title === "Ported engram to bun", "mem_get_observation")

assert((call("mem_update", { id: saved.id, content: "native bun:sqlite storage" }) as any).updated, "mem_update")
assert((call("mem_search", { query: "storage", project: "ecomono" }) as any).results.length === 1, "update reindexed")

assert((call("mem_pin", { id: saved.id }) as any).pinned, "mem_pin")
assert((call("mem_unpin", { id: saved.id }) as any).unpinned, "mem_unpin")

assert((call("mem_timeline", { project: "ecomono" }) as any).observations.length === 1, "mem_timeline")
assert((call("mem_stats", { project: "ecomono" }) as any).observations === 1, "mem_stats")
assert((call("mem_suggest_topic_key", { title: "Auth Model!" }) as any).topic_key === "auth-model", "mem_suggest_topic_key")

// --- mem_search: uniform { results, match_mode } envelope, auto-fallback only when implicit ---
call("mem_save", { title: "alpha token", content: "first doc", project: "modeproj" })
call("mem_save", { title: "beta token", content: "second doc", project: "modeproj" })

const implicitFallback = call("mem_search", { query: "alpha beta", project: "modeproj" }) as any
assert(implicitFallback.match_mode === "any (fallback)" && implicitFallback.results.length === 2,
  "implicit match_mode auto-falls back to any on zero AND results")

const explicitAll = call("mem_search", { query: "alpha beta", match_mode: "all", project: "modeproj" }) as any
assert(explicitAll.match_mode === "all" && explicitAll.results.length === 0, "explicit match_mode 'all' never falls back")

const explicitAny = call("mem_search", { query: "alpha beta", match_mode: "any", project: "modeproj" }) as any
assert(explicitAny.match_mode === "any" && explicitAny.results.length === 2, "explicit match_mode 'any' reports 'any', not '(fallback)'")

// --- mem_stats scoped through proj(): omitted project defaults to current project, not all projects ---
call("mem_save", { title: "stats scope check current project", content: "x", project: Obs.currentProject().project })
call("mem_save", { title: "stats scope check other project", content: "x", project: "statsprojOther" })
const statsCurrent = call("mem_stats", {}) as any
const statsExplicitCurrent = call("mem_stats", { project: Obs.currentProject().project }) as any
assert(statsCurrent.observations === statsExplicitCurrent.observations,
  "mem_stats with project omitted matches explicit current-project scope (not all projects)")

// --- mem_review scoping through the registry: project omitted returns only current-project items ---
const curReviewObs = call("mem_save", { title: "current project review item", content: "why", type: "manual", project: Obs.currentProject().project }) as any
const otherReviewObs = call("mem_save", { title: "other project review item", content: "why", type: "manual", project: "reviewprojOther" }) as any
Obs.update(curReviewObs.id, { review_after: "2000-01-01 00:00:00" })
Obs.update(otherReviewObs.id, { review_after: "2000-01-01 00:00:00" })
const reviewList = call("mem_review", { action: "list" }) as any[]
assert(reviewList.some((r: any) => r.id === curReviewObs.id), "mem_review list (project omitted) includes the current-project item")
assert(!reviewList.some((r: any) => r.id === otherReviewObs.id), "mem_review list (project omitted) excludes the other-project item")

// --- mem_update review_after: null clears, "" normalizes to null (does not poison), explicit date wins over a simultaneous type change ---
const clearObs = call("mem_save", { title: "review_after clear via mem_update", content: "why", type: "decision", project: "reviewprojClear" }) as any
assert(Obs.getObservation(clearObs.id)!.review_after !== null, "decision starts with a review_after")
call("mem_update", { id: clearObs.id, review_after: null })
assert(Obs.getObservation(clearObs.id)!.review_after === null, "mem_update with review_after: null clears it")

const emptyStringObs = call("mem_save", { title: "review_after empty string via mem_update", content: "why", type: "decision", project: "reviewprojClear" }) as any
call("mem_update", { id: emptyStringObs.id, review_after: "" })
assert(Obs.getObservation(emptyStringObs.id)!.review_after === null,
  "mem_update with review_after: '' normalizes to null instead of storing an immediately-due empty string")

const dateWinsObs = call("mem_save", { title: "explicit date wins over type change via mem_update", content: "why", type: "manual", project: "reviewprojClear" }) as any
call("mem_update", { id: dateWinsObs.id, type: "decision", review_after: "2099-01-01 00:00:00" })
assert(Obs.getObservation(dateWinsObs.id)!.review_after === "2099-01-01 00:00:00",
  "mem_update: explicit review_after wins over a simultaneous type change")

const doc = call("mem_doctor") as any
assert(doc.ok && doc.db_path.endsWith("memory.db") && doc.observations >= 1, "mem_doctor")
assert(doc.integrity === "ok", `mem_doctor probes integrity (got ${doc.integrity})`)

assert((call("mem_delete", { id: saved.id }) as any).deleted, "mem_delete")
assert(call("mem_get_observation", { id: saved.id }) === null, "deleted gone")

// --- session inactivity nudge (engram #178): simulated clock, no real sleeps ---
const { __setClock, __resetNudgeStateForTest } = await import("./tools")
let fakeNow = Date.now()
__setClock(() => fakeNow)
__resetNudgeStateForTest()

assert(!(call("mem_search", { query: "nonexistentxyz" }) as any).nudge, "no nudge right after reset")

for (let i = 0; i < 12; i++) call("mem_search", { query: "nonexistentxyz" })
assert(!(call("mem_context", {}) as any).nudge, "no nudge before 10 minutes elapse, even with 10+ calls")

fakeNow += 11 * 60 * 1000
const nudged = call("mem_search", { query: "nonexistentxyz" }) as any
assert(typeof nudged.nudge === "string" && nudged.nudge.includes("since last mem_save"), "nudge appears past 10min + 10 calls of inactivity")
assert(nudged.results && nudged.match_mode, "nudge is additive: existing envelope fields still present")

const notNudgedAgain = call("mem_context", {}) as any
assert(!notNudgedAgain.nudge, "no nudge twice within the 5-minute cooldown")

fakeNow += 6 * 60 * 1000
assert(typeof (call("mem_search", { query: "nonexistentxyz" }) as any).nudge === "string", "nudge repeats once the cooldown passes while still stale")

call("mem_save", { title: "reset nudge state", project: "nudgeproj" })
assert(!(call("mem_search", { query: "nonexistentxyz" }) as any).nudge, "mem_save resets the nudge counter and timer")

// --- mem_session_summary records the calls-vs-saves ratio ---
const Sess = await import("./sessions")
Sess.sessionStart("sess-tools", "nudgeproj")
call("mem_session_summary", { session_id: "sess-tools", content: "Goal: test\nAccomplished: stuff" })
const summary = Sess.getSession("sess-tools").summary as string
assert(/calls_vs_saves: \d+\/\d+/.test(summary), "session summary records the calls-vs-saves ratio")
assert(summary.includes("Accomplished: stuff"), "session summary keeps the agent-authored content")

console.log(`✓ tools: ${registry.length} tools, all assertions passed`)
