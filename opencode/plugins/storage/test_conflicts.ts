/**
 * Conflict-resolution test — run: bun run test_conflicts.ts
 * Exercises the judgment flow: candidate detection, mem_judge relations,
 * supersede, compare, merge_projects. Self-contained.
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-conf-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const C = await import("./conflicts")
const Obs = await import("./observations")

// first save: nothing to conflict with
const r1 = C.saveWithJudgment({ title: "Auth model uses JWT", content: "access + refresh tokens", project: "p", topic_key: "arch/auth" })!
assert(r1.judgment_required === false && r1.candidates.length === 0, "first save has no candidates")

// same topic_key -> supersedes candidate
const r2 = C.saveWithJudgment({ title: "Auth model uses sessions", content: "server-side sessions now", project: "p", topic_key: "arch/auth" })!
assert(r2.judgment_required === true, "topic_key collision flags judgment")
const cand = r2.candidates.find((c) => c.observation_id === r1.id)!
assert(cand && cand.suggested_relation === "supersedes" && cand.confidence >= 0.8, "topic_key -> supersedes, high confidence")

// judge supersedes: old one retired, dropped from search, relation recorded
assert(C.judge(cand.judgment_id, "supersedes").resolved, "judge resolves")
assert(Obs.getObservation(r1.id)!.state === "superseded", "candidate marked superseded")
assert(Obs.search({ query: "JWT tokens", project: "p" }).length === 0, "superseded dropped from search")
assert(Obs.search({ query: "sessions server", project: "p" }).length === 1, "active still searchable")
assert(C.relationsOf(r2.id).some((rel: any) => rel.relation === "supersedes"), "supersedes relation recorded")

// exact duplicate -> ~0.98
const dupA = C.saveWithJudgment({ title: "Deploy via GH Actions", content: "on push to main", project: "q" })!
const dupB = C.saveWithJudgment({ title: "Deploy via GH Actions", content: "on push to main", project: "q" })!
const exact = dupB.candidates.find((c) => c.observation_id === dupA.id)!
assert(exact && exact.confidence >= 0.95, `exact dup high confidence (got ${exact?.confidence})`)

// judge as 'related' keeps both active, records relation
assert(C.judge(exact.judgment_id, "related").resolved, "judge related")
assert(Obs.getObservation(dupA.id)!.state === "active", "related keeps candidate active")

// idempotent / already-resolved judge
assert(C.judge(exact.judgment_id, "related").resolved, "re-judge is idempotent")
// unknown relation rejected
assert(!(C.judge("jud-nope", "supersedes" as any).resolved), "missing judgment rejected")

// bm25-ranked FTS overlap: shared common vocabulary is not a candidate, shared
// rare vocabulary is, and the strongest match ranks above the weaker ones.
// Every row here shares the common vocabulary, so an unranked OR matches all of
// them and returns five arbitrary rows as candidates.
const COMMON = "project should handle these files when running the service"
for (let i = 0; i < 8; i++) C.saveWithJudgment({ title: `Routine note ${i}`, content: COMMON, project: "fts" })
const strong = C.saveWithJudgment({ title: "Ranked candidates by bm25", content: `finder orders overlap by bm25 relevance, ${COMMON}`, project: "fts" })!
assert(strong.candidates.length === 0, `common vocabulary alone is not a candidate (got ${strong.candidates.length})`)

const probe = C.saveWithJudgment({ title: "bm25 relevance revisited", content: `orders overlap by bm25, ${COMMON}`, project: "fts" })!
const rare = probe.candidates.find((c) => c.observation_id === strong.id)
assert(rare && rare.suggested_relation === "related", "rare vocabulary overlap surfaces as a related candidate")
assert(probe.candidates[0].observation_id === strong.id, "strongest bm25 match ranks first among candidates")
assert(probe.candidates.length === 1, `noise rows stay below the floor (got ${probe.candidates.length})`)

// compare
const cmp = C.compare(dupA.id, dupB.id)
assert(cmp.similarity > 0.5 && cmp.shared_terms.includes("deploy"), "compare finds high similarity")
assert(cmp.relations.length >= 1, "compare surfaces recorded relation")

// merge projects
const mv = C.mergeProjects("q", "p")
assert(mv.moved_observations >= 2, `merge moved observations (got ${mv.moved_observations})`)
assert(Obs.stats("q").observations === 0, "source project emptied")

console.log("✓ conflicts: candidates, supersede, judge relations, compare, merge all pass")
