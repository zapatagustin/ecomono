/**
 * Tests for the opencode half of the review receipt gate.
 *
 * What is under test is the TRANSLATION LAYER only — payload in, decision out, and
 * every fail-open path. The gate's own behaviour (hash formula, base resolution,
 * delivery detection, release valve) lives in the shell script and is covered by
 * `claude/hooks/test-review-receipt-gate.sh`; asserting it again here would be the
 * second copy of one contract that the plugin exists to avoid.
 *
 * The plugin locates its script through `$HOME`, so each case points HOME at a fixture
 * directory holding a stub at `.claude/hooks/review-receipt-gate.sh`. That is also
 * what proves the plugin resolves the path at call time rather than at import.
 *
 * One behaviour is not tested HERE: the EPIPE guard on the child's stdin, which only
 * faults in a process that has done nothing before the spawn. It has its own file,
 * `test_review_receipt_gate_epipe.ts`, and adding it to this one would make it
 * decorative — that is measured, see that file's header.
 */

import assert from "node:assert"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ReviewReceiptGatePlugin } from "../review-receipt-gate"

const roots: string[] = []
const realHome = process.env.HOME

/** A fixture HOME whose gate script is `body`. Omit `body` to leave it absent. */
function fixture(body?: string) {
  const root = mkdtempSync(join(tmpdir(), "rrg-plugin-"))
  roots.push(root)
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(join(home, ".claude", "hooks"), { recursive: true })
  mkdirSync(repo, { recursive: true })
  if (body !== undefined) {
    writeFileSync(join(home, ".claude", "hooks", "review-receipt-gate.sh"), body, { mode: 0o755 })
  }
  return { root, home, repo }
}

/** Build the plugin against a fixture and run its hook on one command. */
async function runHook(
  fx: { home: string; repo: string },
  args: any,
  tool = "bash",
): Promise<Error | null> {
  process.env.HOME = fx.home
  try {
    const hooks = await ReviewReceiptGatePlugin({ directory: fx.repo } as any)
    const before = hooks["tool.execute.before"]!
    try {
      await before({ tool, sessionID: "s", callID: "c" } as any, { args })
      return null
    } catch (err) {
      return err as Error
    }
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
  }
}

const DENY = (reason: string) =>
  `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'JSON'\n${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    systemMessage: "blocked",
  })}\nJSON\n`

// --- a refusal reaches the agent -------------------------------------------------

{
  const fx = fixture(DENY("no receipt for these bytes"))
  const err = await runHook(fx, { command: "git push" })
  assert.ok(err, "a deny decision must abort the tool call")
  assert.strictEqual(err!.message, "no receipt for these bytes")
}

{
  // `ask` is the script's "armed but I cannot run" state. opencode has no third
  // outcome, so it blocks here — the documented asymmetry with the Claude hook.
  const fx = fixture(
    `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'JSON'\n${JSON.stringify({
      hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "no base resolves" },
    })}\nJSON\n`,
  )
  const err = await runHook(fx, { command: "git push" })
  assert.ok(err, "an ask decision must also abort on opencode")
  assert.strictEqual(err!.message, "no base resolves")
}

{
  // A decision with no reason still has to say something actionable.
  const fx = fixture(
    `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'JSON'\n${JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny" },
      systemMessage: "the fallback line",
    })}\nJSON\n`,
  )
  const err = await runHook(fx, { command: "git push" })
  assert.strictEqual(err!.message, "the fallback line")
}

// --- the payload and cwd the script is given --------------------------------------

{
  const fx = fixture(`#!/usr/bin/env bash\ncat > "$(dirname "$0")/stdin.json"\npwd > "$(dirname "$0")/cwd.txt"\n`)
  const hooksDir = join(fx.home, ".claude", "hooks")
  const err = await runHook(fx, { command: "git -C x push origin master" })
  assert.strictEqual(err, null, "a script that prints nothing must allow")

  const payload = JSON.parse(readFileSync(join(hooksDir, "stdin.json"), "utf8"))
  assert.deepStrictEqual(
    payload,
    { tool_input: { command: "git -C x push origin master" } },
    "the payload must be the shape the Claude hook receives",
  )
  assert.strictEqual(
    readFileSync(join(hooksDir, "cwd.txt"), "utf8").trim(),
    fx.repo,
    "the script must run in the session directory, since it resolves the repo from cwd",
  )
}

// --- what must never reach the script ---------------------------------------------

{
  const fx = fixture(`#!/usr/bin/env bash\ntouch "$(dirname "$0")/ran"\n`)
  const ran = join(fx.home, ".claude", "hooks", "ran")

  assert.strictEqual(await runHook(fx, { command: "git push" }, "read"), null)
  assert.ok(!existsSync(ran), "a non-bash tool must not spawn the gate")

  assert.strictEqual(await runHook(fx, { command: "" }), null)
  assert.ok(!existsSync(ran), "an empty command must not spawn the gate")

  assert.strictEqual(await runHook(fx, {}), null)
  assert.ok(!existsSync(ran), "a bash call with no command must not spawn the gate")

  assert.strictEqual(await runHook(fx, undefined), null)
  assert.ok(!existsSync(ran), "absent args must not spawn the gate")
}

// --- every fail-open path ----------------------------------------------------------

{
  const fx = fixture() // no script at all
  assert.strictEqual(await runHook(fx, { command: "git push" }), null, "a missing script must allow")
}

{
  const fx = fixture(`#!/usr/bin/env bash\ncat >/dev/null\necho 'not json at all'\n`)
  assert.strictEqual(await runHook(fx, { command: "git push" }), null, "unparseable output must allow")
}

{
  const fx = fixture(`#!/usr/bin/env bash\ncat >/dev/null\necho '{"hookSpecificOutput":{"permissionDecision":"allow"}}'\n`)
  assert.strictEqual(await runHook(fx, { command: "git push" }), null, "any decision but deny/ask must allow")
}

{
  const fx = fixture(`#!/usr/bin/env bash\ncat >/dev/null\necho '"a bare string"'\n`)
  assert.strictEqual(await runHook(fx, { command: "git push" }), null, "valid JSON of the wrong shape must allow")
}

{
  const fx = fixture(`#!/usr/bin/env bash\ncat >/dev/null\nexit 7\n`)
  assert.strictEqual(await runHook(fx, { command: "git push" }), null, "a non-zero exit must allow")
}

{
  // Not executable: execFile fails with EACCES, which is an environment failure.
  const fx = fixture()
  const script = join(fx.home, ".claude", "hooks", "review-receipt-gate.sh")
  writeFileSync(script, "#!/usr/bin/env bash\necho '{}'\n", { mode: 0o644 })
  assert.strictEqual(await runHook(fx, { command: "git push" }), null, "a non-executable script must allow")
}

// --- end to end, against the real script and a real armed repository --------------
//
// Everything above stubs the gate, which proves the translation and nothing about the
// port. This drives the actual `claude/hooks/review-receipt-gate.sh` through the
// plugin against a real git repository, which is the only assertion here that would
// catch the two halves not fitting together — a payload key the script does not read,
// a decision value the plugin does not recognise, output it cannot parse.

{
  const real = join(import.meta.dir, "..", "..", "..", "claude", "hooks", "review-receipt-gate.sh")
  assert.ok(existsSync(real), `the gate script must exist at ${real}`)

  const fx = fixture()
  symlinkSync(real, join(fx.home, ".claude", "hooks", "review-receipt-gate.sh"))

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fx.repo, encoding: "utf8", env: { ...process.env, HOME: fx.home } })

  git("init", "-q", "-b", "master")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(fx.repo, "a.txt"), "one\n")
  git("add", "-A")
  git("commit", "-qm", "base")
  // A base that resolves and a diff that is not empty: the shape the gate demands a
  // receipt for. `ecomono.reviewBase` names it, so the candidate list is not guessed at.
  git("branch", "work-base")
  git("config", "ecomono.reviewBase", "work-base")
  writeFileSync(join(fx.repo, "a.txt"), "two\n")
  git("add", "-A")
  git("commit", "-qm", "change")

  const gitdir = join(fx.repo, ".git")
  const ecomono = join(gitdir, "ecomono")
  mkdirSync(join(ecomono, "receipts"), { recursive: true })

  // Unarmed: no marker, so the gate exits before it looks at anything.
  assert.strictEqual(
    await runHook(fx, { command: "git push origin master" }),
    null,
    "review mode off must allow — the marker is the kill switch",
  )

  writeFileSync(join(ecomono, "review-mode"), "")

  assert.strictEqual(
    await runHook(fx, { command: "git status" }),
    null,
    "a non-delivery must allow even in an armed repository",
  )

  const blocked = await runHook(fx, { command: "git push origin master" })
  assert.ok(blocked, "an armed repository with no receipt must refuse the push")
  assert.match(blocked!.message, /Refusing this delivery/, "the script's refusal text must reach the agent")
  assert.match(blocked!.message, /ecomono-judgment/, "the refusal must name the command that resolves it")

  // The delivery detector's non-obvious shapes, driven through the plugin rather than
  // asserted about the script: these are the ones a substring match let through.
  for (const cmd of ["git -C . push", "git --no-pager push", "gh -R o/r pr create"]) {
    assert.ok(await runHook(fx, { command: cmd }), `must refuse: ${cmd}`)
  }

  // The leading-prefix release valve, end to end.
  assert.strictEqual(
    await runHook(fx, { command: "ECOMONO_ALLOW_UNREVIEWED_PUSH=1 git push origin master" }),
    null,
    "the documented override must stand the gate down",
  )

  // A receipt for these exact bytes, written with the skill's formula.
  const mb = git("merge-base", "HEAD", "work-base").trim()
  const diff = execFileSync("git", ["diff", mb], { cwd: fx.repo, maxBuffer: 1 << 24 })
  const hash = createHash("sha256").update(diff).digest("hex").slice(0, 12)

  writeFileSync(join(ecomono, "receipts", hash), "ESCALATED\n")
  const escalated = await runHook(fx, { command: "git push origin master" })
  assert.ok(escalated, "a non-approving receipt must refuse, not pass")
  assert.match(escalated!.message, /non-approving verdict/)

  writeFileSync(join(ecomono, "receipts", hash), "APPROVED\n")
  assert.strictEqual(
    await runHook(fx, { command: "git push origin master" }),
    null,
    "an APPROVED receipt for the delivered bytes must allow the push",
  )

  // Moving the bytes invalidates the receipt: the freeze is the point.
  writeFileSync(join(fx.repo, "a.txt"), "three\n")
  git("add", "-A")
  git("commit", "-qm", "after review")
  assert.ok(
    await runHook(fx, { command: "git push origin master" }),
    "a commit after the review must refuse — the receipt is bound to the reviewed bytes",
  )
}

for (const r of roots) rmSync(r, { recursive: true, force: true })
console.log("review-receipt-gate plugin: all assertions passed")
