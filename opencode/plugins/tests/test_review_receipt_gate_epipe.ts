// The EPIPE guard in opencode/plugins/hook-runner/core.ts, which the plugin runs its
// script through. Reaching the last line IS the assertion: an unguarded write into the
// stdin of an already-exited script kills the process.
//
// ADD NOTHING BEFORE THE SPAWN — no import, no helper, no assert above the hook call.
// The fault only surfaces while the event loop is cold, so pre-spawn work hides it:
// adding `node:assert` and an `rmSync` there took this from 20/20 failing to 0/20, and
// even a comment above the call costs a run. The payload must also clear the 64 KiB
// pipe buffer. The measurements and the wrong conclusion they first produced are in
// docs/DESIGN.md. That is also why the v2 `setup` below gets a one-line inline ctx
// rather than `fake-ctx.ts`: one more import and a Proxy are pre-spawn work.
//
// This is narrower than "no cleanup anywhere": an `rmSync` placed AFTER the awaited
// hook call sits outside the cold window the fault needs, since the spawn has already
// happened by then. Verified through `run-tests.sh` with the cleanup in place: 20/20
// runs caught the mutation with the guard deleted, 0/20 false positives with it
// restored — so the fixture root is removed below, after the assertion, rather than
// left to leak.
//
// Re-measured after the v2 port, on Bun 1.4.2: one run of this file caught the mutation
// 30 times in 30, with 0 false positives in 30 (it was about 29 in 30 on Bun 1.3.13 and
// the v1 plugin shape). A race is never perfectly deterministic, so `run-tests.sh` runs
// this file five times rather than once, which takes the suite-level miss rate to
// nothing — measured at 20/20 caught, 0/20 false, through the runner.
//
// Re-measure on any change: delete the `stdin?.on("error")` line in
// opencode/plugins/hook-runner/core.ts, confirm `grep -c` reports it gone, and run
// `run-tests.sh` twenty times. Anything short of catching it every time means something
// was added above the call.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../review-receipt-gate"

const root = mkdtempSync(join(tmpdir(), "rrg-epipe-"))
const home = join(root, "home")
const repo = join(root, "repo")
mkdirSync(join(home, ".claude", "hooks"), { recursive: true })
mkdirSync(repo, { recursive: true })
writeFileSync(join(home, ".claude", "hooks", "review-receipt-gate.sh"), "#!/usr/bin/env bash\nexit 0\n", {
  mode: 0o755,
})

process.env.HOME = home

let before: any
await plugin.setup({ location: { directory: repo }, tool: { hook: async (_: string, cb: any) => void (before = cb) } })
await before({
  tool: "shell",
  sessionID: "s",
  agent: "a",
  messageID: "m",
  id: "c",
  input: { command: "git push " + "x".repeat(200_000) },
})

rmSync(root, { recursive: true, force: true })
console.log("review-receipt-gate plugin (EPIPE): all assertions passed")
