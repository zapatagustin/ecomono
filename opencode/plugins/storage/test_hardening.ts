/**
 * Hardening checks from the engram scan: mem_context shape, project-guarded
 * pin/review, atomic save, <private> stripping, prompt FK, merge guards,
 * protocol text. Throwaway DB; plain assertions, no framework.
 *
 * Each numbered section runs in its own block with its own project/session/judgment
 * ids (nothing is shared between sections but the DB file). A failed assert fails its
 * section only; the script keeps going and exits non-zero listing every failed section.
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
const Sess = await import("./sessions")
const { registryByName } = await import("./tools")
const { MEMORY_INSTRUCTIONS } = await import("./protocol")
const call = (name: string, args: any = {}) => registryByName[name].handler(args) as any

const failed: string[] = []
async function section(name: string, fn: () => void | Promise<void>) {
  try { await fn() } catch (e) { failed.push(name); console.error(`FAIL section ${name}: ${(e as Error).message}`) }
}
// One judgment parked between two fresh observations of `project`; returns their ids.
function parkJudgment(jid: string, project: string, suggested = "related") {
  const a = Obs.save({ title: `Judge a ${jid}`, content: "alpha", project })!
  const b = Obs.save({ title: `Judge b ${jid}`, content: "beta", project })!
  db.run("INSERT INTO judgments (id,new_id,candidate_id,project_id,suggested_relation,confidence) VALUES (?,?,?,?,?,?)", [jid, b.id, a.id, project, suggested, 0.5])
  return { a: a.id, b: b.id }
}
// Doc-drift check: a text and the facts it must keep stating. Returns what drifted.
const drift = (checks: [string, boolean][]) => checks.filter(([, ok]) => !ok).map(([label]) => label)

// --- 1+6. mem_context: active only, ids, pinned first, cut body, newest summary whole ---
await section("1+6 mem_context", () => {
  const P = "s1-ctx"
  const old = Obs.save({ title: "Old fact", content: "stale body", project: P })!
  const fresh = Obs.save({ title: "Fresh fact", content: "x".repeat(299) + "😀😀😀", project: P })!
  const pinnedOld = Obs.save({ title: "Pinned older", content: "keep me", project: P })!
  db.run("UPDATE observations SET state='superseded' WHERE id=?", [old.id])
  db.run("UPDATE observations SET created_at = datetime('now','-1 day') WHERE id=?", [pinnedOld.id])
  Obs.pin(pinnedOld.id)
  const sumA = Obs.save({ title: "Session summary c 1", type: "session_summary", content: "old summary", project: P })!
  const longSummary = "S".repeat(1000)
  const sumB = Obs.save({ title: "Session summary c 2", type: "session_summary", content: longSummary, project: P })!
  const ctx = call("mem_context", { project: P }).context as string
  assert(!ctx.includes("Old fact"), "superseded row hidden from mem_context")
  assert(ctx.includes(`## #${fresh.id} Fresh fact (`), "header carries id")
  assert(ctx.indexOf("Pinned older") < ctx.indexOf("Fresh fact"), "pinned row first")
  assert(ctx.includes(longSummary), "newest session_summary stays whole")
  const freshBlock = ctx.split("\n\n").find((b) => b.includes("Fresh fact"))!
  assert(freshBlock.includes("mem_get_observation") && freshBlock.includes(String(fresh.id)), "cut body points at mem_get_observation")
  // The cut now keeps the tail, so the trailing emojis survive whole; what must not happen is a split pair.
  assert(freshBlock.includes("😀😀😀") && freshBlock.isWellFormed(), "cut is codepoint-safe")
  assert(sumA.id > 0 && sumB.id > sumA.id)
})

// --- 1b. mem_context cut keeps both ends of a long body ---
await section("1b mem_context head+tail cut", () => {
  const { CTX_BODY_CHARS, CTX_HEAD_CHARS, CTX_TAIL_CHARS } = Sess
  let n = 0
  // Body of `cps` codepoints, all distinct BMP ones unless `at` plants an astral char at a codepoint index.
  const bodyOf = (len: number, at?: number) => {
    const cps = Array.from({ length: len }, (_, i) => String.fromCodePoint(0x4e00 + i))
    if (at !== undefined) cps[at] = "😀"
    return cps
  }
  const rendered = (content: string) => {
    const project = `s1b-${n++}`
    const r = Obs.save({ title: "T", content, project })!
    const ctx = call("mem_context", { project }).context as string
    return { id: r.id, body: ctx.slice(ctx.indexOf("\n") + 1) }
  }
  const cut = (cps: string[], id: number) =>
    `${cps.slice(0, CTX_HEAD_CHARS).join("")} … ${cps.slice(-CTX_TAIL_CHARS).join("")} [truncated, full text: mem_get_observation id=${id}]`
  assert.strictEqual(CTX_BODY_CHARS, 300)
  assert.strictEqual(CTX_HEAD_CHARS, 180)
  assert.strictEqual(CTX_TAIL_CHARS, 120)

  const at300 = bodyOf(300)
  assert.strictEqual(rendered(at300.join("")).body, at300.join(""), "exactly 300 codepoints stays whole")
  const at301 = bodyOf(301)
  const r301 = rendered(at301.join(""))
  assert.strictEqual(r301.body, cut(at301, r301.id), "301 codepoints is cut to head + ' … ' + tail + pointer")

  const marker = "END-MARKER-" + "m".repeat(39) // 50 codepoints
  const long = "L".repeat(950) + marker
  assert.strictEqual([...marker].length, 50)
  const rLong = rendered(long)
  assert(rLong.body.includes(marker), "the last 50 codepoints of a 1000-codepoint body survive")
  assert(rLong.body.startsWith("L".repeat(CTX_HEAD_CHARS) + " … "), "head kept")

  // an astral char planted on each side of both cuts: a code-unit slice would split it
  for (const at of [CTX_HEAD_CHARS - 1, CTX_HEAD_CHARS, 400 - CTX_TAIL_CHARS - 1, 400 - CTX_TAIL_CHARS]) {
    const cps = bodyOf(400, at)
    const r = rendered(cps.join(""))
    assert(r.body.isWellFormed(), `astral at ${at}: no split surrogate pair`)
    assert.strictEqual(r.body, cut(cps, r.id), `astral at ${at}: exact head/tail`)
  }
})

// --- timeline / stats / review list: active only ---
await section("2 timeline/stats/review active only", () => {
  const P = "s2-tl"
  const old = Obs.save({ title: "Old fact", content: "stale body", project: P, type: "decision" })!
  const fresh = Obs.save({ title: "Fresh fact", content: "body", project: P, type: "decision" })!
  const others = [Obs.save({ title: "Other 1", content: "o", project: P })!, Obs.save({ title: "Other 2", content: "o", project: P })!]
  const activeCount = 1 + others.length
  const globalBefore = Obs.stats().observations
  db.run("UPDATE observations SET state='superseded' WHERE id=?", [old.id])
  assert(!Obs.timeline(P).some((r) => r.id === old.id), "timeline hides superseded")
  assert(Obs.stats(P).observations === activeCount, "stats counts active only")
  assert(Obs.stats().observations === globalBefore - 1, "global stats counts active only")
  db.run("UPDATE observations SET review_after = datetime('now','-1 day') WHERE id IN (?, ?)", [old.id, fresh.id])
  assert(Obs.stats(P).needs_review === 1, "needs_review (project) counts active only")
  const due = Obs.review("list", undefined, 10, P) as any[]
  assert(due.some((r) => r.id === fresh.id) && !due.some((r) => r.id === old.id), "review list hides superseded")
  const dueAll = Obs.review("list", undefined, 1000) as any[]
  assert(dueAll.some((r) => r.id === fresh.id) && !dueAll.some((r) => r.id === old.id), "review list (no project) hides superseded")
  const globalNeeds = Obs.stats().needs_review
  db.run("UPDATE observations SET state='active' WHERE id=?", [old.id])
  assert(Obs.stats().needs_review === globalNeeds + 1, "global needs_review counts active only")
})

// --- 2. pin / mark_reviewed: project guard + honest result ---
await section("2 pin/mark_reviewed guard", () => {
  const P = "s2-pin"
  const fresh = Obs.save({ title: "Fresh fact", content: "body", project: P })!
  assert(call("mem_pin", { id: 999999 }).pinned === false, "pin missing id -> false")
  assert(call("mem_pin", { id: fresh.id, expected_project: "other" }).pinned === false, "pin wrong project -> false")
  assert(call("mem_pin", { id: fresh.id, expected_project: P }).pinned === true, "pin right project")
  assert(call("mem_unpin", { id: fresh.id, expected_project: "other" }).unpinned === false, "unpin wrong project -> false")
  assert(call("mem_unpin", { id: 999999 }).unpinned === false, "unpin missing id -> false")
  assert(call("mem_review", { action: "mark_reviewed", id: 999999, project: P }).success === false, "mark_reviewed missing id -> false")
  assert(call("mem_review", { action: "mark_reviewed", id: fresh.id, project: "other" }).success === false, "mark_reviewed wrong project -> false")
  assert(call("mem_review", { action: "mark_reviewed", id: fresh.id, project: P }).success === true, "mark_reviewed right project")
})

// --- 3. mem_save is atomic with conflict detection ---
await section("3 atomic save", () => {
  const P = "s3-atomic"
  Obs.save({ title: "Dup topic seed", content: "same body here", project: P, topic_key: "k/t" })
  const before = (db.query("SELECT COUNT(*) c FROM observations").get() as any).c
  db.run("CREATE TRIGGER boom BEFORE INSERT ON judgments BEGIN SELECT RAISE(ABORT, 'locked'); END")
  try {
    assert.throws(() => call("mem_save", { title: "Dup topic seed 2", content: "other", project: P, topic_key: "k/t" }), /locked/)
  } finally {
    db.run("DROP TRIGGER boom")
  }
  assert.strictEqual((db.query("SELECT COUNT(*) c FROM observations").get() as any).c, before, "failed detection leaves no row behind")
})

// --- 4a. <private> stripping through mem_save ---
await section("4a private stripping via mem_save", () => {
  const P = "s4a-p"
  const priv = call("mem_save", { title: "Key <private>sk-123</private> rotated", content: "a <private>secret</private> b <PRIVATE>x<private>y</private>LEAK</private> c tail <private>never closed", project: P })
  const row = Obs.getObservation(priv.id)!
  assert(!/sk-123|secret|LEAK|never closed|private/i.test(row.title + row.content), `private stripped: ${row.title} | ${row.content}`)
  assert(row.content.includes("tail") && row.content.startsWith("a "), "surrounding text kept")
  // tag variants (whitespace, attributes) fail closed too; a longer tag name is not the tag
  for (const [o, c] of [["<private >", "</private >"], ["<private\n>", "</private\n>"], ["<private class=x>", "</private>"]]) {
    const v = call("mem_save", { title: `variant ${JSON.stringify(o)}`, content: `a ${o}SECRET${c} b`, project: P })
    assert(Obs.getObservation(v.id)!.content === "a  b" && /stripped/.test(v.private_stripped), `variant ${JSON.stringify(o)} stripped and signalled`)
  }
  for (const t of ["privateer", "private-key"]) {
    const k = call("mem_save", { title: `kept ${t}`, content: `<${t}>secret</${t}>`, project: P })
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
    const w = call("mem_save", { title: `prose ${t}`, content: t, project: P })
    assert(Obs.getObservation(w.id)!.content === t && w.private_stripped === undefined, `${t} stored whole`)
  }
  // deliberate: whitespace between `<` and the name no longer makes a tag
  const sp = call("mem_save", { title: "spaced tag", content: "< private>secret</private>", project: P })
  // the stray </private> is still dropped, so only the closer goes
  assert(Obs.getObservation(sp.id)!.content === "< private>secret" && sp.private_stripped !== undefined, "< private> is not an opener (deliberate)")
  const sc = call("mem_save", { title: "self closing", content: "before <private/> after <private /> end", project: P })
  assert(Obs.getObservation(sc.id)!.content === "before  after  end", `self-closing opens no block: ${Obs.getObservation(sc.id)!.content}`)
  // quoted attribute values are one unit: a `>` inside does not end the tag
  const q = call("mem_save", { title: "quoted gt", content: `<private a="x>y">SECRET</private> tail <private b='p></private>q'>S2</private>`, project: P })
  assert(Obs.getObservation(q.id)!.content.trim() === "tail" && /stripped/.test(q.private_stripped), `quoted > : ${Obs.getObservation(q.id)!.content}`)
})

// --- 4b. fail-closed matcher spec ---
await section("4b private matcher spec", () => {
  // pinned row by row through stripPrivate/privateSignal directly (mem_save wiring is
  // checked below for the headline rows). Each row: input, trimmed
  // stored text, signal. A removed self-closing tag reports "stripped" (the text changed).
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
    // edges: nothing in, nothing out; a lone closer is dropped (and counts as stripped)
    ["", "", "none"],
    ["</private>", "", "stripped"],
    // a closer with no `>` is not a closer and stays as text
    ["a </private b", "a </private b", "none"],
    // The second opener's `"` has no closing quote anywhere, so its tail is malformed: only the
    // token `<private` opens (depth 2) and ` x="b` is block content. The two closers then bring
    // depth back to 0, so `c` goes with the block and only `d` is stored. Not unterminated.
    [`<private>a<private x="b</private>c</private>d`, "d", "stripped"],
    // the apostrophe in `don't` is unbalanced, so that opener is malformed too (name only);
    // its closer still balances it, then a well-formed pair, then `z` survives
    ["<private note=don't>x</private><private>y</private>z", "z", "stripped"],
    // tags at the very start and end of the text leave nothing
    ["<private>x</private>", "", "stripped"],
    // a quoted value holding `</private>` is part of the tag, so it is not a closer
    [`<private a="</private>">S</private>t`, "t", "stripped"],
  ]
  for (const [i, o, s] of rows) {
    const sig = Obs.privateSignal(i)
    const got = sig === undefined ? "none" : /unterminated/.test(sig) ? "unterminated" : "stripped"
    assert(Obs.stripPrivate(i).trim() === o.trim() && got === s, `matcher row ${JSON.stringify(i.slice(0, 40))}: ${JSON.stringify(Obs.stripPrivate(i))} ${got}`)
  }
  const fc = call("mem_save", { title: "fail closed", content: "<private note=don't>secret</private>ok", project: "s4b-pv" })
  assert(Obs.getObservation(fc.id)!.content === "ok" && /stripped/.test(fc.private_stripped), "mem_save: unbalanced apostrophe opener fails closed")
  const n = 300_000
  for (const [name, adv] of [["ws", "<" + " ".repeat(n)], ["openers", "<private ".repeat(n / 9)], ["dq openers", "<private \"".repeat(n / 10)], ["sq openers", "<private '".repeat(n / 10)], ["quotes", "\"".repeat(n)], ["long quote", "<private x=\"" + "y".repeat(n)], ["closers", "</private ".repeat(n / 10)], ["long tail", "<private " + "a".repeat(n)]] as const) {
    const t0 = performance.now(); Obs.stripPrivate(adv); const ms = performance.now() - t0
    console.log(`stripPrivate 300k ${name}: ${ms.toFixed(1)} ms`)
    assert(ms < 250, `stripPrivate 300k ${name} linear (${ms} ms)`)
  }
})

// --- 4c. other write paths strip too ---
await section("4c judge/update/prompt/topic_key/sessionEnd strip", () => {
  const P = "s4c-p"
  const { a: n1 } = parkJudgment("s4c-j1", P)
  Conflicts.judge("s4c-j1", "related", "why <private>pw</private> ok")
  assert(!(db.query("SELECT note FROM memory_relations WHERE to_id = ?").get(n1) as any).note.includes("pw"), "judge note stripped")
  assert(Obs.update(n1, { content: "z <private>q</private>" }, P) && Obs.getObservation(n1)!.content === "z ", "update strips")
  db.run("INSERT INTO projects (id,name) VALUES (?,?) ON CONFLICT DO NOTHING", [P, P])
  db.run("INSERT INTO sessions (id, project_id) VALUES ('s4c-priv',?)", [P])
  Prompts.savePrompt("s4c-priv", "hello <private>tok</private>")
  assert((Prompts.getPrompts("s4c-priv")[0] as any).content === "hello ", "prompt stripped")

  // (9b) topic_key is persisted through the same stripping as title and content
  const tk = call("mem_save", { title: "topic key strip", content: "c", project: P, topic_key: "area/<private>sk-1</private>key" })
  assert(Obs.getObservation(tk.id)!.topic_key === "area/key" && /stripped/.test(tk.private_stripped), "save: topic_key stripped and signalled")
  const tu = call("mem_update", { id: tk.id, topic_key: "x/<private>sk-2</private>y", expected_project: P })
  assert(Obs.getObservation(tk.id)!.topic_key === "x/y" && /stripped/.test(tu.private_stripped), "update: topic_key stripped and signalled")

  // (9d) sessionEnd summary is stripped
  Sess.sessionStart("s4c-end", P)
  Sess.sessionEnd("s4c-end", "done <private>tok</private>")
  assert(Sess.getSession("s4c-end").summary === "done ", "sessionEnd summary stripped")
})

// --- 4d. stripping is signalled to the caller, unterminated block named explicitly ---
await section("4d private signals", () => {
  const P = "s4d-p"
  const ok = call("mem_save", { title: "plain", content: "no tag here", project: P })
  assert(ok.private_stripped === undefined, "no signal when nothing stripped")
  const closed = call("mem_save", { title: "t", content: "a <private>x</private> b", project: P })
  assert(/stripped/.test(closed.private_stripped) && !/unterminated/.test(closed.private_stripped), "closed block signalled")
  const open = call("mem_save", { title: "t2", content: "mentions <private> tag then more text", project: P })
  assert(/unterminated/.test(open.private_stripped), "unterminated block signalled explicitly")
  assert(/unterminated/.test(call("mem_save_prompt", { session_id: "s4d-sess", content: "x <private>oops" }).private_stripped), "prompt unterminated signalled")
  assert(call("mem_save_prompt", { session_id: "s4d-sess", content: "x <private>y</private> z" }).private_stripped !== undefined, "prompt closed signalled")
  const u = call("mem_update", { id: open.id, content: "back <private>oops", expected_project: P })
  assert(/unterminated/.test(u.private_stripped), "update unterminated signalled")
  // judgments: s4d-j1 records (new, cand, related) first, so a second judgment with the same pair/relation is a duplicate
  const { a, b } = parkJudgment("s4d-j1", P)
  Conflicts.judge("s4d-j1", "related")
  db.run("INSERT INTO judgments (id,new_id,candidate_id,project_id,suggested_relation,confidence) VALUES ('s4d-j2',?,?,?,?,?)", [b, a, P, "related", 0.5])
  // "compatible", not "related": s4d-j1 already recorded (b, a, related), which INSERT OR IGNORE would skip
  const j = call("mem_judge", { judgment_id: "s4d-j2", relation: "compatible", note: "n <private>oops" })
  assert(/unterminated/.test(j.private_stripped), "judge note unterminated signalled")
  assert(call("mem_judge", { judgment_id: "nope", relation: "related", note: "n <private>oops" }).private_stripped === undefined, "no signal when judge wrote nothing")
  // re-judging an already-resolved judgment writes no row, so it must not signal
  assert(Conflicts.judge("s4d-j2", "compatible", "n <private>oops").wrote === false, "re-judge reports wrote=false")
  assert(call("mem_judge", { judgment_id: "s4d-j2", relation: "compatible", note: "again <private>oops" }).private_stripped === undefined, "no signal when judge already resolved")
  // a duplicate relation is skipped by INSERT OR IGNORE: no row written, no signal
  db.run("INSERT INTO judgments (id,new_id,candidate_id,project_id,suggested_relation,confidence) VALUES ('s4d-j3',?,?,?,?,?)", [b, a, P, "related", 0.5])
  assert(call("mem_judge", { judgment_id: "s4d-j3", relation: "related", note: "dup <private>oops" }).private_stripped === undefined, "no signal when relation insert ignored")
  // session summary persists caller text through stripping, so it signals too
  const ss = call("mem_session_summary", { content: "goal <private>oops", project: P })
  assert(/unterminated/.test(ss.private_stripped), "session summary unterminated signalled")
  assert(call("mem_session_summary", { content: "clean", project: P }).private_stripped === undefined, "session summary no signal when clean")
  // signal only when a row was written
  const nw = call("mem_update", { id: open.id, content: "x <private>oops", expected_project: "other" })
  assert(nw.updated === false && nw.private_stripped === undefined, "no signal when update wrote nothing")
  // title eaten by stripping says so; a title blank to begin with keeps the plain message
  assert.throws(() => call("mem_save", { title: "<private>all</private>", project: P }), /title is required.*private text stripped/, "save: title eaten by stripping explains")
  assert.throws(() => call("mem_save", { title: "<private>oops", project: P }), /title is required.*unterminated/, "save: unterminated title explains")
  assert.throws(() => call("mem_update", { id: open.id, title: "<private>all</private>", expected_project: P }), /title is required.*private text stripped/, "update: title eaten by stripping explains")
  for (const t of ["", "  "]) {
    assert.throws(() => call("mem_save", { title: t, project: P }), (e: any) => e.message === "observation title is required", "blank title keeps plain message")
    assert.throws(() => call("mem_update", { id: open.id, title: t, expected_project: P }), (e: any) => e.message === "observation title is required", "blank update title keeps plain message")
  }
})

// --- 6. mem_judge: a supersedes note is stripped in the stored relation row ---
await section("6 mem_judge supersedes strips note", () => {
  const P = "s6-j"
  const { a, b } = parkJudgment("s6-j1", P)
  const r = call("mem_judge", { judgment_id: "s6-j1", relation: "supersedes", note: "replaced, <private>pw-9</private> was wrong" })
  assert(r.resolved === true && /stripped/.test(r.private_stripped), "supersedes judge signals private_stripped")
  const rel = db.query("SELECT relation, note FROM memory_relations WHERE from_id = ? AND to_id = ?").get(b, a) as any
  assert(rel.relation === "supersedes" && rel.note === "replaced,  was wrong" && !rel.note.includes("pw-9"), `stored note has no private text: ${JSON.stringify(rel)}`)
  assert(Obs.getObservation(a)!.state === "superseded", "candidate retired")

  // (9c) a note that was private through and through is NULL, not ""
  const { a: a2, b: b2 } = parkJudgment("s6-j2", P)
  call("mem_judge", { judgment_id: "s6-j2", relation: "supersedes", note: "<private>all of it</private>" })
  const rel2 = db.query("SELECT note FROM memory_relations WHERE from_id = ? AND to_id = ?").get(b2, a2) as any
  assert(rel2.note === null, `fully private note stored as NULL, got ${JSON.stringify(rel2.note)}`)
})

// --- 5 + 9a. mem_save_prompt over the registry creates the session row, only for a valid prompt ---
await section("5 mem_save_prompt session row", () => {
  assert(call("mem_save_prompt", { session_id: "s5-fresh", content: "hi" }).ok === true, "mem_save_prompt works without prior session")
  const sessions = (id: string) => (db.query("SELECT COUNT(*) c FROM sessions WHERE id = ?").get(id) as any).c
  assert(sessions("s5-fresh") === 1, "valid prompt created its session")
  for (const [id, content] of [["s5-blank", "   "], ["s5-empty", ""], ["s5-private", "<private>all of it</private>"]]) {
    assert.throws(() => call("mem_save_prompt", { session_id: id, content }), /prompt content is required/, `${id}: rejected`)
    assert(sessions(id) === 0, `${id}: a failed mem_save_prompt leaves no session row`)
  }
})

// --- 5b. mem_save_prompt waits out a concurrent writer ---
// A deferred transaction that opens with ensureSession's SELECT already holds a
// read lock when its first INSERT asks for the write lock, and SQLite does not
// call the busy handler on that upgrade: the save dies with "database is locked"
// at once, whatever busy_timeout says. Hold the write lock from another process —
// a second MCP server in the middle of a save — and the prompt must still land
// once that writer commits.
await section("5b mem_save_prompt under a concurrent writer", async () => {
  const holder = Bun.spawn([
    process.execPath, "-e",
    `const {Database}=require("bun:sqlite");const d=new Database(${JSON.stringify(db.filename)});` +
    `d.run("PRAGMA busy_timeout = 5000");d.run("BEGIN IMMEDIATE");console.error("locked");await Bun.sleep(400);d.run("COMMIT");d.close()`,
  ], { stderr: "pipe" })
  try {
    const { value } = await holder.stderr.getReader().read()
    assert(new TextDecoder().decode(value).includes("locked"), "holder took the write lock")
    assert(call("mem_save_prompt", { session_id: "s5b-contended", content: "hi" }).ok === true, "prompt saved once the writer released")
  } finally { await holder.exited }
  assert((db.query("SELECT COUNT(*) c FROM prompts WHERE session_id = ?").get("s5b-contended") as any).c === 1, "contended prompt row landed")
})

// --- 7. mem_merge_projects guards ---
await section("7 merge_projects guards", () => {
  const from = "s7-from"
  Obs.save({ title: "Merge seed", content: "mergeprobe tail", project: from })
  assert.throws(() => Conflicts.mergeProjects(from, ""), /into/, "blank into rejected")
  assert.throws(() => Conflicts.mergeProjects(from, "  "), /into/, "whitespace into rejected")
  assert.throws(() => Conflicts.mergeProjects(from, from), /same|identical/, "identical rejected")
  assert(Obs.search({ query: "mergeprobe", project: from }).length === 1, "rows still in source project")
})

// --- 8. protocol + tool description text: one doc-drift check per text ---
await section("8 doc drift", () => {
  const { CTX_BODY_CHARS, CTX_HEAD_CHARS, CTX_TAIL_CHARS } = Sess
  const cutShape = (t: string) => t.includes(`first ${CTX_HEAD_CHARS}`) && t.includes(`last ${CTX_TAIL_CHARS}`) && t.includes(`over ${CTX_BODY_CHARS}`)
  assert.deepStrictEqual(drift([
    ["no per-event save rule", !MEMORY_INSTRUCTIONS.includes("IMMEDIATELY after any of these")],
    ["save-once-per-request rule", /once.*request/i.test(MEMORY_INSTRUCTIONS)],
    ["retry rule", /`mem_save` that returned an error wrote nothing/.test(MEMORY_INSTRUCTIONS)],
    ["checkpoint rule", /checkpoint/i.test(MEMORY_INSTRUCTIONS)],
    ["ids from mem_context", MEMORY_INSTRUCTIONS.includes("#id")],
    ["header agrees with once-per-request", MEMORY_INSTRUCTIONS.includes("WHEN TO SAVE (mandatory") && !MEMORY_INSTRUCTIONS.includes("mandatory — not optional")],
    ["mem_context cut shape (derived from constants)", cutShape(MEMORY_INSTRUCTIONS)],
  ]), [], "doc-drift: MEMORY_INSTRUCTIONS")
  assert.deepStrictEqual(drift([
    ["mem_review: guard escape", registryByName["mem_review"].description.includes('pass "*" to')],
    ["mem_review: cross-project list is summary-only", /summary rows only: id, title, type, project, review_after; no content/.test(registryByName["mem_review"].description)],
  ]), [], "doc-drift: mem_review description")
  assert.deepStrictEqual(drift([
    ["mem_context: cut shape (derived from constants)", cutShape(registryByName["mem_context"].description)],
    ["mem_context: summary stays whole", /summary stays whole/.test(registryByName["mem_context"].description)],
  ]), [], "doc-drift: mem_context description")
  assert.deepStrictEqual(drift([
    ["mem_save: no PROACTIVELY rule", !/PROACTIVELY/.test(registryByName["mem_save"].description)],
    ["mem_save: once per request", /once per request/i.test(registryByName["mem_save"].description)],
  ]), [], "doc-drift: mem_save description")
})

// --- review fixes: handoff survives pinned flood ---
await section("9 handoff survives pinned flood", () => {
  const P = "s9-h"
  const hSum = Obs.save({ title: "Session summary h", type: "session_summary", content: "H".repeat(1000), project: P })!
  db.run("UPDATE observations SET created_at = datetime('now','-2 day') WHERE id=?", [hSum.id])
  for (let i = 0; i < 12; i++) { const r = Obs.save({ title: `Pin ${i}`, content: "p", project: P })!; Obs.pin(r.id) }
  const hCtx = call("mem_context", { project: P, limit: 10 }).context as string
  assert(hCtx.includes(`## #${hSum.id} Session summary h (`) && hCtx.includes("H".repeat(1000)), "newest summary whole despite pinned flood")
  const hIds = [...hCtx.matchAll(/^## #(\d+) /gm)].map((m) => m[1])
  assert(hIds.length <= 10 && new Set(hIds).size === hIds.length, "block holds <= limit rows, no duplicates")
  assert(call("mem_context", { project: P, limit: 1 }).context.includes("H".repeat(1000)), "limit 1 still carries the summary")
})

// --- mem_context row order: created_at ties (second granularity) break on id DESC ---
await section("9b mem_context id DESC tiebreak", () => {
  const P = "s9b-tie"
  const ids = ["first", "second", "third"].map((t) => Obs.save({ title: `Tie ${t}`, content: t, project: P })!.id)
  db.run("UPDATE observations SET created_at = '2024-01-01 00:00:00' WHERE project_id = ?", [P])
  const got = [...(call("mem_context", { project: P }).context as string).matchAll(/^## #(\d+) /gm)].map((m) => Number(m[1]))
  assert.deepStrictEqual(got, [...ids].reverse(), "rows sharing a created_at second come newest id first")
})

// --- mem_review: guard hint and cross-project list shape ---
await section("9c mem_review hint and list shapes", () => {
  const P = "s9c-other"
  const rv = Obs.save({ title: "Other proj row", type: "decision", content: "r", project: P, scope: "personal" })!
  const rv1 = call("mem_review", { action: "mark_reviewed", id: rv.id })
  assert(rv1.success === false && rv1.reason === "project mismatch" && /project: "\*"/.test(rv1.hint) && !rv1.hint.includes("expected_project"), "mem_review hint names project")
  assert(call("mem_review", { action: "mark_reviewed", id: rv.id, project: "*" }).success === true, "mem_review project * escapes guard")
  db.run("UPDATE observations SET review_after = datetime('now','-1 day') WHERE id=?", [rv.id])
  const all = call("mem_review", { action: "list", project: "*", limit: 1000 }) as any[]
  const row = all.find((r) => r.id === rv.id)
  assert(row, "mem_review list * spans projects")
  assert(!("content" in row), "cross-project list row carries no content")
  assert.deepStrictEqual(Object.keys(row).sort(), ["id", "project", "review_after", "title", "type"], "cross-project list is summary fields only (no scope/content)")
  assert(row.project === P && row.title === "Other proj row" && row.type === "decision", "summary fields populated")
  const own = call("mem_review", { action: "list", project: P }) as any[]
  assert(own.length === 1 && own[0].id === rv.id && own[0].content === "r", "single-project list still returns full rows")
})

// --- topic_key and summary stripped to nothing: matched as stored, stored as NULL ---
await section("9e private topic_key matching and NULL storage", () => {
  const P = "s9e-p"
  const first = Obs.save({ title: "Auth design alpha", content: "alpha body one", project: P, topic_key: "arch/auth" })!
  const r = call("mem_save", { title: "Zeta rewrite", content: "wholly different words", project: P, topic_key: "<private>x</private>arch/auth" })
  assert(r.judgment_required === true, "private-tagged topic_key still triggers judgment")
  assert(r.candidates.some((c: any) => c.observation_id === first.id && c.suggested_relation === "supersedes"), "candidate points at the row with the same stripped topic")
  assert((db.query("SELECT topic_key FROM observations WHERE id = ?").get(r.id) as any).topic_key === "arch/auth", "stored key is the stripped one")
  const row = Obs.save({ title: "Key to blank", content: "c", project: P, topic_key: "k/one" })!
  call("mem_update", { id: row.id, topic_key: "<private>x</private>", expected_project: P })
  assert((db.query("SELECT topic_key FROM observations WHERE id = ?").get(row.id) as any).topic_key === null, "update: fully private topic_key stored as NULL")
  Sess.sessionStart("s9e-end", P)
  Sess.sessionEnd("s9e-end", "<private>all of it</private>")
  assert(Sess.getSession("s9e-end").summary === null, "sessionEnd: fully private summary stored as NULL")
})

if (failed.length) {
  console.error(`test_hardening: ${failed.length} section(s) failed:\n  - ${failed.join("\n  - ")}`)
  process.exit(1)
}
console.log("test_hardening: ok")
