/**
 * Project-key test — run: bun run test_project_key.ts
 *
 * Both hosts derive the project key from the git remote, falling back to the checkout's
 * basename. This covers the derivation itself and the one-time reconciliation that keeps
 * rows written under the old basename-derived key reachable after the switch. A silent
 * split here does not throw — it just returns fewer results forever.
 */
import { mkdtempSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execSync } from "child_process"
import assert from "assert"

process.env.ECOMONO_DATA_DIR = mkdtempSync(join(tmpdir(), "ecomono-projkey-"))
process.env.ECOMONO_LEGACY_DB = join(tmpdir(), "ecomono-no-such-legacy.db")

const Obs = await import("./observations")
const { getDb } = await import("./db")

const git = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()

function repo(dirName: string, remote?: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "ecomono-repo-")), dirName)
  mkdirSync(root, { recursive: true })
  git(root, "init -q")
  if (remote) git(root, `remote add origin ${remote}`)
  return root
}

// --- derivation -------------------------------------------------------------
assert.equal(Obs.currentProject(repo("checkout-name", "git@github.com:owner/real-name.git")).project, "real-name",
  "ssh remote wins over the directory name")
assert.equal(Obs.currentProject(repo("checkout-name", "https://github.com/owner/real-name.git")).project, "real-name",
  "https remote parses the same")
assert.equal(Obs.currentProject(repo("checkout-name", "https://github.com/owner/real-name")).project, "real-name",
  "a remote without .git still parses")
assert.equal(Obs.currentProject(repo("plain-checkout")).project, "plain-checkout",
  "no remote falls back to the checkout basename")

const notARepo = mkdtempSync(join(tmpdir(), "ecomono-bare-"))
assert.equal(Obs.currentProject(notARepo).project, notARepo.split("/").pop(),
  "outside a git repo, the directory basename stands in")

// --- reconciliation ---------------------------------------------------------
// Simulate the pre-unification state: rows already stored under the basename.
const d = getDb()
d.run("INSERT INTO projects (id, name) VALUES (?, ?)", ["old-basename", "old-basename"])
Obs.save({ title: "sdd/x/proposal", content: "written before the switch", project: "old-basename", topic_key: "sdd/x/proposal" })
assert.equal(Obs.search({ query: "before", project: "old-basename" }).length, 1, "seeded row is findable under the old key")

const moved = repo("old-basename", "git@github.com:owner/new-remote-name.git")
assert.equal(Obs.currentProject(moved).project, "new-remote-name", "derivation switched to the remote")
assert.equal(Obs.search({ query: "before", project: "new-remote-name" }).length, 1,
  "the pre-switch row followed the key instead of going invisible")
assert.equal(Obs.search({ query: "before", project: "old-basename" }).length, 0, "nothing left behind under the old key")

// Ambiguous cases must be left alone: if the new key already holds data, a rename would
// merge two projects that were never the same one.
d.run("INSERT INTO projects (id, name) VALUES (?, ?)", ["occupied-basename", "occupied-basename"])
Obs.save({ title: "legacy", content: "legacy row", project: "occupied-basename" })
d.run("INSERT INTO projects (id, name) VALUES (?, ?)", ["occupied-remote", "occupied-remote"])
Obs.save({ title: "current", content: "current row", project: "occupied-remote" })
Obs.currentProject(repo("occupied-basename", "git@github.com:owner/occupied-remote.git"))
assert.equal(Obs.search({ query: "legacy", project: "occupied-basename" }).length, 1,
  "an occupied target leaves the old key untouched rather than merging")
assert.equal(Obs.search({ query: "current", project: "occupied-remote" }).length, 1,
  "and leaves the target untouched too")

console.log("✓ project key: derivation and one-time legacy reconciliation both hold")
