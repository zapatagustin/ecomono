/**
 * Hardening checks from the engram scan: mem_context shape, project-guarded
 * pin/review, atomic save, <private> stripping, prompt FK, merge guards,
 * protocol text. Throwaway DB; plain assertions, no framework.
 */
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-hard-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const { getDb } = await import("./db")
const db = getDb()
const Obs = await import("./observations")
const Conflicts = await import("./conflicts")
const Prompts = await import("./prompts")
const { registryByName } = await import("./tools")
const { MEMORY_INSTRUCTIONS } = await import("./protocol")
const call = (name: string, args: any = {}) => registryByName[name].handler(args) as any

// --- 1+6. mem_context: active only, ids, pinned first, 300-char cut, newest summary whole ---
const old = Obs.save({ title: "Old fact", content: "stale body", project: "c" })!
const fresh = Obs.save({ title: "Fresh fact", content: "x".repeat(299) + "😀😀😀", project: "c" })!
const pinnedOld = Obs.save({ title: "Pinned older", content: "keep me", project: "c" })!
db.run("UPDATE observations SET state='superseded' WHERE id=?", [old.id])
db.run("UPDATE observations SET created_at = datetime('now','-1 day') WHERE id=?", [pinnedOld.id])
Obs.pin(pinnedOld.id)
const sumA = Obs.save({ title: "Session summary c 1", type: "session_summary", content: "old summary", project: "c" })!
const longSummary = "S".repeat(1000)
const sumB = Obs.save({ title: "Session summary c 2", type: "session_summary", content: longSummary, project: "c" })!
const ctx = call("mem_context", { project: "c" }).context as string
assert(!ctx.includes("Old fact"), "superseded row hidden from mem_context")
assert(ctx.includes(`## #${fresh.id} Fresh fact (`), "header carries id")
assert(ctx.indexOf("Pinned older") < ctx.indexOf("Fresh fact"), "pinned row first")
assert(ctx.includes(longSummary), "newest session_summary stays whole")
const freshBlock = ctx.split("\n\n").find((b) => b.includes("Fresh fact"))!
assert(freshBlock.includes("mem_get_observation") && freshBlock.includes(String(fresh.id)), "cut body points at mem_get_observation")
assert(!freshBlock.includes("😀😀😀") && freshBlock.isWellFormed(), "cut is codepoint-safe")
assert(sumA.id > 0 && sumB.id > sumA.id)

// --- timeline / stats / review list: active only ---
assert(!Obs.timeline("c").some((r) => r.id === old.id), "timeline hides superseded")
assert(Obs.stats("c").observations === 5 - 1, "stats counts active only")
db.run("UPDATE observations SET review_after = datetime('now','-1 day') WHERE id IN (?, ?)", [old.id, fresh.id])
const due = Obs.review("list", undefined, 10, "c") as any[]
assert(due.some((r) => r.id === fresh.id) && !due.some((r) => r.id === old.id), "review list hides superseded")

// --- 2. pin / mark_reviewed: project guard + honest result ---
assert(call("mem_pin", { id: 999999 }).pinned === false, "pin missing id -> false")
assert(call("mem_pin", { id: fresh.id, expected_project: "other" }).pinned === false, "pin wrong project -> false")
assert(call("mem_pin", { id: fresh.id, expected_project: "c" }).pinned === true, "pin right project")
assert(call("mem_unpin", { id: fresh.id, expected_project: "other" }).unpinned === false, "unpin wrong project -> false")
assert(call("mem_unpin", { id: 999999 }).unpinned === false, "unpin missing id -> false")
assert(call("mem_review", { action: "mark_reviewed", id: 999999, project: "c" }).success === false, "mark_reviewed missing id -> false")
assert(call("mem_review", { action: "mark_reviewed", id: fresh.id, project: "other" }).success === false, "mark_reviewed wrong project -> false")
assert(call("mem_review", { action: "mark_reviewed", id: fresh.id, project: "c" }).success === true, "mark_reviewed right project")

// --- 3. mem_save is atomic with conflict detection ---
Obs.save({ title: "Dup topic seed", content: "same body here", project: "t", topic_key: "k/t" })
const before = (db.query("SELECT COUNT(*) c FROM observations").get() as any).c
db.run("CREATE TRIGGER boom BEFORE INSERT ON judgments BEGIN SELECT RAISE(ABORT, 'locked'); END")
assert.throws(() => call("mem_save", { title: "Dup topic seed 2", content: "other", project: "t", topic_key: "k/t" }), /locked/)
db.run("DROP TRIGGER boom")
assert.strictEqual((db.query("SELECT COUNT(*) c FROM observations").get() as any).c, before, "failed detection leaves no row behind")

// --- 4. <private> stripping ---
const priv = call("mem_save", { title: "Key <private>sk-123</private> rotated", content: "a <private>secret</private> b <PRIVATE>x<private>y</private>LEAK</private> c tail <private>never closed", project: "p" })
const row = Obs.getObservation(priv.id)!
assert(!/sk-123|secret|LEAK|never closed|private/i.test(row.title + row.content), `private stripped: ${row.title} | ${row.content}`)
assert(row.content.includes("tail") && row.content.startsWith("a "), "surrounding text kept")
// tag variants (whitespace, attributes) fail closed too; a longer tag name is not the tag
for (const [o, c] of [["<private >", "</private >"], ["<private\n>", "</private\n>"], ["<private class=x>", "</private>"]]) {
  const v = call("mem_save", { title: `variant ${JSON.stringify(o)}`, content: `a ${o}SECRET${c} b`, project: "pv" })
  assert(Obs.getObservation(v.id)!.content === "a  b" && /stripped/.test(v.private_stripped), `variant ${JSON.stringify(o)} stripped and signalled`)
}
for (const t of ["privateer", "private-key"]) {
  const k = call("mem_save", { title: `kept ${t}`, content: `<${t}>secret</${t}>`, project: "pv" })
  assert(Obs.getObservation(k.id)!.content === `<${t}>secret</${t}>` && k.private_stripped === undefined, `<${t}> untouched`)
}
// matcher is linear: adversarial input must not block the synchronous server
for (const [name, adv] of [["ws run", "<" + " ".repeat(200_000)], ["opener run", "<private ".repeat(50_000)]] as const) {
  const t0 = performance.now(); Obs.stripPrivate(adv); const ms = performance.now() - t0
  console.log(`stripPrivate ${name}: ${ms.toFixed(1)} ms`)
  assert(ms < 250, `stripPrivate ${name} linear (${ms} ms)`)
}
// the tag name follows `<` immediately: comparisons and prose are not tags
for (const t of ["if (a < private && b > c) x", "x < private"]) {
  const w = call("mem_save", { title: `prose ${t}`, content: t, project: "pv" })
  assert(Obs.getObservation(w.id)!.content === t && w.private_stripped === undefined, `${t} stored whole`)
}
// deliberate: whitespace between `<` and the name no longer makes a tag
const sp = call("mem_save", { title: "spaced tag", content: "< private>secret</private>", project: "pv" })
// the stray </private> is still dropped, so only the closer goes
assert(Obs.getObservation(sp.id)!.content === "< private>secret" && sp.private_stripped !== undefined, "< private> is not an opener (deliberate)")
const sc = call("mem_save", { title: "self closing", content: "before <private/> after <private /> end", project: "pv" })
assert(Obs.getObservation(sc.id)!.content === "before  after  end", `self-closing opens no block: ${Obs.getObservation(sc.id)!.content}`)
// quoted attribute values are one unit: a `>` inside does not end the tag
const q = call("mem_save", { title: "quoted gt", content: `<private a="x>y">SECRET</private> tail <private b='p></private>q'>S2</private>`, project: "pv" })
assert(Obs.getObservation(q.id)!.content.trim() === "tail" && /stripped/.test(q.private_stripped), `quoted > : ${Obs.getObservation(q.id)!.content}`)
// fail-closed matcher spec, pinned row by row through stripPrivate/privateSignal directly
// (mem_save wiring is checked below for the headline rows). Each row: input, trimmed
// stored text, signal. A removed self-closing tag reports "stripped" (the text changed).
{
  const y = "y".repeat(300), a = "a".repeat(300)
  const rows: [string, string, "none" | "stripped" | "unterminated"][] = [
    ["<private note=don't>secret</private>ok", "ok", "stripped"],
    [`<private a="x>SECRET</private>t`, "t", "stripped"],
    [`<private x="${y}">secret</private>z`, "z", "stripped"],
    [`<private ${a}>secret</private>z`, "z", "stripped"],
    ["keep <private don't log this", "keep", "unterminated"],
    ["<private url=http://x/>secret</private>t", "t", "stripped"],
    ["before <private/> mid <private /> after", "before  mid  after", "stripped"],
    [`<private a="x>y">SECRET</private> tail`, "tail", "stripped"],
    ["<private >S</private >t", "t", "stripped"],
    ["<PRIVATE class=x>S</Private>t", "t", "stripped"],
    ["<private\n>S</private>t", "t", "stripped"],
    ["<private>a<private>b</private>c</private>d", "d", "stripped"],
    ["Map<private, string> y", "Map<private, string> y", "none"],
    ["<privateer>x</privateer>", "<privateer>x</privateer>", "none"],
    ["<private-key>x</private-key>", "<private-key>x</private-key>", "none"],
    ["if (a < private && b > c) x", "if (a < private && b > c) x", "none"],
    ["x <private.y> z", "x <private.y> z", "none"],
    ["<private,", "<private,", "none"],
    ["<private:x>", "<private:x>", "none"],
    // deliberate fail-closed cost: a bare `<private` in prose followed by a later `>` opens a block
    ["a <private && b > c", "a", "unterminated"],
    // a malformed closer does not close: everything from the opener on goes
    ["<private>S</private foo>t", "", "unterminated"],
  ]
  for (const [i, o, s] of rows) {
    const sig = Obs.privateSignal(i)
    const got = sig === undefined ? "none" : /unterminated/.test(sig) ? "unterminated" : "stripped"
    assert(Obs.stripPrivate(i).trim() === o.trim() && got === s, `matcher row ${JSON.stringify(i.slice(0, 40))}: ${JSON.stringify(Obs.stripPrivate(i))} ${got}`)
  }
  const fc = call("mem_save", { title: "fail closed", content: "<private note=don't>secret</private>ok", project: "pv" })
  assert(Obs.getObservation(fc.id)!.content === "ok" && /stripped/.test(fc.private_stripped), "mem_save: unbalanced apostrophe opener fails closed")
  const n = 300_000
  for (const [name, adv] of [["ws", "<" + " ".repeat(n)], ["openers", "<private ".repeat(n / 9)], ["dq openers", "<private \"".repeat(n / 10)], ["sq openers", "<private '".repeat(n / 10)], ["quotes", "\"".repeat(n)], ["long quote", "<private x=\"" + "y".repeat(n)], ["closers", "</private ".repeat(n / 10)], ["long tail", "<private " + "a".repeat(n)]] as const) {
    const t0 = performance.now(); Obs.stripPrivate(adv); const ms = performance.now() - t0
    console.log(`stripPrivate 300k ${name}: ${ms.toFixed(1)} ms`)
    assert(ms < 250, `stripPrivate 300k ${name} linear (${ms} ms)`)
  }
}
const n1 = Obs.save({ title: "Judge a", content: "alpha", project: "p" })!
const n2 = Obs.save({ title: "Judge b", content: "beta", project: "p" })!
db.run("INSERT INTO judgments (id,new_id,candidate_id,project_id,suggested_relation,confidence) VALUES ('j1',?,?,?,?,?)", [n2.id, n1.id, "p", "related", 0.5])
Conflicts.judge("j1", "related", "why <private>pw</private> ok")
assert(!(db.query("SELECT note FROM memory_relations").get() as any).note.includes("pw"), "judge note stripped")
assert(Obs.update(n1.id, { content: "z <private>q</private>" }, "p") && Obs.getObservation(n1.id)!.content === "z ", "update strips")
db.run("INSERT INTO projects (id,name) VALUES ('p','p') ON CONFLICT DO NOTHING")
db.run("INSERT INTO sessions (id, project_id) VALUES ('s-priv','p')")
Prompts.savePrompt("s-priv", "hello <private>tok</private>")
assert((Prompts.getPrompts("s-priv")[0] as any).content === "hello ", "prompt stripped")

// stripping is signalled to the caller, unterminated block named explicitly
{
  const ok = call("mem_save", { title: "plain", content: "no tag here", project: "p" })
  assert(ok.private_stripped === undefined, "no signal when nothing stripped")
  const closed = call("mem_save", { title: "t", content: "a <private>x</private> b", project: "p" })
  assert(/stripped/.test(closed.private_stripped) && !/unterminated/.test(closed.private_stripped), "closed block signalled")
  const open = call("mem_save", { title: "t2", content: "mentions <private> tag then more text", project: "p" })
  assert(/unterminated/.test(open.private_stripped), "unterminated block signalled explicitly")
  assert(/unterminated/.test(call("mem_save_prompt", { session_id: "fresh-sess", content: "x <private>oops" }).private_stripped), "prompt unterminated signalled")
  assert(call("mem_save_prompt", { session_id: "fresh-sess", content: "x <private>y</private> z" }).private_stripped !== undefined, "prompt closed signalled")
  const u = call("mem_update", { id: open.id, content: "back <private>oops", expected_project: "p" })
  assert(/unterminated/.test(u.private_stripped), "update unterminated signalled")
  db.run("INSERT INTO judgments (id,new_id,candidate_id,project_id,suggested_relation,confidence) VALUES ('j2',?,?,?,?,?)", [n2.id, n1.id, "p", "related", 0.5])
  // "compatible", not "related": j1 already recorded (n2, n1, related), which INSERT OR IGNORE would skip
  const j = call("mem_judge", { judgment_id: "j2", relation: "compatible", note: "n <private>oops" })
  assert(/unterminated/.test(j.private_stripped), "judge note unterminated signalled")
  assert(call("mem_judge", { judgment_id: "nope", relation: "related", note: "n <private>oops" }).private_stripped === undefined, "no signal when judge wrote nothing")
  // re-judging an already-resolved judgment writes no row, so it must not signal
  assert(Conflicts.judge("j2", "compatible", "n <private>oops").wrote === false, "re-judge reports wrote=false")
  assert(call("mem_judge", { judgment_id: "j2", relation: "compatible", note: "again <private>oops" }).private_stripped === undefined, "no signal when judge already resolved")
  // a duplicate relation is skipped by INSERT OR IGNORE: no row written, no signal
  db.run("INSERT INTO judgments (id,new_id,candidate_id,project_id,suggested_relation,confidence) VALUES ('j3',?,?,?,?,?)", [n2.id, n1.id, "p", "related", 0.5])
  assert(call("mem_judge", { judgment_id: "j3", relation: "related", note: "dup <private>oops" }).private_stripped === undefined, "no signal when relation insert ignored")
  // session summary persists caller text through stripping, so it signals too
  const ss = call("mem_session_summary", { content: "goal <private>oops", project: "p" })
  assert(/unterminated/.test(ss.private_stripped), "session summary unterminated signalled")
  assert(call("mem_session_summary", { content: "clean", project: "p" }).private_stripped === undefined, "session summary no signal when clean")
  // signal only when a row was written
  const nw = call("mem_update", { id: open.id, content: "x <private>oops", expected_project: "other" })
  assert(nw.updated === false && nw.private_stripped === undefined, "no signal when update wrote nothing")
  // title eaten by stripping says so; a title blank to begin with keeps the plain message
  assert.throws(() => call("mem_save", { title: "<private>all</private>", project: "p" }), /title is required.*private text stripped/, "save: title eaten by stripping explains")
  assert.throws(() => call("mem_save", { title: "<private>oops", project: "p" }), /title is required.*unterminated/, "save: unterminated title explains")
  assert.throws(() => call("mem_update", { id: open.id, title: "<private>all</private>", expected_project: "p" }), /title is required.*private text stripped/, "update: title eaten by stripping explains")
  for (const t of ["", "  "]) {
    assert.throws(() => call("mem_save", { title: t, project: "p" }), (e: any) => e.message === "observation title is required", "blank title keeps plain message")
    assert.throws(() => call("mem_update", { id: open.id, title: t, expected_project: "p" }), (e: any) => e.message === "observation title is required", "blank update title keeps plain message")
  }
}

// --- 5. mem_save_prompt over the registry creates the session row ---
assert(call("mem_save_prompt", { session_id: "fresh-sess", content: "hi" }).ok === true, "mem_save_prompt works without prior session")

// --- 7. mem_merge_projects guards ---
assert.throws(() => Conflicts.mergeProjects("p", ""), /into/, "blank into rejected")
assert.throws(() => Conflicts.mergeProjects("p", "  "), /into/, "whitespace into rejected")
assert.throws(() => Conflicts.mergeProjects("p", "p"), /same|identical/, "identical rejected")
assert(Obs.search({ query: "tail", project: "p" }).length === 1, "rows still in p")

// --- 8. protocol text ---
assert(!MEMORY_INSTRUCTIONS.includes("IMMEDIATELY after any of these"), "no per-event save rule")
assert(/once.*request/i.test(MEMORY_INSTRUCTIONS), "save-once-per-request rule")
assert(/`mem_save` that returned an error wrote nothing/.test(MEMORY_INSTRUCTIONS) && /checkpoint/i.test(MEMORY_INSTRUCTIONS), "retry rule and checkpoint rule")
assert(MEMORY_INSTRUCTIONS.includes("#id"), "protocol mentions ids from mem_context")

// --- review fixes: handoff survives pinned flood; mem_review guard hint; protocol header ---
const hSum = Obs.save({ title: "Session summary h", type: "session_summary", content: "H".repeat(1000), project: "h" })!
db.run("UPDATE observations SET created_at = datetime('now','-2 day') WHERE id=?", [hSum.id])
for (let i = 0; i < 12; i++) { const r = Obs.save({ title: `Pin ${i}`, content: "p", project: "h" })!; Obs.pin(r.id) }
const hCtx = call("mem_context", { project: "h", limit: 10 }).context as string
assert(hCtx.includes(`## #${hSum.id} Session summary h (`) && hCtx.includes("H".repeat(1000)), "newest summary whole despite pinned flood")
const hIds = [...hCtx.matchAll(/^## #(\d+) /gm)].map((m) => m[1])
assert(hIds.length <= 10 && new Set(hIds).size === hIds.length, "block holds <= limit rows, no duplicates")
assert(call("mem_context", { project: "h", limit: 1 }).context.includes("H".repeat(1000)), "limit 1 still carries the summary")

const rv = Obs.save({ title: "Other proj row", type: "decision", content: "r", project: "zz-other" })!
const rv1 = call("mem_review", { action: "mark_reviewed", id: rv.id })
assert(rv1.success === false && rv1.reason === "project mismatch" && /project: "\*"/.test(rv1.hint) && !rv1.hint.includes("expected_project"), "mem_review hint names project")
assert(call("mem_review", { action: "mark_reviewed", id: rv.id, project: "*" }).success === true, "mem_review project * escapes guard")
db.run("UPDATE observations SET review_after = datetime('now','-1 day') WHERE id=?", [rv.id])
assert((call("mem_review", { action: "list", project: "*" }) as any[]).some((r) => r.id === rv.id), "mem_review list * spans projects")
assert(registryByName["mem_review"].description.includes('pass "*" to'), "mem_review description documents guard escape")
assert(MEMORY_INSTRUCTIONS.includes("WHEN TO SAVE (mandatory") && !MEMORY_INSTRUCTIONS.includes("mandatory — not optional"), "protocol header agrees with once-per-request")

console.log("test_hardening: ok")
