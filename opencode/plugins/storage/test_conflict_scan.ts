/**
 * Conflict-scan test — run: bun run test_conflict_scan.ts
 * Exercises pair generation, exclusion, max-pairs truncation, the --apply
 * persistence path (mocked runner, no real `claude -p` calls), malformed
 * runner output, and dry-run. Self-contained.
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-cs-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const CS = await import("./conflict-scan")
const Obs = await import("./observations")
const C = await import("./conflicts")
const { getDb } = await import("./db")

function addObs(title: string, type: string, project: string, content = "content"): number {
  return Obs.save({ title, type, content, project })!.id
}

const pairKey = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`)

// (a) pair generation excludes already-related and already-judged pairs, both directions
{
  const a = addObs("Hexagonal architecture", "architecture", "px")
  const b = addObs("Ports and Adapters pattern", "architecture", "px")
  const c = addObs("Layered architecture", "architecture", "px")
  // a related to b (forward direction) -> excluded
  getDb().run("INSERT INTO memory_relations (from_id, to_id, relation) VALUES (?, ?, ?)", [a, b, "related"])
  // c already judged against b (reverse direction: new_id=c, candidate_id=b) -> excluded
  getDb().run(
    "INSERT INTO judgments (id, new_id, candidate_id, project_id, suggested_relation, confidence) VALUES (?, ?, ?, ?, ?, ?)",
    ["jud-test-1", c, b, "px", "related", 0.5]
  )

  const runner = async () => JSON.stringify({ relation: "related", reason: "same topic" })
  const result = await CS.scan({ project: "px", type: "architecture" }, runner)
  const pairIds = result.pairs.map((p) => pairKey(p.a.id, p.b.id))
  assert(!pairIds.includes(pairKey(a, b)), "already-related pair excluded")
  assert(!pairIds.includes(pairKey(b, c)), "already-judged pair excluded (reverse direction)")
  assert(pairIds.includes(pairKey(a, c)), "unrelated pair still a candidate")
}

// (b) max-pairs truncation reports the dropped count
{
  const proj = "trunc"
  for (let i = 0; i < 6; i++) addObs(`Decision ${i}`, "decision", proj)
  const runner = async () => JSON.stringify({ relation: "not_conflict", reason: "x" })
  const result = await CS.scan({ project: proj, type: "decision", maxPairs: 5 }, runner)
  assert(result.totalCandidates === 15, `6 rows -> 15 total pairs (got ${result.totalCandidates})`)
  assert(result.pairs.length === 5, `kept capped at max-pairs (got ${result.pairs.length})`)
  assert(result.dropped === 10, `dropped count reported (got ${result.dropped})`)
}

// (c) mocked runner's verdict persists via --apply: supersedes retires, not_conflict doesn't
{
  const proj = "apply"
  const older = addObs("Old config", "config", proj, "uses redis")
  const newer = addObs("New config", "config", proj, "uses postgres")
  const runner = async () => JSON.stringify({ relation: "supersedes", reason: "postgres replaces redis" })
  const result = await CS.scan({ project: proj, type: "config", apply: true }, runner)
  assert(result.verdicts.length === 1 && result.verdicts[0].relation === "supersedes", "supersedes verdict returned")
  assert(Obs.getObservation(older)!.state === "superseded", "older observation retired via judge() path")
  assert((Obs.getObservation(older) as any).superseded_by === newer, "superseded_by points at the newer observation")
  assert(C.relationsOf(newer).some((r: any) => r.relation === "supersedes" && r.to_id === older), "supersedes relation recorded")

  const proj2 = "apply-not-conflict"
  const x = addObs("Uses npm", "config", proj2)
  const y = addObs("Uses pnpm", "config", proj2)
  const runner2 = async () => JSON.stringify({ relation: "not_conflict", reason: "unrelated repos" })
  await CS.scan({ project: proj2, type: "config", apply: true }, runner2)
  assert(Obs.getObservation(x)!.state === "active" && Obs.getObservation(y)!.state === "active", "not_conflict leaves both active")
  assert(!C.relationsOf(x).some((r: any) => r.relation === "not_conflict"), "not_conflict records no relation row")
}

// (d) malformed runner output skips without crashing
{
  const proj = "malformed"
  addObs("A", "pattern", proj)
  addObs("B", "pattern", proj)
  const runner = async () => "not json at all {{{"
  const result = await CS.scan({ project: proj, type: "pattern" }, runner)
  assert(result.verdicts.length === 1, "one verdict produced")
  assert(result.verdicts[0].relation === null, "malformed output skipped, relation null")
  assert(typeof result.verdicts[0].error === "string" && result.verdicts[0].error.length > 0, "error logged")
}

// (e) dry-run persists nothing (no state change, no relation, no judgments row)
{
  const proj = "dryrun"
  const a = addObs("A1", "decision", proj)
  const b = addObs("B1", "decision", proj)
  const runner = async () => JSON.stringify({ relation: "supersedes", reason: "x" })
  const result = await CS.scan({ project: proj, type: "decision" }, runner) // apply omitted -> false
  assert(result.verdicts[0].relation === "supersedes", "verdict still computed in dry-run")
  assert(Obs.getObservation(a)!.state === "active" && Obs.getObservation(b)!.state === "active", "dry-run leaves both active")
  assert(C.relationsOf(a).length === 0 && C.relationsOf(b).length === 0, "dry-run records no relation")
  const row = getDb().query("SELECT 1 FROM judgments WHERE new_id=? AND candidate_id=?").get(Math.max(a, b), Math.min(a, b))
  assert(!row, "dry-run inserts no judgments row either")
}

console.log("✓ conflict-scan: pair exclusion, max-pairs cap, apply/dry-run persistence, malformed output all pass")
