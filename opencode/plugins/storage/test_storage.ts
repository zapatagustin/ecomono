/**
 * Storage smoke test — run: bun run test_storage.ts
 * Uses a throwaway ECOMONO_DATA_DIR so it never touches real memory.
 * No framework: plain assertions, exits non-zero on failure.
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-test-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db") // skip migration

const { getDb, closeDb } = await import("./db")
const db = getDb()
const Obs = await import("./observations")
const Sess = await import("./sessions")
const Prompts = await import("./prompts")

// --- observations: save + FTS5 search ---
const a = Obs.save({ title: "Chose Zustand over Redux", content: "state mgmt decision", type: "decision", project: "proj1" })!
const b = Obs.save({ title: "Fixed N+1 query in UserList", content: "eager load fixed slow endpoint", type: "bugfix", project: "proj1" })!
assert(a.id > 0 && b.id > a.id, "save returns increasing ids")

const hitRedux = Obs.search({ query: "Redux", project: "proj1" })
assert(hitRedux.length === 1 && hitRedux[0].id === a.id, "FTS5 finds by title term")
const hitQuery = Obs.search({ query: "query endpoint", project: "proj1" })
assert(hitQuery.length === 1 && hitQuery[0].id === b.id, "FTS5 AND-matches content terms")
assert(Obs.search({ query: "zustand redux", match_mode: "any", project: "proj1" }).length >= 1, "match_mode any works")
assert(Obs.search({ query: "nonexistentxyz", project: "proj1" }).length === 0, "no false positives")

// --- bm25 weighting: title match outranks content-only match ---
const titleHit = Obs.save({ title: "widget rollout plan", content: "unrelated body", project: "rankproj" })!
const contentHit = Obs.save({ title: "unrelated title", content: "mentions widget only in the body", project: "rankproj" })!
const ranked = Obs.search({ query: "widget", project: "rankproj" })
assert(ranked.length === 2 && ranked[0].id === titleHit.id && ranked[1].id === contentHit.id, "title match ranks above content-only match")

// --- topic_key indexed: a term appearing ONLY in topic_key is findable ---
const topicOnlyMatch = Obs.save({ title: "generic title", content: "generic body", topic_key: "quibblewhatsit-key", project: "topickeyproj" })!
assert(Obs.search({ query: "quibblewhatsit", project: "topickeyproj" }).length === 1, "topic_key-only term is findable via search")

// --- topic_key weighting: title(5.0) ranks above topic_key(3.0), which ranks above content-only(1.0) ---
const titleHit2 = Obs.save({ title: "sprocket rollout plan", content: "unrelated body", project: "topicrank" })!
const topicHit2 = Obs.save({ title: "unrelated title", content: "unrelated body", topic_key: "sprocket-part", project: "topicrank" })!
const contentHit2 = Obs.save({ title: "unrelated title two", content: "mentions sprocket only in the body", project: "topicrank" })!
const rankedByTopic = Obs.search({ query: "sprocket", project: "topicrank" })
assert(
  rankedByTopic.length === 3 &&
  rankedByTopic[0].id === titleHit2.id &&
  rankedByTopic[1].id === topicHit2.id &&
  rankedByTopic[2].id === contentHit2.id,
  "title match ranks above topic_key match, which ranks above content-only match"
)

// --- NULL topic_key rows still save/search fine ---
const nullTopic = Obs.save({ title: "no topic key gremlin", content: "gremlin body text", project: "topicrank" })!
assert(Obs.getObservation(nullTopic.id)!.topic_key == null, "topic_key defaults to null when omitted")
assert(Obs.search({ query: "gremlin", project: "topicrank" }).some((r) => r.id === nullTopic.id), "row with NULL topic_key still searchable by title/content")

// --- bm25 ties break by newest id when they also share a clock second ---
const tieA = Obs.save({ title: "gizmo report", content: "gizmo report", project: "tieproj" })!
const tieB = Obs.save({ title: "gizmo report", content: "gizmo report", project: "tieproj" })!
// Identical title+content ties bm25 exactly; force the same created_at to
// simulate two saves landing in the same clock second, so the assertion
// exercises the o.id DESC tie-break rather than created_at.
db.run("UPDATE observations SET created_at = '2024-01-01T00:00:00Z' WHERE id IN (?, ?)", [tieA.id, tieB.id])
const tied = Obs.search({ query: "gizmo report", project: "tieproj" })
assert(tied.length === 2 && tied[0].id === tieB.id && tied[1].id === tieA.id, "same-second bm25 ties break newest-id-first")

// --- match_mode: 'any' finds rows split across docs that 'all' cannot ---
Obs.save({ title: "alpha token", content: "first doc", project: "modeproj" })
Obs.save({ title: "beta token", content: "second doc", project: "modeproj" })
assert(Obs.search({ query: "alpha beta", project: "modeproj" }).length === 0, "match_mode all finds nothing when terms split across docs")
assert(Obs.search({ query: "alpha beta", match_mode: "any", project: "modeproj" }).length === 2, "match_mode any finds both")

// --- FTS5 metacharacters stay safely quoted in both modes ---
assert.doesNotThrow(() => Obs.search({ query: 'foo* OR "bar', project: "proj1" }), "match_mode all: metacharacters stay quoted, no syntax error")
assert.doesNotThrow(() => Obs.search({ query: 'foo* OR "bar', match_mode: "any", project: "proj1" }), "match_mode any: same quoting holds")

// --- project scoping ---
Obs.save({ title: "other project note", content: "isolated", project: "proj2" })
assert(Obs.search({ query: "note", project: "proj1" }).length === 0, "search is project-scoped")
assert(Obs.search({ query: "note", all_projects: true }).length === 1, "all_projects overrides scope")

// --- get / update / FTS stays consistent after update ---
const got = Obs.getObservation(a.id)!
assert(got.title === "Chose Zustand over Redux", "getObservation returns row")
Obs.update(a.id, { content: "migrated to jotai" })
assert(Obs.search({ query: "jotai", project: "proj1" }).length === 1, "update refreshes FTS index")
assert(Obs.search({ query: "state", project: "proj1" }).length === 0, "old content dropped from FTS")

// --- pin / unpin / delete ---
assert(Obs.pin(a.id) && Obs.getObservation(a.id)!.pinned === 1, "pin sets flag")
assert(Obs.unpin(a.id) && Obs.getObservation(a.id)!.pinned === 0, "unpin clears flag")
Obs.del(b.id)
assert(Obs.getObservation(b.id) === null, "delete removes row")
assert(Obs.search({ query: "endpoint", project: "proj1" }).length === 0, "delete removes from FTS")

// --- stats ---
const st = Obs.stats("proj1")
assert(st.observations === 1, `stats counts project observations (got ${st.observations})`)

// --- sessions + summary + context ---
Sess.sessionStart("sess-1", "proj1")
Sess.sessionSummary("sess-1", "did the migration")
assert(Sess.getSession("sess-1").summary === "did the migration", "session summary persists")
const ctx = Sess.context("proj1")
assert(ctx.context.includes("jotai"), "context includes recent observation")

// --- prompts ---
Prompts.savePrompt("sess-1", "how do I port engram")
assert(Prompts.getPrompts("sess-1").length === 1, "prompt saved and fetched")

// --- topic key helper ---
assert(Obs.suggestTopicKey("Auth Model v2!") === "auth-model-v2", "topic key slugifies")

// --- review_after decay (engram #481): stamped per type at save time ---
const decisionObs = Obs.save({ title: "Chose event bus", content: "why", type: "decision", project: "reviewproj" })!
const archObs = Obs.save({ title: "Chose layered arch", content: "why", type: "architecture", project: "reviewproj" })!
const configObs = Obs.save({ title: "Set retry timeout", content: "why", type: "config", project: "reviewproj" })!
const patternObs = Obs.save({ title: "Established naming pattern", content: "why", type: "pattern", project: "reviewproj" })!
const bugfixObs = Obs.save({ title: "Fixed off-by-one", content: "why", type: "bugfix", project: "reviewproj" })!
const untypedObs = Obs.save({ title: "Untyped note", content: "why", project: "reviewproj" })!

assert(Obs.getObservation(decisionObs.id)!.review_after !== null, "decision gets review_after")
assert(Obs.getObservation(archObs.id)!.review_after !== null, "architecture gets review_after")
assert(Obs.getObservation(configObs.id)!.review_after !== null, "config gets review_after")
assert(Obs.getObservation(patternObs.id)!.review_after !== null, "pattern gets review_after")
assert(Obs.getObservation(bugfixObs.id)!.review_after === null, "bugfix has no review_after")
assert(Obs.getObservation(untypedObs.id)!.review_after === null, "untyped (manual) has no review_after")

// --- needs_review is virtual (computed at query time): a past review_after surfaces in mem_review's list ---
db.run("UPDATE observations SET review_after = datetime('now', '-1 day') WHERE id = ?", [decisionObs.id])
const due = Obs.review("list", undefined, undefined, "reviewproj") as any[]
assert(due.some((r: any) => r.id === decisionObs.id), "past-due observation appears in needs_review list")
assert(!due.some((r: any) => r.id === archObs.id), "not-yet-due observation absent from needs_review list")

// --- marking reviewed resets review_after from today using the same per-type TTL ---
Obs.review("mark_reviewed", decisionObs.id)
const afterReview = Obs.getObservation(decisionObs.id)!
assert(afterReview.review_after !== null, "mark_reviewed re-stamps review_after, does not clear it")
assert(new Date(afterReview.review_after!.replace(" ", "T") + "Z").getTime() > Date.now(), "re-stamped review_after lands in the future")
assert(!(Obs.review("list", undefined, undefined, "reviewproj") as any[]).some((r: any) => r.id === decisionObs.id), "reviewed observation drops off the needs_review list")

// mark_reviewed on a no-TTL type has nothing to reset to — stays null
Obs.review("mark_reviewed", bugfixObs.id)
assert(Obs.getObservation(bugfixObs.id)!.review_after === null, "mark_reviewed on a no-TTL type stays null")

// --- mem_stats cheaply surfaces the needs_review count ---
db.run("UPDATE observations SET review_after = datetime('now', '-1 day') WHERE id = ?", [archObs.id])
assert(Obs.stats("reviewproj").needs_review === 1, "stats counts past-due observations as needs_review")

// --- update() type change re-stamps review_after via the same per-type TTL ---
const promoteObs = Obs.save({ title: "will be promoted", content: "why", type: "manual", project: "reviewproj" })!
assert(Obs.getObservation(promoteObs.id)!.review_after === null, "manual starts with no review_after")
Obs.update(promoteObs.id, { type: "decision" })
assert(Obs.getObservation(promoteObs.id)!.review_after !== null, "type change manual->decision gains a review_after")

const demoteObs = Obs.save({ title: "will be demoted", content: "why", type: "decision", project: "reviewproj" })!
assert(Obs.getObservation(demoteObs.id)!.review_after !== null, "decision starts with a review_after")
Obs.update(demoteObs.id, { type: "bugfix" })
assert(Obs.getObservation(demoteObs.id)!.review_after === null, "type change decision->bugfix clears review_after")

const explicitObs = Obs.save({ title: "explicit review_after wins", content: "why", type: "manual", project: "reviewproj" })!
Obs.update(explicitObs.id, { type: "decision", review_after: "2099-01-01 00:00:00" })
assert(Obs.getObservation(explicitObs.id)!.review_after === "2099-01-01 00:00:00", "explicit review_after in the same call wins over the type-derived recompute")

// --- update() only re-stamps on a REAL type change, not on resending the same type ---
const sameTypeObs = Obs.save({ title: "resend same type", content: "why", type: "decision", project: "reviewproj" })!
db.run("UPDATE observations SET review_after = datetime('now', '-1 day') WHERE id = ?", [sameTypeObs.id])
const pastDue = Obs.getObservation(sameTypeObs.id)!.review_after
Obs.update(sameTypeObs.id, { type: "decision", content: "still why" })
assert(Obs.getObservation(sameTypeObs.id)!.review_after === pastDue,
  "resending the unchanged type does not move review_after — past-due stamp stays past-due")

// real transition still re-stamps (redundant with promoteObs/demoteObs above, kept as a direct regression check)
const realTransitionObs = Obs.save({ title: "real transition still re-stamps", content: "why", type: "decision", project: "reviewproj" })!
db.run("UPDATE observations SET review_after = datetime('now', '-1 day') WHERE id = ?", [realTransitionObs.id])
const stalePastDue = Obs.getObservation(realTransitionObs.id)!.review_after
Obs.update(realTransitionObs.id, { type: "config" })
const afterTransition = Obs.getObservation(realTransitionObs.id)!.review_after
assert(afterTransition !== stalePastDue && new Date(afterTransition!.replace(" ", "T") + "Z").getTime() > Date.now(),
  "a real type change still re-stamps review_after into the future")

// --- update() threads an explicit null through as a real NULL clear ---
const nullClearObs = Obs.save({ title: "explicit null clears review_after", content: "why", type: "decision", project: "reviewproj" })!
assert(Obs.getObservation(nullClearObs.id)!.review_after !== null, "decision starts with a review_after")
Obs.update(nullClearObs.id, { review_after: null })
assert(Obs.getObservation(nullClearObs.id)!.review_after === null, "explicit null clears review_after")

closeDb()
console.log("✓ storage: all assertions passed")
