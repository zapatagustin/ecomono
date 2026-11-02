// The git parsers of the omp side panel (omp/extensions/ecomono/panel/git.ts). Plain assert script, no process:
// the inputs are the shapes git prints (porcelain v2 and numstat with -z, log --graph with NUL-separated fields).
import assert from "node:assert/strict"
import { branchTargets, parseGraph, parseNumstat, parseStatus } from "../extensions/ecomono/panel/git.ts"

const H = "0000000000000000000000000000000000000000"

// ---- parseStatus: ordinary, rename, unmerged, untracked, branch headers ----------------------------------------

{
  const out = [
    `# branch.oid ${H}`,
    "# branch.head master",
    "# branch.upstream origin/master",
    "# branch.ab +1 -0",
    `1 .M N... 100644 100644 100644 ${H} ${H} line\nbreak.md`,
    `1 MM N... 100644 100644 100644 ${H} ${H} both.ts`,
    `1 .M N... 100644 100644 100644 ${H} ${H} dir with space/un staged.md`,
    `1 A. N... 100644 100644 100644 ${H} ${H} added.ts`,
    `1 .D N... 100644 100644 100644 ${H} ${H} gone.ts`,
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts\0old => name.ts`,
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
    "? untracked/new.ts",
    "? café.md",
    "! ignored.log",
    "",
  ].join("\0")
  const { branch, changes } = parseStatus(out)
  assert.equal(branch, "master")
  assert.deepEqual(changes, [
    { path: "line\nbreak.md", staged: ".", unstaged: "M", untracked: false },
    { path: "both.ts", staged: "M", unstaged: "M", untracked: false },
    { path: "dir with space/un staged.md", staged: ".", unstaged: "M", untracked: false },
    { path: "added.ts", staged: "A", unstaged: ".", untracked: false },
    { path: "gone.ts", staged: ".", unstaged: "D", untracked: false },
    { path: "new name.ts", staged: "R", unstaged: ".", untracked: false, from: "old => name.ts" },
    { path: "conflict.ts", staged: "U", unstaged: "U", untracked: false },
    { path: "untracked/new.ts", staged: ".", unstaged: ".", untracked: true },
    { path: "café.md", staged: ".", unstaged: ".", untracked: true },
  ])
  // Detached HEAD and a repo without an upstream: the branch is what git says, and nothing else is required.
  assert.equal(parseStatus("# branch.oid abc\0# branch.head (detached)\0").branch, "(detached)")
  assert.deepEqual(parseStatus(""), { branch: "", changes: [] })
}

// ---- parseNumstat -z: binary, rename (two fields, keyed by the new name), spaces, non-ASCII ------------------------

{
  const out = ["12\t3\tomp/extensions/ecomono/org-todo.ts", "-\t-\timage.png", "0\t0\t\0old => name.ts\0name.ts", "2\t1\t\0dir/a/f\0dir/b/f", "1\t0\tdir with space/f.md", "5\t1\tcafé.md", ""].join("\0")
  const stats = parseNumstat(out)
  assert.deepEqual(stats.get("omp/extensions/ecomono/org-todo.ts"), { add: 12, del: 3 })
  assert.deepEqual(stats.get("image.png"), { add: 0, del: 0 }, "a binary file counts as 0/0")
  assert.deepEqual(stats.get("name.ts"), { add: 0, del: 0 }, "a rename is keyed by its new name")
  assert.deepEqual(stats.get("dir/b/f"), { add: 2, del: 1 }, "a rename across directories is keyed by the new path, not `dir/{a => b}/f`")
  assert.equal(stats.has("dir/a/f") || stats.has("dir/{a => b}/f"), false)
  assert.deepEqual(stats.get("dir with space/f.md"), { add: 1, del: 0 })
  assert.deepEqual(stats.get("café.md"), { add: 5, del: 1 }, "a non-ASCII name arrives unquoted")
  assert.equal(stats.size, 6)
  assert.equal(parseNumstat("").size, 0)
}

// ---- parseGraph: linear, merge, graph-only lines, octopus -----------------------------------------------------

{
  const N = "\0"
  const out = [
    `* 18ace7a${N}HEAD -> master, origin/master, origin/HEAD${N}chore(omp): re-pin citations`,
    `* 4b77521${N}${N}feat(omp): rank org-todo rows`,
    `| *   6690559${N}HEAD -> main${N}mg`,
    "| |\\",
    `| | * 741a467${N}g${N}g1`,
    "| |/",
    "|/",
    `* 0d82ddc${N}tag: v1${N}fix(omp): log once`,
    "",
  ].join("\n")
  const lines = parseGraph(out)
  assert.equal(lines.length, 8)
  assert.deepEqual(lines[0], {
    graph: "●",
    commit: { sha: "18ace7a", refs: ["HEAD -> master", "origin/master", "origin/HEAD"], subject: "chore(omp): re-pin citations", head: true },
  })
  assert.deepEqual(lines[1]!.commit, { sha: "4b77521", refs: [], subject: "feat(omp): rank org-todo rows", head: false })
  assert.equal(lines[1]!.graph, "●")
  // The graph column keeps its width: git's padding after the commit marker is part of the prefix.
  assert.equal(lines[2]!.graph, "│ ●  ")
  assert.deepEqual(lines[2]!.commit?.refs, ["HEAD -> main"])
  // Graph-only lines carry no commit. Diagonals become box corners: the bar a lane forks from or rejoins
  // takes a ├, a `\` becomes the opening corner (┐) and a `/` the closing one (┘).
  assert.deepEqual(lines[3], { graph: "│ ├┐" })
  assert.equal(lines[4]!.graph, "│ │ ●")
  assert.deepEqual(lines[5], { graph: "│ ├┘" })
  assert.deepEqual(lines[6], { graph: "├┘" })
  assert.deepEqual(lines[7]!.commit?.refs, ["tag: v1"])
  // Octopus merge glyphs and a stray subject with a NUL-free graph line.
  assert.deepEqual(parseGraph("|_|/\n| -.\n"), [{ graph: "│─├┘" }, { graph: "│ ─." }])
  assert.deepEqual(parseGraph(""), [])
}

// ---- branchTargets -------------------------------------------------------------------------------------------

{
  assert.deepEqual(branchTargets(["HEAD -> master", "origin/master", "origin/HEAD", "tag: v1"]), { local: ["master"], remote: ["origin/master"] })
  assert.deepEqual(branchTargets(["feature/x", "origin/feature/x"]), { local: ["feature/x"], remote: ["origin/feature/x"] })
  assert.deepEqual(branchTargets(["origin/only-remote"]), { local: [], remote: ["origin/only-remote"] })
  assert.deepEqual(branchTargets([]), { local: [], remote: [] })
  // Neither a branch: a detached HEAD, the stash, a tag. enter on such a commit opens the editor, not `git switch`.
  const none = { local: [], remote: [] }
  assert.deepEqual(branchTargets(["HEAD"]), none)
  assert.deepEqual(branchTargets(["refs/stash"]), none)
  assert.deepEqual(branchTargets(["tag: v1"]), none)
  assert.deepEqual(branchTargets(["HEAD", "refs/stash", "tag: v1", "origin/HEAD"]), none)
  assert.deepEqual(branchTargets(["HEAD", "master"]), { local: ["master"], remote: [] })
}

console.log("test_panel_git: all assertions passed")
