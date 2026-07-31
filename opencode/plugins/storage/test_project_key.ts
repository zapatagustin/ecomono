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

// --- the legacy split is reported, never merged --------------------------------
// A rename keyed on a directory basename can fold two unrelated repos together: `app`
// is a name plenty of checkouts share. So the store notices and says so, and that is all.
const d = getDb()
d.run("INSERT INTO projects (id, name) VALUES (?, ?)", ["old-basename", "old-basename"])
Obs.save({ title: "sdd/x/proposal", content: "written before the switch", project: "old-basename", topic_key: "sdd/x/proposal" })

const moved = repo("old-basename", "git@github.com:owner/new-remote-name.git")
assert.equal(Obs.currentProject(moved).project, "new-remote-name", "derivation switched to the remote")
assert.equal(Obs.search({ query: "before", project: "old-basename" }).length, 1,
  "the pre-switch row stays exactly where it was")
assert.equal(Obs.search({ query: "before", project: "new-remote-name" }).length, 0,
  "and is not silently folded into the new key")
assert.equal((d.query("SELECT COUNT(*) AS n FROM projects WHERE id=?").get("old-basename") as any).n, 1,
  "the old project row survives")

// The collision that made an automatic merge unsafe: an unrelated repo that merely
// shares a directory name must not inherit the first one's memory.
d.run("INSERT INTO projects (id, name) VALUES (?, ?)", ["app", "app"])
Obs.save({ title: "client-one", content: "belongs to the first app", project: "app" })
Obs.currentProject(repo("app", "git@github.com:owner/unrelated-service.git"))
assert.equal(Obs.search({ query: "belongs", project: "app" }).length, 1,
  "a shared basename does not hand one project's rows to another")
assert.equal(Obs.search({ query: "belongs", project: "unrelated-service" }).length, 0,
  "and the unrelated project gains nothing")

console.log("\u2713 project key: derivation holds, and a legacy split is reported rather than merged")
