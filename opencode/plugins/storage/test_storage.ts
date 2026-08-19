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
const Obs = await import("./observations")
const Sess = await import("./sessions")
const Prompts = await import("./prompts")

getDb()

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

closeDb()
console.log("✓ storage: all assertions passed")
