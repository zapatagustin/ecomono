/**
 * Tests for the skill-registry plugin.
 *
 * The plugin runs `node ~/.claude/hooks/ecomono-skill-registry.js` and never waits
 * for it. GENERATOR comes from homedir() at import, and bun reads HOME once at
 * process start, so this file re-executes itself under bun with a fixture HOME and
 * a PATH whose first `node` is a stub. The stub sleeps, then appends its argv to
 * $SR_MARKER as one line; the sleep is what proves `setup` and the prompt hook
 * return without waiting for the generator.
 */

import assert from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as mod from "../skill-registry"
import { fakeCtx, fire } from "./fake-ctx"

if (!process.env.SR_CHILD) {
  const root = mkdtempSync(join(tmpdir(), "sr-plugin-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "node"), `#!/bin/sh\nsleep 0.3\nIFS='|'\necho "$*" >> "$SR_MARKER"\n`, { mode: 0o755 })
  const r = spawnSync(process.execPath, ["run", import.meta.path], {
    stdio: "inherit",
    env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, SR_CHILD: "1", SR_MARKER: join(root, "marker") },
  })
  rmSync(root, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

const plugin = mod.default
const marker = process.env.SR_MARKER!
const GEN = join(process.env.HOME!, ".claude", "hooks", "ecomono-skill-registry.js")
const argv = (dir: string) => [GEN, "--quiet", "--cwd", dir].join("|")
const lines = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [])
const logged: string[] = []
console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "))

async function until(ok: () => boolean, what: string) {
  const end = Date.now() + 5000
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}
const spawns = async (n: number) => (await until(() => lines().length >= n, `${n} generator runs`), lines())
const settle = () => Bun.sleep(500) // longer than the stub's sleep, so a stray run would have landed
async function timed<T>(p: () => Promise<T>) {
  const t0 = performance.now()
  const v = await p()
  return { v, ms: performance.now() - t0 }
}

// (a) Contract: one default export, no v1 named factory.
assert.deepStrictEqual(Object.keys(mod), ["default"])
assert.strictEqual(plugin.id, "skill-registry")
assert.strictEqual(typeof plugin.setup, "function")

// (d) No location: nothing to refresh, and setup must not reach for ctx.session either.
assert.strictEqual(await plugin.setup({}), undefined)

// (b) setup returns undefined (a truthy value would be called as cleanup) without
// waiting for the generator, registers only the prompt hook, and runs it once.
// directory and project.directory differ (a subdirectory of a repo): directory wins.
const { ctx, hooks, assertAwaited } = fakeCtx({ directory: "/sr/dir", projectDirectory: "/sr/root" })
const s = await timed(() => plugin.setup(ctx))
assert.strictEqual(s.v, undefined)
assertAwaited()
assert.ok(s.ms < 200, `setup took ${s.ms.toFixed(0)} ms; it must not await the generator`)
assert.deepStrictEqual(Object.keys(hooks), ["session.prompt"])
assert.deepStrictEqual(await spawns(1), [argv("/sr/dir")])
await settle()
assert.deepStrictEqual(lines(), [argv("/sr/dir")], "setup({}) or a second run spawned")

// (f) G9: every prompt refreshes again, and admission does not wait for it.
const p = await timed(() =>
  fire(hooks, "session.prompt", { sessionID: "s1", messageID: "m1", prompt: { text: "hi" }, delivery: "steer" }),
)
assert.ok(p.ms < 200, `prompt hook took ${p.ms.toFixed(0)} ms; it must not await the generator`)
assert.deepStrictEqual(await spawns(2), [argv("/sr/dir"), argv("/sr/dir")])

// (c) Only project.directory: it becomes --cwd. fakeCtx always fills directory
// (v2 requires it), so drop it here to reach the fallback.
const proj = fakeCtx({ projectDirectory: "/sr/project" })
delete proj.ctx.location.directory
await plugin.setup(proj.ctx)
assert.deepStrictEqual((await spawns(3)).at(-1), argv("/sr/project"))

// (e) node missing from PATH: logged as such, never thrown or rejected.
const savedPath = process.env.PATH
process.env.PATH = ""
try {
  assert.strictEqual(await plugin.setup(fakeCtx({ directory: "/sr/nopath" }).ctx), undefined)
  await until(() => logged.length > 0, "the ENOENT log line")
} finally {
  process.env.PATH = savedPath
}
await settle()
assert.deepStrictEqual(logged, ["[skill-registry] node not on PATH; skill registry not refreshed"])
assert.strictEqual(lines().length, 3)

console.log("test_skill_registry: ok")
