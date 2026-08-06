// The EPIPE guard in review-receipt-gate.ts. Reaching the last line IS the assertion:
// an unguarded write into the stdin of an already-exited script kills the process.
//
// ADD NOTHING BEFORE THE SPAWN — no import, no helper, no assert above the hook call.
// The fault only surfaces while the event loop is cold, so pre-spawn work hides it:
// adding `node:assert` and an `rmSync` there took this from 20/20 failing to 0/20, and
// even a comment above the call costs a run. The payload must also clear the 64 KiB
// pipe buffer. The measurements and the wrong conclusion they first produced are in
// docs/DESIGN.md.
//
// This is narrower than "no cleanup anywhere": an `rmSync` placed AFTER the awaited
// hook call sits outside the cold window the fault needs, since the spawn has already
// happened by then. Verified through `run-tests.sh` with the cleanup in place: 20/20
// runs caught the mutation with the guard deleted, 0/20 false positives with it
// restored — so the fixture root is removed below, after the assertion, rather than
// left to leak.
//
// One run of this file catches the mutation about 29 times in 30, and produces 0 false
// positives in 30. A race is never perfectly deterministic, so `run-tests.sh` runs this
// file five times rather than once, which takes the suite-level miss rate to nothing —
// measured at 20/20 caught, 0/20 false, through the runner.
//
// Re-measure on any change: delete the `stdin?.on("error")` line, confirm `grep -c`
// reports it gone, and run `run-tests.sh` twenty times. Anything short of catching it
// every time means something was added above the call.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ReviewReceiptGatePlugin } from "../review-receipt-gate"

const root = mkdtempSync(join(tmpdir(), "rrg-epipe-"))
const home = join(root, "home")
const repo = join(root, "repo")
mkdirSync(join(home, ".claude", "hooks"), { recursive: true })
mkdirSync(repo, { recursive: true })
writeFileSync(join(home, ".claude", "hooks", "review-receipt-gate.sh"), "#!/usr/bin/env bash\nexit 0\n", {
  mode: 0o755,
})

process.env.HOME = home

const hooks = await ReviewReceiptGatePlugin({ directory: repo } as any)
await hooks["tool.execute.before"]!(
  { tool: "bash", sessionID: "s", callID: "c" } as any,
  { args: { command: "git push " + "x".repeat(200_000) } },
)

rmSync(root, { recursive: true, force: true })
console.log("review-receipt-gate plugin (EPIPE): all assertions passed")
