#!/usr/bin/env bun
/**
 * Semantic retroactive conflict scan — standalone CLI, run out-of-band.
 *
 * Ports the idea from Gentleman-Programming/engram PR #282 (an LLM judges
 * candidate pairs of observations for supersedes/conflicts/etc), with one
 * deliberate divergence: candidates come from a vocabulary-blind pre-filter
 * (same project + type + active), NOT from FTS. FTS is exactly what misses a
 * pair like "Hexagonal architecture" vs "Ports and Adapters" — no shared
 * words, so conflicts.ts's bm25 pass never surfaces it as a judgment
 * candidate at save time. This scan re-examines everything already in the
 * store, pairwise within same-type buckets, and lets an LLM catch the
 * paraphrase.
 *
 * NOT an MCP tool: a synchronous `claude -p` call per pair would block the
 * MCP session for the whole scan. Run this by hand instead.
 *
 * Usage:
 *   bun conflict-scan.ts --project <name> [--type <t>] [--max-pairs N] [--model haiku] [--apply]
 *
 * Dry-run (default): prints the verdicts it would record, persists nothing.
 * --apply: persists through conflicts.ts's existing judge()/recordRelation()
 * path — a semantic verdict is treated exactly like a save-time judgment.
 */
import { parseArgs } from "util"
import { getDb } from "./db"
import * as Conflicts from "./conflicts"
import type { Relation } from "./conflicts"

// Types worth a semantic pass: the same ones carrying a review TTL in
// observations.ts (decision, architecture, config, pattern) — where a
// contradiction is a judgment call about which version stands, not just an
// append-only fact (bugfix/discovery/learning/manual accumulate, they don't
// usually "conflict").
const JUDGMENT_PRONE_TYPES = ["decision", "architecture", "config", "pattern"]

const DEFAULT_MAX_PAIRS = 50
const DEFAULT_MODEL = "haiku"
const MAX_CONTENT_CHARS = 400
const RUNNER_TIMEOUT_MS = 30_000

interface Row {
  id: number
  title: string
  content: string
  type: string
  created_at: string
}

export interface Pair {
  // a is always the newer of the two (by created_at, id DESC tiebreak) — the
  // same convention conflicts.ts uses for a fresh save vs. an existing
  // candidate, so "supersedes" always means "a supersedes b" with no
  // separate direction field needed in the judge prompt.
  a: Row
  b: Row
}

export interface Verdict {
  pair: Pair
  relation: Relation | null // null = skipped (parse failure, timeout, or runner error)
  reason: string
  error?: string
}

export interface ScanOptions {
  project: string
  type?: string
  maxPairs?: number
  model?: string
  apply?: boolean
}

export interface ScanResult {
  pairs: Pair[]
  totalCandidates: number
  dropped: number
  verdicts: Verdict[]
}

// One runnable check per the sibling conventions: `bun run conflict-scan.ts`
// alone (no --project) prints usage and exits 1 rather than crashing.

function typesToScan(explicitType?: string): string[] {
  return explicitType ? [explicitType] : JUDGMENT_PRONE_TYPES
}

function pairKey(x: number, y: number): string {
  return x < y ? `${x}-${y}` : `${y}-${x}`
}

// Pairs to skip entirely: already related (either direction — memory_relations
// is directional, from_id/to_id) or already judged (judgments table, resolved
// or not — an unresolved judgment still means a human or a prior scan already
// saw this pair). This is what makes re-running the scan idempotent per pair.
function excludedPairs(db: ReturnType<typeof getDb>): Set<string> {
  const excluded = new Set<string>()
  for (const r of db.query("SELECT from_id, to_id FROM memory_relations").all() as any[]) {
    excluded.add(pairKey(r.from_id, r.to_id))
  }
  for (const r of db.query("SELECT new_id, candidate_id FROM judgments").all() as any[]) {
    excluded.add(pairKey(r.new_id, r.candidate_id))
  }
  return excluded
}

// All same-type-bucket pairs for the project, newest-first, excluding
// already-related/already-judged pairs. Ordering key is the newer member's
// created_at: sorting each per-type row set DESC (id DESC tiebreak) and
// pairing i<j means a=rows[i] is always newer than b=rows[j], so a pair's own
// sort key is simply a.created_at/a.id — no separate composite needed.
function candidatePairs(db: ReturnType<typeof getDb>, project: string, types: string[]): Pair[] {
  const excluded = excludedPairs(db)
  const out: { pair: Pair; created_at: string; id: number }[] = []
  for (const type of types) {
    const rows = db.query(
      "SELECT id, title, content, type, created_at FROM observations WHERE project_id=? AND type=? AND state='active' ORDER BY created_at DESC, id DESC"
    ).all(project, type) as Row[]
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j]
        if (excluded.has(pairKey(a.id, b.id))) continue
        out.push({ pair: { a, b }, created_at: a.created_at, id: a.id })
      }
    }
  }
  out.sort((x, y) => (x.created_at !== y.created_at ? (x.created_at < y.created_at ? 1 : -1) : y.id - x.id))
  return out.map((o) => o.pair)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

function buildPrompt(pair: Pair): string {
  return `You are comparing two memory observations from the same project to decide their semantic relation.

Observation 1 (newer, id=${pair.a.id}):
Title: ${pair.a.title}
Content: ${truncate(pair.a.content, MAX_CONTENT_CHARS)}

Observation 2 (older, id=${pair.b.id}):
Title: ${pair.b.title}
Content: ${truncate(pair.b.content, MAX_CONTENT_CHARS)}

Pick exactly one relation from this list:
- supersedes: Observation 1 replaces Observation 2 (same decision/topic, 2 is now obsolete).
- conflicts_with: they contradict each other but neither clearly replaces the other.
- related: same topic, no contradiction or replacement.
- compatible: different topics that merely share terminology, no real relation.
- scoped: both true, but in different non-overlapping scopes/contexts.
- not_conflict: no meaningful relation.

Respond with ONLY strict JSON, no markdown fences, no extra text:
{"relation": "<one of the six words above>", "reason": "<one short sentence>"}`
}

function parseVerdict(raw: string): { relation: Relation; reason: string } | null {
  const match = raw.trim().match(/\{[\s\S]*\}/)
  if (!match) return null
  let obj: any
  try { obj = JSON.parse(match[0]) } catch { return null }
  if (!obj || typeof obj.relation !== "string" || !Conflicts.RELATIONS.includes(obj.relation)) return null
  return { relation: obj.relation as Relation, reason: typeof obj.reason === "string" ? obj.reason : "" }
}

export type Runner = (prompt: string, model: string) => Promise<string | null>

// Real judge: spawns the user's own `claude` CLI, one pair at a time.
// `--tools=` (equals form, empty value) turns off every built-in tool;
// `--strict-mcp-config` with no --mcp-config given turns off every MCP
// server too — together they're the only combination that fully removes
// tool access. Verified by hand: `--tools ""` (space form) breaks, because
// --tools is variadic and swallows the next argv token (the prompt) into its
// tool list, leaving `claude -p` with no prompt at all. The equals form
// avoids that ambiguity entirely, since it's a single argv token.
export const cliRunner: Runner = async (prompt, model) => {
  const proc = Bun.spawn(["claude", "-p", "--model", model, "--tools=", "--strict-mcp-config", prompt], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timedOut = new Promise<null>((resolve) => {
    setTimeout(() => { try { proc.kill() } catch { /* already exited */ } ; resolve(null) }, RUNNER_TIMEOUT_MS)
  })
  const ran = (async () => {
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    return code === 0 ? text : null
  })()
  return Promise.race([ran, timedOut])
}

function applyVerdict(pair: Pair, relation: Relation, reason: string, project: string) {
  const db = getDb()
  const judgmentId = `scan-${pair.a.id}-${pair.b.id}`
  db.run(
    "INSERT OR REPLACE INTO judgments (id, new_id, candidate_id, project_id, suggested_relation, confidence) VALUES (?, ?, ?, ?, ?, ?)",
    [judgmentId, pair.a.id, pair.b.id, project, relation, null]
  )
  // Goes through the exact same path a save-time judgment call does: only
  // 'supersedes' retires a row (candidate_id, since a is newer), everything
  // else (short of not_conflict) records a relation, not_conflict just marks
  // the judgment resolved so a re-run skips the pair.
  Conflicts.judge(judgmentId, relation, reason)
}

export async function scan(opts: ScanOptions, runner: Runner = cliRunner): Promise<ScanResult> {
  const db = getDb()
  const types = typesToScan(opts.type)
  const all = candidatePairs(db, opts.project, types)
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS
  const kept = all.slice(0, maxPairs)
  const dropped = all.length - kept.length
  const model = opts.model || DEFAULT_MODEL

  const verdicts: Verdict[] = []
  for (const pair of kept) {
    let raw: string | null
    try {
      raw = await runner(buildPrompt(pair), model)
    } catch (e) {
      verdicts.push({ pair, relation: null, reason: "", error: `runner error: ${(e as Error).message}` })
      continue
    }
    if (raw === null) {
      verdicts.push({ pair, relation: null, reason: "", error: "timeout or non-zero exit" })
      continue
    }
    const parsed = parseVerdict(raw)
    if (!parsed) {
      verdicts.push({ pair, relation: null, reason: "", error: `unparseable output: ${truncate(raw, 200)}` })
      continue
    }
    verdicts.push({ pair, relation: parsed.relation, reason: parsed.reason })
    if (opts.apply) applyVerdict(pair, parsed.relation, parsed.reason, opts.project)
  }
  return { pairs: kept, totalCandidates: all.length, dropped, verdicts }
}

function report(result: ScanResult, applied: boolean) {
  console.log(
    `candidate pairs: ${result.totalCandidates} found, ${result.pairs.length} scanned, ${result.dropped} dropped (max-pairs cap)`
  )
  for (const v of result.verdicts) {
    const label = `#${v.pair.a.id} (${v.pair.a.title}) / #${v.pair.b.id} (${v.pair.b.title})`
    if (v.relation) {
      console.log(`  ${label}: ${v.relation}${v.reason ? " — " + v.reason : ""}`)
    } else {
      console.log(`  ${label}: SKIPPED (${v.error})`)
    }
  }
  console.log(applied ? "--apply: verdicts persisted." : "dry-run: nothing persisted. Pass --apply to record these verdicts.")
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      project: { type: "string" },
      type: { type: "string" },
      "max-pairs": { type: "string" },
      model: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  })
  if (!values.project) {
    console.error("usage: bun conflict-scan.ts --project <name> [--type <t>] [--max-pairs N] [--model haiku] [--apply]")
    process.exit(1)
  }
  getDb() // initialize schema
  const result = await scan({
    project: values.project,
    type: values.type,
    maxPairs: values["max-pairs"] ? Number(values["max-pairs"]) : undefined,
    model: values.model,
    apply: values.apply,
  })
  report(result, !!values.apply)
}

if (import.meta.main) await main()
