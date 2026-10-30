// Bash and github gates of the omp extension, driven through fake-pi, plus direct runHook cases. Plain assert
// script. Gate scripts are executable stubs in a temp hooksDir that print a fixed decision, fail, or record what
// they received; the real Claude scripts are used only in the "real script" block. No command under test ever
// runs: `rm -rf` and credential paths are only ever event input.
import { dir, makeCtx, makePi, withEnv } from "./fake-pi.ts"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runHook } from "../../opencode/plugins/hook-runner/core.ts"
import { GATE_TIMEOUT_MS, REPO, ecomono } from "../extensions/ecomono/index.ts"

const stub = (d: string, name: string, body: string) => {
  const f = join(d, `${name}.sh`)
  writeFileSync(f, `#!/bin/sh\n${body}\n`)
  chmodSync(f, 0o755)
  return f
}

const GATES = ["secret-access-gate", "check-diff-size", "review-receipt-gate"] as const
const ALLOW = "cat >/dev/null"
const say = (kind: "deny" | "ask", reason: string) =>
  `cat >/dev/null\ncat <<'EOF'\n${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: kind, permissionDecisionReason: reason },
  })}\nEOF`
/** A temp hooksDir with the three gates; `over` replaces a body, null leaves the script out. */
const hooks = (over: Partial<Record<(typeof GATES)[number], string | null>> = {}) => {
  const d = dir("hooks")
  for (const g of GATES) if (over[g] !== null) stub(d, g, over[g] ?? ALLOW)
  return d
}
/** Bodies that record the stdin and the working directory they were run with next to the stub. */
const recording = (d: string, then = "") =>
  Object.fromEntries(GATES.map((g) => [g, `cat > "${d}/${g}.in"; pwd > "${d}/${g}.pwd"\n${then}`])) as Record<
    (typeof GATES)[number],
    string
  >
const recorded = (d: string, g: (typeof GATES)[number]) =>
  existsSync(join(d, `${g}.in`))
    ? { input: JSON.parse(readFileSync(join(d, `${g}.in`), "utf8")), pwd: readFileSync(join(d, `${g}.pwd`), "utf8").trim() }
    : undefined

const stateLog = (name: string) => {
  const f = join(process.env.XDG_STATE_HOME!, "ecomono", `${name}.log`)
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []
}

const setup = (o: { hooksDir?: string; timeoutMs?: number; repo?: string } = {}, ctxOver: Record<string, any> = {}) => {
  const { pi, fire, calls } = makePi()
  ecomono({ repo: o.repo ?? REPO, hooksDir: o.hooksDir, timeoutMs: o.timeoutMs })(pi)
  return { fire, calls, ctx: makeCtx({ cwd: dir("cwd"), ...ctxOver }) }
}
const bash = (command: unknown, extra: Record<string, any> = {}) => ({
  toolName: "bash",
  toolCallId: "call-1",
  input: { command, ...extra },
})
const github = (op: string) => ({ toolName: "github", toolCallId: "call-1", input: { op } })

/**
 * A stub body that proves its gates run at the same time, without reading a clock: each touches its own marker
 * in `d`, then waits until `n` markers exist (deadline about 5 s, well under the 20 s gate timeout) and exits 1 if
 * they never do. A serial runner never gets past the first gate, which then fails open with a warning; a concurrent
 * one allows the call at any machine load.
 */
const rendezvous = (d: string, n: number) =>
  `${ALLOW}; touch "${d}/m.$$"; i=0
while [ "$(ls "${d}" | wc -l)" -lt ${n} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
[ "$(ls "${d}" | wc -l)" -ge ${n} ] || exit 1`

{
  // The gate timeout stays inside omp's 30 s per-handler budget (omp: extensibility/extensions/runner.ts:133
  // EXTENSION_HANDLER_TIMEOUT_MS), past which omp fails the call CLOSED. A mirror of that constant: re-check it on an
  // omp upgrade (docs/DESIGN.md, Version coupling).
  assert.ok(GATE_TIMEOUT_MS < 30_000, `the gate timeout ${GATE_TIMEOUT_MS} ms must stay under omp's 30000 ms handler budget`)
}

{
  // Registration: one tool_call dispatcher.
  const { calls } = setup({ hooksDir: hooks() })
  assert.deepEqual(calls.on.map(([name]) => name).filter((name) => name === "tool_call"), ["tool_call"])
}

// ---- literal denies, parsed from Claude's template ----------------------------------------------------------

{
  for (const cmd of [
    "rm -rf /",
    "sudo  rm -rf ~",
    "ls && rm -rf /",
    "echo hi; rm -rf ~",
    "ls || rm -rf /",
    "ls | rm -rf ~",
    "ls & rm -rf /",
    "ls\nrm -rf /",
    "  rm \t -rf   /  ",
  ]) {
    const d = dir("rec")
    const { fire, ctx } = setup({ hooksDir: hooks(recording(d)) })
    const r = await fire("tool_call", bash(cmd), ctx)
    assert.equal(r?.block, true, cmd)
    assert.match(r.reason, /claude\/settings\.template\.json/, cmd)
    assert.equal(recorded(d, "secret-access-gate"), undefined, `${cmd}: the literal check decides before any script runs`)
  }
  for (const cmd of ["rm -rf ./build", 'echo "rm -rf /"', "ls"]) {
    const { fire, ctx } = setup({ hooksDir: hooks() })
    assert.equal(await fire("tool_call", bash(cmd), ctx), undefined, cmd)
  }
}

{
  // Derived guard: the literals are exactly the Bash(...) entries of the template, not a copy in the extension.
  const template = JSON.parse(readFileSync(join(REPO, "claude/settings.template.json"), "utf8"))
  const entries: string[] = template.permissions.deny
    .filter((e: string) => e.startsWith("Bash(") && e.endsWith(")"))
    .map((e: string) => e.slice("Bash(".length, -1))
  assert.ok(entries.length > 0, "the template has Bash deny entries")
  for (const e of entries) {
    const { fire, ctx } = setup({ hooksDir: hooks() })
    assert.equal((await fire("tool_call", bash(e), ctx))?.block, true, e)
    assert.equal((await fire("tool_call", bash(e.replace(/ /g, "   ")), ctx))?.block, true, `${e} (extra spaces)`)
  }

  // A different template yields a different list: nothing is hard-coded.
  const repo = dir("repo")
  mkdirSync(join(repo, "claude"))
  writeFileSync(
    join(repo, "claude/settings.template.json"),
    JSON.stringify({ permissions: { deny: ["Bash(deploy  prod)", "Read(.env)"] } }),
  )
  const { fire, ctx } = setup({ repo, hooksDir: hooks() })
  assert.equal((await fire("tool_call", bash("deploy   prod"), ctx))?.block, true)
  assert.equal(await fire("tool_call", bash("rm -rf /"), ctx), undefined)
  // The other direction of the guard: no literal of the real template survives in the extension, so an extra
  // hard-coded one (`denyLiterals.push("rm -rf /*")`) would block here.
  for (const e of entries) assert.equal(await fire("tool_call", bash(e), ctx), undefined, `${e}: not in this template, so not blocked`)
  assert.equal(await fire("tool_call", bash(".env"), ctx), undefined, "only Bash(...) entries count")

  // An unreadable or unparseable template: one warning, no literal blocks, the gates still run.
  const bad = dir("repo")
  mkdirSync(join(bad, "claude"))
  writeFileSync(join(bad, "claude/settings.template.json"), "{not json")
  for (const r of [bad, dir("repo")]) {
    const t = setup({ repo: r, hooksDir: hooks() })
    assert.equal(await t.fire("tool_call", bash("rm -rf /"), t.ctx), undefined)
    assert.equal(await t.fire("tool_call", bash("rm -rf /"), t.ctx), undefined)
    assert.equal(t.calls.warn.filter((l) => l.includes("deny literals disabled")).length, 1)
  }
}

// ---- merging the gates' answers -----------------------------------------------------------------------------

{
  // A deny blocks with its own reason.
  const { fire, ctx } = setup({ hooksDir: hooks({ "secret-access-gate": say("deny", "R-secret") }) })
  const r = await fire("tool_call", bash("ls"), ctx)
  assert.deepEqual(r, { block: true, reason: "R-secret" })
}

{
  // Deny beats ask, whatever the order.
  const { fire, ctx } = setup(
    { hooksDir: hooks({ "secret-access-gate": say("ask", "R-ask"), "review-receipt-gate": say("deny", "R-receipt") }) },
    { hasUI: true },
  )
  ctx.recorded.confirmResult = true
  const r = await fire("tool_call", bash("ls"), ctx)
  assert.equal(r.block, true)
  assert.ok(r.reason.includes("R-receipt"))
  assert.equal(ctx.recorded.confirm.length, 0, "a deny never reaches the user")

  // Two denies are both reported.
  const two = setup({ hooksDir: hooks({ "secret-access-gate": say("deny", "R1"), "review-receipt-gate": say("deny", "R2") }) })
  assert.equal((await two.fire("tool_call", bash("ls"), two.ctx)).reason, "R1\n\nR2")
}

{
  // Asks with a UI: one confirm on the handler's ctx, with every reason.
  const hooksDir = hooks({ "secret-access-gate": say("ask", "A-secret"), "review-receipt-gate": say("ask", "A-receipt") })
  const yes = setup({ hooksDir }, { hasUI: true })
  yes.ctx.recorded.confirmResult = true
  assert.equal(await yes.fire("tool_call", bash("ls"), yes.ctx), undefined)
  assert.equal(yes.ctx.recorded.confirm.length, 1)
  const [title, message] = yes.ctx.recorded.confirm[0]
  assert.equal(title, "ecomono")
  assert.ok(message.includes("A-secret") && message.includes("A-receipt"))

  const no = setup({ hooksDir }, { hasUI: true })
  no.ctx.recorded.confirmResult = false
  const r = await no.fire("tool_call", bash("ls"), no.ctx)
  assert.equal(r.block, true)
  assert.ok(r.reason.includes("A-secret") && r.reason.includes("A-receipt"))
  assert.equal(no.ctx.recorded.confirm.length, 1)

  // A diff-size nudge alone still goes to the user when there is one.
  const nudge = setup({ hooksDir: hooks({ "check-diff-size": say("ask", "A-diff") }) }, { hasUI: true })
  nudge.ctx.recorded.confirmResult = true
  assert.equal(await nudge.fire("tool_call", bash("ls"), nudge.ctx), undefined)
  assert.equal(nudge.ctx.recorded.confirm.length, 1)
}

{
  // Asks without a UI: block, except a diff-size ask alone.
  const secret = setup({ hooksDir: hooks({ "secret-access-gate": say("ask", "A-secret") }) })
  const r = await secret.fire("tool_call", bash("ls"), secret.ctx)
  assert.equal(r.block, true)
  assert.ok(r.reason.includes("A-secret"))
  assert.equal(secret.ctx.recorded.confirm.length, 0, "headless never prompts")

  const diff = setup({ hooksDir: hooks({ "check-diff-size": say("ask", "A-diff") }) })
  assert.equal(await diff.fire("tool_call", bash("ls"), diff.ctx), undefined)

  const both = setup({ hooksDir: hooks({ "check-diff-size": say("ask", "A-diff"), "review-receipt-gate": say("ask", "A-receipt") }) })
  const rb = await both.fire("tool_call", bash("ls"), both.ctx)
  assert.equal(rb.block, true)
  assert.ok(rb.reason.includes("A-receipt"))
}

{
  // The three scripts run concurrently: each waits until all three are running (rendezvous), so a serial runner
  // times its first gate out, which fails open and warns.
  const wait = rendezvous(dir("rendezvous"), 3)
  const { fire, calls, ctx } = setup({ hooksDir: hooks({ "secret-access-gate": wait, "check-diff-size": wait, "review-receipt-gate": wait }) })
  assert.equal(await fire("tool_call", bash("ls"), ctx), undefined)
  assert.deepEqual(calls.warn.filter((l) => l.includes("failing open")), [], "a gate timed out waiting for the others: they did not run together")
}

{
  // A task call with neither tasks[] nor a string agent is a shape omp 18.13.3 never sends: allowed, with one
  // warning that the judge gate skipped it. A well-formed one stays silent.
  const hooksDir = hooks()
  stub(hooksDir, "judge-standards-gate", ALLOW)
  const { fire, calls, ctx } = setup({ hooksDir })
  const task = (input: unknown) => ({ toolName: "task", toolCallId: "call-1", input })
  for (const input of [{}, { agnt: "ecomono-judge-a", task: "x" }, { tasks: "nope" }]) {
    assert.equal(await fire("tool_call", task(input), ctx), undefined, JSON.stringify(input))
  }
  const drift = calls.warn.filter((l) => l.includes("unexpected omp shape"))
  assert.equal(drift.length, 1)
  assert.ok(drift[0].includes("task tool_call"), drift[0])
  const quiet = setup({ hooksDir })
  await quiet.fire("tool_call", task({ agent: "explore", task: "x" }), quiet.ctx)
  await quiet.fire("tool_call", task({ tasks: [{ agent: "explore", task: "x" }] }), quiet.ctx)
  assert.deepEqual(quiet.calls.warn, [])
}

// ---- faults fail open, are reported, notify once ------------------------------------------------------------

{
  const faults: Record<string, { body: string | null; timeoutMs?: number }> = {
    "missing script": { body: null },
    "exit 3": { body: `${ALLOW}; exit 3` },
    garbage: { body: `${ALLOW}; echo 'not json at all'` },
    "no decision": { body: `${ALLOW}; echo '{}'` },
    // exec: the killed process is the sleeper itself, not an sh that leaves it behind.
    timeout: { body: "exec sleep 5", timeoutMs: 200 },
  }
  for (const [label, f] of Object.entries(faults)) {
    const before = stateLog("secret-access-gate").length
    const { fire, calls, ctx } = setup({ hooksDir: hooks({ "secret-access-gate": f.body }), timeoutMs: f.timeoutMs })
    const t0 = performance.now()
    assert.equal(await fire("tool_call", bash("ls"), ctx), undefined, label)
    assert.ok(performance.now() - t0 < 3000, `${label} settled`)
    assert.ok(calls.warn.some((l) => l.includes("[secret-access-gate] failing open")), `${label}: pi.logger.warn`)
    const log = stateLog("secret-access-gate")
    assert.equal(log.length, before + 1, `${label}: one state-log line`)
    assert.match(log.at(-1)!, /failing open/, label)
    assert.equal(ctx.recorded.notify.length, 0, `${label}: headless does not notify`)
  }

  // notify: once per session, only with a UI.
  const hooksDir = hooks({ "secret-access-gate": `${ALLOW}; exit 3` })
  const ui = setup({ hooksDir }, { hasUI: true })
  assert.equal(await ui.fire("tool_call", bash("ls"), ui.ctx), undefined)
  assert.equal(await ui.fire("tool_call", bash("pwd"), ui.ctx), undefined)
  assert.equal(ui.calls.warn.filter((l) => l.includes("failing open")).length, 2)
  assert.equal(ui.ctx.recorded.notify.length, 1)
  assert.match(ui.ctx.recorded.notify[0][0], /failed open/)
  // The notice names the directory the lines went to, XDG_STATE_HOME included.
  assert.ok(ui.ctx.recorded.notify[0][0].includes(join(process.env.XDG_STATE_HOME!, "ecomono")), ui.ctx.recorded.notify[0][0])
  assert.equal(ui.ctx.recorded.notify[0][1], "warning")
  assert.equal(ui.ctx.recorded.confirm.length, 0)

  // A new session (a new factory run) notifies again.
  const next = setup({ hooksDir }, { hasUI: true })
  await next.fire("tool_call", bash("ls"), next.ctx)
  assert.equal(next.ctx.recorded.notify.length, 1)
}

{
  // A notify that throws neither blocks nor escapes.
  const { fire, calls, ctx } = setup({ hooksDir: hooks({ "secret-access-gate": `${ALLOW}; exit 3` }) }, { hasUI: true })
  ctx.ui.notify = () => {
    throw new Error("no ui")
  }
  assert.equal(await fire("tool_call", bash("ls"), ctx), undefined)
  assert.ok(calls.warn.some((l) => l.includes("notify failed")))
}

// ---- cwd resolution -----------------------------------------------------------------------------------------

{
  // An internal-URL cwd has no host directory, but omp's embedded shell still reaches the host: every gate runs,
  // in ctx.cwd, and nothing fails open.
  for (const url of ["skill://x", "local://"]) {
    const d = dir("rec")
    const { fire, calls, ctx } = setup({ hooksDir: hooks(recording(d)) })
    assert.equal(await fire("tool_call", bash("ls", { cwd: url }), ctx), undefined, url)
    for (const g of GATES) assert.equal(recorded(d, g)?.pwd, realpathSync(ctx.cwd), `${url}: ${g} ran in ctx.cwd`)
    assert.ok(!calls.warn.some((l) => l.includes("failing open")), url)

    // The literal check still applies before the cwd is looked at.
    assert.equal((await fire("tool_call", bash("rm -rf /", { cwd: url }), ctx))?.block, true, url)
  }
}

{
  // A cwd of "/" is the session cwd, as omp's resolveToCwd has it, not the filesystem root.
  const d = dir("rec")
  const { fire, ctx } = setup({ hooksDir: hooks(recording(d)) })
  assert.equal(await fire("tool_call", bash("ls", { cwd: "/" }), ctx), undefined)
  assert.equal(recorded(d, "secret-access-gate")?.pwd, realpathSync(ctx.cwd))
}

// ---- a handler fault fails open, traced like a gate ---------------------------------------------------------

{
  // A confirm that rejects: the call is allowed (the documented fail-open), and it leaves the logger line, a
  // line in <XDG_STATE_HOME>/ecomono/tool-call.log and one notice that names that directory.
  const before = stateLog("tool-call").length
  const { fire, calls, ctx } = setup({ hooksDir: hooks({ "secret-access-gate": say("ask", "A-secret") }) }, { hasUI: true })
  ctx.ui.confirm = () => Promise.reject(new Error("confirm broke"))
  assert.equal(await fire("tool_call", bash("ls"), ctx), undefined)
  assert.ok(calls.warn.some((l) => l.includes("[tool-call] failing open") && l.includes("handler failed: confirm broke")))
  assert.equal(stateLog("tool-call").length, before + 1)
  assert.match(stateLog("tool-call").at(-1)!, /handler failed: confirm broke/)
  assert.equal(ctx.recorded.notify.length, 1)
  assert.ok(ctx.recorded.notify[0][0].includes(join(process.env.XDG_STATE_HOME!, "ecomono")), ctx.recorded.notify[0][0])
}

{
  // `~` is the home directory.
  const d = dir("rec")
  const { fire, ctx } = setup({ hooksDir: hooks(recording(d)) })
  assert.equal(await fire("tool_call", bash("ls", { cwd: "~" }), ctx), undefined)
  assert.equal(recorded(d, "secret-access-gate")?.pwd, realpathSync(homedir()))
}

{
  // A relative cwd is joined to ctx.cwd; no cwd means ctx.cwd.
  const d = dir("rec")
  const base = dir("cwd")
  mkdirSync(join(base, "sub"))
  const { fire, ctx } = setup({ hooksDir: hooks(recording(d)) }, { cwd: base })
  assert.equal(await fire("tool_call", bash("ls", { cwd: "sub" }), ctx), undefined)
  assert.equal(recorded(d, "secret-access-gate")?.pwd, realpathSync(join(base, "sub")))
  assert.equal(await fire("tool_call", bash("ls"), ctx), undefined)
  assert.equal(recorded(d, "secret-access-gate")?.pwd, realpathSync(base))
}

// ---- github -------------------------------------------------------------------------------------------------

{
  for (const [op, command] of [["pr_create", "gh pr create"], ["pr_push", "git push"]] as const) {
    const d = dir("rec")
    const { fire, ctx } = setup({ hooksDir: hooks(recording(d)) })
    assert.equal(await fire("tool_call", github(op), ctx), undefined, op)
    const want = { tool_input: { command } }
    assert.deepEqual(recorded(d, "check-diff-size")?.input, want, op)
    assert.deepEqual(recorded(d, "review-receipt-gate")?.input, want, op)
    assert.equal(recorded(d, "check-diff-size")?.pwd, realpathSync(ctx.cwd))
    assert.equal(recorded(d, "secret-access-gate"), undefined, `${op}: no secret gate`)
  }

  const d = dir("rec")
  const { fire, ctx } = setup({ hooksDir: hooks(recording(d)) })
  assert.equal(await fire("tool_call", github("repo_view"), ctx), undefined)
  for (const g of GATES) assert.equal(recorded(d, g), undefined, `repo_view ran ${g}`)

  // The same merge applies: a receipt deny blocks the delivery.
  const deny = setup({ hooksDir: hooks({ "review-receipt-gate": say("deny", "R-receipt") }) })
  assert.deepEqual(await deny.fire("tool_call", github("pr_create"), deny.ctx), { block: true, reason: "R-receipt" })
}

// ---- malformed events ---------------------------------------------------------------------------------------

{
  const { fire, calls, ctx } = setup({ hooksDir: hooks({ "secret-access-gate": say("deny", "R") }) })
  for (const ev of [
    { toolName: "bash", input: null },
    { toolName: "bash", input: "ls" },
    { toolName: "bash", input: {} },
    { toolName: "bash", input: { command: 42 } },
    { toolName: "github", input: null },
    { toolName: "github", input: {} },
    { toolName: "read", input: { path: "x" } },
    { toolName: "task", input: null },
    { toolName: "task", input: {} },
    { toolName: "task", input: { tasks: [null, 3] } },
    {},
    undefined,
  ]) {
    assert.equal(await fire("tool_call", ev, ctx), undefined, JSON.stringify(ev))
  }
  // safe() would turn a TypeError into the same undefined, so the guard's own effect is that nothing threw.
  assert.ok(calls.warn.every((l) => !l.includes("handler failed")), calls.warn.join("\n"))
}

// ---- the real Claude scripts --------------------------------------------------------------------------------

{
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
    })
  const repoWith = (armed: boolean) => {
    const d = dir("git")
    git(d, "init", "-q", "-b", "master")
    writeFileSync(join(d, "a.txt"), "a\n")
    git(d, "add", "a.txt")
    git(d, "commit", "-q", "-m", "base")
    git(d, "checkout", "-q", "-b", "work")
    writeFileSync(join(d, "b.txt"), "b\n")
    git(d, "add", "b.txt")
    git(d, "commit", "-q", "-m", "work")
    if (armed) {
      mkdirSync(join(d, ".git/ecomono"))
      writeFileSync(join(d, ".git/ecomono/review-mode"), "")
    }
    return d
  }
  const real = join(REPO, "claude/hooks")
  // No valve inherited from the shell running the suite.
  const clean = { ECOMONO_ALLOW_UNREVIEWED_PUSH: undefined, ECOMONO_ALLOW_SECRET_PATHS: undefined }

  await withEnv(clean, async () => {
    const armed = setup({ hooksDir: real }, { cwd: repoWith(true) })
    const r = await armed.fire("tool_call", bash("git push"), armed.ctx)
    assert.equal(r?.block, true)
    assert.match(r.reason, /Review mode is armed/)

    const off = setup({ hooksDir: real }, { cwd: repoWith(false) })
    assert.equal(await off.fire("tool_call", bash("git push"), off.ctx), undefined)

    // Headless, a credential path is an ask, which blocks; the command is event input only and never runs.
    const secret = setup({ hooksDir: real })
    const rs = await secret.fire("tool_call", bash("cat ~/.ssh/id_rsa"), secret.ctx)
    assert.equal(rs?.block, true)
    assert.match(rs.reason, /credential material/)

    // The same with an internal-URL cwd: omp still runs the command on the host.
    for (const url of ["skill://x", "local://"]) {
      const ru = await secret.fire("tool_call", bash("cat ~/.ssh/id_ed25519", { cwd: url }), secret.ctx)
      assert.equal(ru?.block, true, url)
      assert.match(ru.reason, /credential material/, url)
    }
  })

  // The release valve is inherited from the environment, not stripped as OpenCode does.
  await withEnv({ ...clean, ECOMONO_ALLOW_SECRET_PATHS: "1" }, async () => {
    const secret = setup({ hooksDir: real })
    assert.equal(await secret.fire("tool_call", bash("cat ~/.ssh/id_rsa"), secret.ctx), undefined)
  })
}

// ---- the judge gate (task) ----------------------------------------------------------------------------------

{
  const real = join(REPO, "claude/hooks")
  const HEADING = "## Skills to load before work"
  const task = (input: unknown) => ({ toolName: "task", toolCallId: "call-1", input })
  const item = { agent: "ecomono-judge-a", task: "review", solutionSpace: "n/a" }

  // The real script, which alone knows the judges: no heading blocks, a heading line in the rebuilt prompt (the
  // batch context or the item's task, the two fields omp hands the child as text) lets it through. A heading
  // that sits only in solutionSpace blocks: omp feeds that field to the auto-thinking classifier alone.
  const { fire, ctx } = setup({ hooksDir: real })
  const r = await fire("tool_call", task({ context: "x", tasks: [item] }), ctx)
  assert.equal(r?.block, true)
  assert.match(r.reason, /Skills to load before work/)
  assert.equal(await fire("tool_call", task({ context: `x\n${HEADING}\n- a/SKILL.md`, tasks: [item] }), ctx), undefined)
  const onlySpace = await fire("tool_call", task({ context: "x", tasks: [{ ...item, solutionSpace: `${HEADING}\n- a/SKILL.md` }] }), ctx)
  assert.equal(onlySpace?.block, true, "a heading only in solutionSpace never reaches the judge")
  assert.equal(await fire("tool_call", task({ context: "x", tasks: [{ ...item, task: `review\n${HEADING}` }] }), ctx), undefined)
  assert.equal(await fire("tool_call", task({ context: "x", tasks: [{ ...item, agent: "ecomono-explore" }] }), ctx), undefined)
  assert.equal(await fire("tool_call", task({ context: "x", tasks: [{ ...item, agent: "explore" }] }), ctx), undefined)
  // omp trims the agent name before the lookup, so a padded judge name is still a judge.
  const padded = await fire("tool_call", task({ context: "x", tasks: [{ ...item, agent: " ecomono-judge-a " }] }), ctx)
  assert.equal(padded?.block, true, "a padded judge name is gated")

  // A non-batch call is one item, with its own context field.
  const single = await fire("tool_call", task({ agent: "ecomono-judge-b", task: "review", solutionSpace: "n/a" }), ctx)
  assert.equal(single?.block, true)
  const flatSpace = await fire("tool_call", task({ agent: "ecomono-judge-b", task: "review", solutionSpace: HEADING }), ctx)
  assert.equal(flatSpace?.block, true, "a heading only in solutionSpace never reaches the judge")
  assert.equal(await fire("tool_call", task({ agent: "ecomono-judge-b", task: `review\n${HEADING}` }), ctx), undefined)
  assert.equal(await fire("tool_call", task({ agent: "ecomono-judge-b", task: "review", context: HEADING }), ctx), undefined)

  // omp repairs a double-encoded `task` or `context` after this event (pi-tui tools/task-repair-args.ts): two escape
  // sequences, or a structural escape, and a body that parses as a JSON string. The child then reads the decoded
  // text, so a heading written as `\\n## Skills ...` is a real heading line and the call is let through.
  const escaped = `review\\n${HEADING}\\n- a/SKILL.md\\n`
  assert.equal(await fire("tool_call", task({ context: "x", tasks: [{ ...item, task: escaped }] }), ctx), undefined)
  assert.equal(await fire("tool_call", task({ context: `x\\n${HEADING}\\n- a/SKILL.md\\n`, tasks: [item] }), ctx), undefined)
  assert.equal(await fire("tool_call", task({ agent: "ecomono-judge-b", task: escaped }), ctx), undefined)
  // omp leaves these as typed, so the heading is not a line for the child: one escape is no double-encoding
  // signature, and a bare quote makes the body no JSON string.
  for (const typed of [`review\\n${HEADING}`, `review\\n${HEADING}\\nsay "hi"`]) {
    const blocked = await fire("tool_call", task({ context: "x", tasks: [{ ...item, task: typed }] }), ctx)
    assert.equal(blocked?.block, true, typed)
    assert.match(blocked.reason, /Skills to load before work/)
  }

  // One bad item among good ones blocks the whole call; a heading on one item does not cover another.
  const mixed = await fire(
    "tool_call",
    task({ context: "x", tasks: [{ ...item, task: `review\n${HEADING}` }, { ...item, agent: "ecomono-judge-fix" }] }),
    ctx,
  )
  assert.equal(mixed?.block, true)
  assert.match(mixed.reason, /ecomono-judge-fix/)
}

{
  // What the script receives, and which items reach it. The stub accepts any agent name, so nothing in the
  // extension decides what a judge is.
  const d = dir("judge")
  const seen = () =>
    readdirSync(d)
      .filter((f) => f.endsWith(".in"))
      .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")))
      .sort((a, b) => a.tool_input.subagent_type.localeCompare(b.tool_input.subagent_type))
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "R-judge" } })
  const hooksDir = dir("hooks")
  stub(
    hooksDir,
    "judge-standards-gate",
    `in=$(cat)\nprintf '%s' "$in" > "${d}/in.$$.in"\ncase "$in" in\n  *'"subagent_type":"deny-me"'*)\ncat <<'EOF'\n${deny}\nEOF\n    ;;\nesac`,
  )
  const task = (input: unknown) => ({ toolName: "task", toolCallId: "call-1", input })
  const { fire, ctx } = setup({ hooksDir })

  // Batch: the context, then the item's task, one per line (solutionSpace is not part of the prompt); empty and
  // non-string fields are dropped; an item without a string agent never reaches the script; the agent name is
  // passed trimmed, as omp resolves it.
  assert.equal(
    await fire(
      "tool_call",
      task({
        context: "C",
        tasks: [
          { agent: "a1", solutionSpace: "S", task: "T" },
          { agent: " a2 ", task: "T2" },
          { task: "no agent" },
          { agent: 5, task: "numeric agent" },
          null,
          "a string item",
        ],
      }),
      ctx,
    ),
    undefined,
  )
  assert.deepEqual(seen(), [
    { tool_input: { subagent_type: "a1", prompt: "C\nT" } },
    { tool_input: { subagent_type: "a2", prompt: "C\nT2" } },
  ])
  for (const f of readdirSync(d)) rmSync(join(d, f))

  // Non-batch: the call itself is the item.
  assert.equal(await fire("tool_call", task({ agent: "a3", context: "C", solutionSpace: "S", task: "T" }), ctx), undefined)
  assert.deepEqual(seen(), [{ tool_input: { subagent_type: "a3", prompt: "C\nT" } }])
  for (const f of readdirSync(d)) rmSync(join(d, f))

  // Nothing to gate: no script runs.
  for (const input of [{}, { task: "x" }, { tasks: [] }, { tasks: [{ task: "x" }] }, { agent: 7 }, { tasks: "nope", task: "x" }]) {
    assert.equal(await fire("tool_call", task(input), ctx), undefined, JSON.stringify(input))
  }
  assert.deepEqual(seen(), [])

  // A deny on any item blocks, with the script's reason.
  const blocked = await fire("tool_call", task({ tasks: [{ agent: "a1", task: "T" }, { agent: "deny-me", task: "T" }] }), ctx)
  assert.deepEqual(blocked, { block: true, reason: "R-judge" })
  assert.equal(seen().length, 2, "both items were judged")
  for (const f of readdirSync(d)) rmSync(join(d, f))

  // The items run concurrently: the same rendezvous as for the bash gates, one marker per judge run.
  const slowDir = dir("hooks")
  stub(slowDir, "judge-standards-gate", rendezvous(dir("rendezvous"), 3))
  const slow = setup({ hooksDir: slowDir })
  assert.equal(
    await slow.fire("tool_call", task({ tasks: [{ agent: "a1", task: "x" }, { agent: "a2", task: "x" }, { agent: "a3", task: "x" }] }), slow.ctx),
    undefined,
  )
  assert.deepEqual(slow.calls.warn.filter((l) => l.includes("failing open")), [], "a judge gate timed out waiting for the others")

  // A script that is missing or fails fails open, like the other gates.
  const missing = setup({ hooksDir: dir("hooks") })
  assert.equal(await missing.fire("tool_call", task({ agent: "ecomono-judge-a", task: "x" }), missing.ctx), undefined)
  assert.ok(missing.calls.warn.some((l) => l.includes("[judge-standards-gate] failing open")))
}

// ---- runHook, directly --------------------------------------------------------------------------------------

{
  const d = dir("probe")
  const sleeper = stub(d, "sleeper", "exec sleep 5")
  let sayN = 0
  const say2 = (body: object) => stub(d, `say-${++sayN}`, `cat >/dev/null\ncat <<'EOF'\n${JSON.stringify(body)}\nEOF`)
  const cwd = dir("cwd")
  const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }))
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const probe = (script: string, over: Record<string, any> = {}) => {
    const lines: string[] = []
    const p = runHook({ name: "probe-gate", script, payload: { tool_input: { command: "x" } }, cwd, timeoutMs: 5000, report: (l) => void lines.push(l), ...over })
    return { p, lines }
  }

  // (1) and (2): a payload JSON cannot serialize is reported once; the deliberate kill is not a timeout.
  const cyclic: any = {}
  cyclic.self = cyclic
  for (const payload of [{ tool_input: { n: 1n } }, cyclic]) {
    const t0 = performance.now()
    const { p, lines } = probe(sleeper, { payload, timeoutMs: 10_000 })
    const r = await settle(p)
    assert.deepEqual(r, { ok: true, v: undefined })
    assert.ok(performance.now() - t0 < 2000, "settled well before the stub would exit")
    assert.equal(lines.length, 1)
    assert.match(lines[0], /the payload could not be serialized/)
    await wait(500)
    assert.equal(lines.length, 1, "the kill is not reported again as a timeout")
  }

  // (3): a report that throws costs neither the allow nor the state-log line.
  {
    const before = stateLog("probe-gate").length
    const r = await settle(
      runHook({
        name: "probe-gate",
        script: join(d, "no-such-script.sh"),
        payload: {},
        cwd,
        timeoutMs: 5000,
        report: () => {
          throw new Error("report broke")
        },
      }),
    )
    assert.deepEqual(r, { ok: true, v: undefined })
    const log = stateLog("probe-gate")
    assert.equal(log.length, before + 1)
    assert.match(log.at(-1)!, /no gate script at/)
  }

  // (4): a parsed decision never comes back as a fail-open allow, even when its reason is not a string.
  {
    const weird = { toString: 1 }
    const deny = say2({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: weird } })
    const withDefault = probe(deny, { defaultReason: "D" })
    assert.deepEqual(await settle(withDefault.p), { ok: true, v: { decision: "deny", reason: "D" } })
    assert.equal(withDefault.lines.length, 0)
    const without = probe(deny)
    assert.deepEqual(await settle(without.p), { ok: true, v: { decision: "deny", reason: "probe-gate refused this call." } })
    assert.equal(without.lines.length, 0)

    const ask = probe(say2({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: weird }, systemMessage: "S" }))
    assert.deepEqual(await settle(ask.p), { ok: true, v: { decision: "ask", reason: "S" } })
    assert.equal(ask.lines.length, 0)
  }

  // (5): the timeout branch, with the runner's own timeoutMs.
  {
    const t0 = performance.now()
    const { p, lines } = probe(sleeper, { timeoutMs: 200 })
    assert.deepEqual(await settle(p), { ok: true, v: undefined })
    assert.ok(performance.now() - t0 < 2000, "settled at the timeout, not at the stub's exit")
    assert.equal(lines.length, 1)
    assert.match(lines[0], /did not finish within 200ms/)
  }
}

console.log("test_gates: all assertions passed")
