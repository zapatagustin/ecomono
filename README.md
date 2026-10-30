# ecomono

Portable Claude Code + opencode + omp (oh-my-pi) configuration — the ecomono agent stack,
decoupled from any NixOS/home-manager setup. One repo, installable on **Arch**, **Debian**, and
**NixOS**.

It ships the output style, agents, skills, commands, hooks, MCP wiring, opencode
plugins, and an omp extension as plain files (markdown / JS / TS / JSON), plus a POSIX
installer that symlinks them into place. No external binary: everything it needs is in this repo.

## Layout

```
agent-skills/    Every skill (ecomono*, find-skills, proxy-manager) → ~/.claude/skills,
                 ~/.agents/skills (omp reads this one), and ~/.config/opencode/skills.
                 One tree; see NOTICE.md for forked work.
claude/          CLAUDE.md, agents/, commands/, hooks/, output-styles/, plugins/, themes/,
                 settings.template.json
opencode/        AGENTS.md, opencode.json, cli.json, commands/, plugins/, tui-plugins/
omp/             extensions/ecomono (the one omp extension, see ## omp) and tests/
                 (fake-pi suites, smoke.sh)
lib/common.sh    installer helpers
install.sh       Arch/Debian/generic-Linux installer
flake.nix        NixOS / home-manager module
```

## Install — Arch / Debian / generic Linux

```sh
git clone https://github.com/zapatagustin/ecomono ~/.config/ecomono
~/.config/ecomono/install.sh
```

The installer is **idempotent** and **non-destructive**: it symlinks config into
`~/.claude`, `~/.config/opencode`, `~/.omp/agent`, and `~/.agents/skills`; seeds `~/.claude/settings.json`
from the template **only if absent** (never clobbers the runtime file); backs up any
pre-existing real dir to `*.pre-ecomono.bak` before linking.

It **registers, and re-registers on drift,** the `context7` MCP server and the native **ecomono-memory** MCP
server (a self-contained bun bundle, replacing the old `engram@engram` plugin,
which it uninstalls). It also uninstalls the `superpowers` plugin, whose process
skills now ship from `agent-skills/`.

For **omp** it links, under `~/.omp/agent` (a real directory: omp writes `agent.db`,
`config.yml` and its sessions there), and never writes a `config.yml`:

| Link | Source |
|------|--------|
| `extensions/ecomono` | `omp/extensions/ecomono` |
| `RULES.md` | `opencode/AGENTS.md` (the persona, the one context file omp also hands to subagents) |
| `PERSONALITY.md` | `claude/output-styles/ecomono.md` |
| `agents/<name>.md`, `commands/<name>.md` | `claude/agents/*.md`, `claude/commands/*.md`, one link per file |

It also upserts the `ecomono-memory` and `context7` entries into `~/.omp/agent/mcp.json`,
a real file because omp's dashboard writes `enabled` into it: only `command` and `args`
are managed, so an `enabled`, `env` or `timeout` you set and any other server survive,
and a file that is not a JSON object is left untouched. That step runs whether or not
omp is installed yet. The target directory is `PI_CODING_AGENT_DIR`, else
`$HOME/${PI_CONFIG_DIR:-.omp}/agent`. For a named profile, re-run with
`PI_CODING_AGENT_DIR=~/.omp/profiles/<n>/agent ~/.config/ecomono/install.sh`; the
installer does not read `OMP_PROFILE` itself. Skills need no omp step: `~/.agents/skills`
is already linked and omp reads it by default.

It fetches **no binaries**. The `gentle-ai` dependency is gone: its skill-registry
generator was reimplemented as `claude/hooks/ecomono-skill-registry.js`, and its
SDD dispatchers only ever read an `openspec/` layout this setup does not use.

It **checks** — but does not install — `node`, `claude`, `opencode`, `omp` (optional),
`jq` and `bun`, printing a distro-specific hint if any is missing (those belong to your package
manager).

### Provider credentials are not shipped here

Models come from OpenCode's built-in `opencode-go` provider (the OpenCode Go
subscription), so `opencode/opencode.json` pins a model per agent and declares
no provider block for it and no `apiKey` anywhere. Authenticate once with
`opencode auth login` (or `/connect` in the TUI); it works on every platform,
and the `ecomono-compress` skill's optional `--api` pass reads that same key.

A NixOS consumer running sops-nix can inject the key instead, since
`programs.opencode.settings` merges per key; `ecomono-compress` reads the same
file as its second choice after `OPENCODE_API_KEY`:

```nix
programs.opencode.settings.provider."opencode-go".options.apiKey =
  "{file:/run/secrets/opencode/opencode-api-key}";
```

`provider.anthropic` stays as an empty placeholder no agent uses today, open to
the same injection.

Earlier versions declared `baseURL` and model lists for four API-key providers
(nvidia, groq, cerebras, openrouter), and before that their `apiKey` as
`{file:/run/secrets/...}`. Those paths only exist on a NixOS host running
sops-nix, and `install.sh` links `opencode.json` verbatim rather than patching
it the way it patches `cli.json` — so on Arch, Debian or any generic install the
credentials silently pointed at files that were never going to be there. A repo
that installs on four platforms has no business hardcoding one platform's
secret store. A NixOS consumer still injecting those four keys can drop them;
nothing reads them any more.

**omp** ships no provider block, model id, key or `config.yml` either: authenticate once
with `omp login` (or `/login` in the TUI) or the provider's env key. The agents' `model:` tiers become omp roles
when a subagent is spawned — `haiku` → `@smol`, `sonnet` → `@task`, `opus` → `@slow` —
and a subagent that would silently inherit the main model goes to `@task` instead. Set
the three roles once with `/model` (smol, task, slow). An unset role falls back through
omp's role defaults, so nothing breaks, but every tier then runs on one model. Each
routed spawn carries a note such as `ecomono: sonnet tier -> @task`. To pin one agent,
use omp's `task.agentModelOverrides`, which outranks the frontmatter; an override that
names exactly the main model's `provider/id` looks like silent inheritance and is
rerouted to `@task`, so bind it through a role alias such as `@slow` instead.

omp's own `memory.backend` and `autolearn.enabled` stay off, their defaults. Turning
either on adds a second memory store next to ecomono-memory.

### Permission posture

The seeded `settings.json` sets `defaultMode: "bypassPermissions"` (plus
`skipDangerousModePermissionPrompt: true`), so once installed Claude Code runs every
tool call without asking first — more permissive than Claude Code's own interactive
default. `permissions.deny` in `claude/settings.template.json` is the only thing standing in
the way, and it is narrower than it looks. Read it as two separate lists:

- Two literal `Bash` strings, `rm -rf /` and `rm -rf ~` (plain and `sudo`). Nothing
  else typed at a shell is gated by the deny list.
- Credential paths — `.env` / `.env.*`, `.ssh/*`, `.credentials/*`,
  `Library/Keychains/*`, `.aws/credentials`, `.config/gh/hosts.yml`, `**/*.pem`,
  `**/*.key`, `**/secrets/*` — but these bind to the `Read` and `Edit` tools only.
  **They do not cover `Bash`.** The deny list never sees a path that only appears
  inside a shell command.

`claude/hooks/secret-access-gate.sh` covers the second gap, not the first. It is a
`PreToolUse` hook on `Bash` that matches the command string against the same credential
paths. In the prompting modes it returns `permissionDecision: "ask"`, so `cat ~/.ssh/id_ed25519`
asks instead of running silently. Under `bypassPermissions` — the seeded default — it is
advisory: the command runs, the model receives the warning as `additionalContext`, and you see
a banner. That mode is a request for no prompts and the hook honors it; what the gate buys
there is a model that knows it touched a secret, not a user who approved it. Switch
`defaultMode` to `"default"` to get the prompt back. Three things to know about it:

- It matches **substrings of the command**, so `cat $HOME/.ss''h/id_rsa` walks straight
  through, as does any variable indirection. It catches the careless command and the
  wildcard that swept up a secret — not an adversary. It also cannot tell a path from a
  literal, so `echo id_rsa` prompts too.
- A hook `"ask"` IS honored under `bypassPermissions` — verified with `claude -p --settings`,
  where the gated command never executed — which is why the hook drops it there by choice,
  not by accident. In the prompting modes, **a non-interactive run has nobody to answer it, so
  it lands as a hard block** and retrying is futile. If a headless job legitimately needs one
  of these paths, set `ECOMONO_ALLOW_SECRET_PATHS=1`.
- `check-diff-size.sh` and the two "cannot measure" cases of `review-receipt-gate.sh` follow
  the same rule: `"ask"` in the prompting modes, advisory under `bypassPermissions`. The review
  gate's `"deny"` (armed repo, no receipt) is unchanged in every mode: a block the model can
  act on is not a prompt.

`opencode.json` gets the same paths under `permission.bash`, omp's `agent.db`, its
`auth-broker.token` / `auth-gateway.token` and the commands that print credentials included
(`omp auth export`, `omp token`, `omp auth-broker token`, `omp auth-gateway token`, each also
after a leading long flag such as `--profile=work`, and the last two also with options before
`token`, such as `--json`). That side is glob-only with no safe way to
express an exception (an allow glob for `.env.example` would also pass a command that names
`.env.local` next to it), so `cat .env.example` prompts there while the Claude Code hook stays
quiet on it, `*agent.db*` also asks on a file such as `agent.db.ts`, `*omp token*` also asks on
`omp tokens`, and a doubled space (`omp auth  export`) passes unasked.

So treat this as "the agent can do anything a shell can do on this machine, minus two
`rm -rf` spellings and a prompt on obvious credential paths", not as credential protection.
It is a deliberate trade for a single-user machine. Since `settings.json` is seeded once and
never overwritten, if you want prompts back everywhere, change `defaultMode` in
`~/.claude/settings.json` (or in `claude/settings.template.json` before installing).

#### omp

omp's default `tools.approvalMode` is `yolo`, the same posture, and its own bare
critical-command detection (`rm -rf /`) is ignored there. The extension therefore carries
the gates, as `tool_call` handlers that run the Claude hook scripts and parse the deny
data above instead of restating it:

- **Denied**: the same `rm -rf /` and `rm -rf ~` literals, parsed from
  `claude/settings.template.json`; and every `permission.read` deny glob in
  `opencode/opencode.json`, matched on `read`, `write`, `edit`, `grep`, `glob`, `find`,
  `ast_grep` and `ast_edit` across every path form omp accepts: `path` and `paths`,
  `;` / `,` / whitespace lists, `~`, `@`, quotes, `file://`, `\` separators, `:1-5` /
  `:raw` selectors and `archive.ext:member/path` members (matched as `archive.ext/member/path`),
  each by its own name and by its symlink target. `edit` is also checked on the targets
  in its text input (hashline `[PATH#TAG]` and `MV` lines, apply_patch `*** Add/Update/Delete
  File:` and `*** Move to:` headers, the sloppy mode's `*** Edit File:`, patch-mode `rename`),
  and `task` on the `@path` mentions in each item's `task` text and on its `taskFile` (omp's
  `task.file`, off by default), both of which omp reads into the subagent's first prompt, and
  on a `sourceSession` given as a path (the session file the bundled `seance` agent forks).
  There is no valve. A `read` that omp resolved to a denied file
  (suffix matching, delimited lists, the `resolvedPath` it reports), or a directory `read`
  whose listing (two levels, hidden files included) names one, has its result withheld and
  returned as an error, and so does a `grep`, `ast_grep`, `glob`, `find` or `ast_edit` result
  that lists one, such as a `grep` with no `path`, and the `xd://resolve` or `xd://reject`
  result that settles an `ast_edit` preview listing one. The notice names the glob, never the
  file, and omp's `details` (which the session file keeps and the TUI renders) are cut to their
  counts and flags. As in OpenCode the last matching key wins. The deny is a read guard: no
  result channel (content, `details`, notices, the details omp persists in the session file)
  carries a denied file's bytes or its path text to the model. The withhold is itself a one-bit
  answer, writes to a denied file the path gate cannot see go through, and so do reads inside a
  seance subagent; all three are ceilings, below. A file named for one of the
  `.env` templates the bash gate lets through (`.env.example`, `.sample`, `.template`, `.dist`,
  `.defaults`, `.schema`, read from the gate's own list) is not denied by its name, though a
  denied directory still covers it. OpenCode itself denies those templates: an allow key for
  them would, under its `*`-matches-`/` wildcard, also lift `secrets/` and `.ssh/`. The
  globs include omp's own credential store, `agent.db` and its `-wal` / `-shm` / `-journal`
  siblings, and its `auth-broker.token` / `auth-gateway.token` bearer tokens
  (`secret-access-gate.sh` names them for bash, plus `omp auth export`, `omp token`,
  `omp auth-broker token` and `omp auth-gateway token`, which print them): omp keeps
  provider credentials in plaintext there.
- **Confirmed in the TUI, blocked headless** (print and json modes, subagents included,
  since nobody can answer): an ask from `secret-access-gate.sh` or
  `review-receipt-gate.sh`. `check-diff-size.sh` runs too; its ask is confirmed in the
  TUI and dropped headless, because it is a nudge. The `github` tool's `pr_create` and
  `pr_push` are judged as `gh pr create` and `git push`, and `task` spawns of the judges
  go through `judge-standards-gate.sh`. A bash call whose `cwd` is an internal URL
  (`skill://`, `local://`) is judged on the session directory: omp still runs it on the
  host. A subagent of an ecomono agent whose
  `claude/agents/<name>.md` has a `tools:` line can call only the ecomono-memory tools that
  line lists; bundled omp agents, `/tan` clones, the advisor and agents without a `tools:`
  line are unrestricted.
- **Valves** work as on Claude: `ECOMONO_ALLOW_SECRET_PATHS=1` and
  `ECOMONO_ALLOW_UNREVIEWED_PUSH=1` are read by the scripts from the omp process
  environment, so set them per launch. A gate that cannot run (script missing, 20 s
  timeout, unreadable output), or a gate handler that throws (a failed confirm prompt
  included), fails open with a line in `${XDG_STATE_HOME:-~/.local/state}/ecomono/` and one
  notice per session; omp itself would fail a crashing handler closed. Without `jq` on
  omp's `PATH` three gate scripts exit 0 silently, so the extension warns once per
  session at start (notice, or logger when headless, plus a line in `ecomono.log` there).

Accepted ceilings. Where omp has a native switch it is named:

- User `!` / `$` composer commands are not tool calls; you typed them.
- `eval` (Python and JS, on by default) can read files and spawn processes, so a direct
  `git push` or a secret read there skips the bash gates and the path deny. Set
  `eval.py: false` and `eval.js: false` to turn it off.
- `debug` (on by default) launches any program with any args and cwd through a DAP
  adapter, with no bash event. Set `debug.enabled: false`.
- Writes to denied files: the path deny guards reads, so a write it cannot see goes
  through. That covers `ast_edit` + `xd://resolve` (a pathless or parent-rooted `ast_edit`
  stages edits to a denied file; its preview is withheld, but `xd://resolve` still applies
  them, and only that result is withheld), `eval`, `debug`, and bash outside the secret gate's
  patterns. Set `astEdit.enabled: false`, `eval.py: false` and `eval.js: false`,
  `debug.enabled: false`, or list the folders in `tools.restrictedFolders` (an approval
  prompt, blocking headless).
- `lsp` (on by default) takes a `file` argument the path gate does not see: hover,
  definition, references or symbols on a denied file can surface its lines, and `rename`
  / `code_actions` with `apply` can edit it. Set `lsp.enabled: false`.
- `grep`, `ast_grep`, `glob`, `find` and `ast_edit` over a parent directory (local or
  `ssh://`), a root with glob characters such as `~/.ss*/*`, or no `path` are not blocked up
  front: the gate sees the roots a call names, not the walk. The search post-check withholds a
  result whose `details` lists a denied file, a whole result and not just that file's lines,
  and it sees only what omp lists there. An `ast_edit` result is only a staged preview, and
  withholding it does not discard it (the write ceiling above).
- That whole-result withhold over-blocks: a tracked file under a deny glob (a fixture
  `.pem`, a `secrets/` doc, a template inside `secrets/`) withholds every repo-wide search
  that lists it. Narrow `path` to the directories you mean.
- A withhold is itself a one-bit answer: whether a pathless or parent-rooted `grep`,
  `ast_grep`, `glob` or `find` is withheld tells the model that a denied file under the
  searched root exists and matches the pattern it chose, so repeated calls can recover that
  file's content and, by narrowing `path`, its location (a directory `read` tells the same of
  its entries). `tools.restrictedFolders` refuses such searches up front.
- `tools.restrictedFolders` covers what the path gate cannot see, but it does not filter
  inside a search: any call at or below a listed folder, and a recursive search rooted above
  one, asks for approval in every approval mode, and blocks in a run with no UI.
- An eval `agent()` spawn of an `ecomono-judge-*` agent skips `judge-standards-gate.sh`;
  the spawn event carries no prompt.
- `pr_push` naming a branch other than the current one is judged on HEAD, as
  `git push origin other` is in bash.
- A seance subagent (the bundled `seance` agent, on by default) loads no extensions, so its
  `read`, `grep` and `glob` skip the path deny, and its answer comes back to the parent as the
  task result. Set `task.disabledAgents: ["seance"]`.
- Backgrounded bash (async or auto-background) produces no `tool_result`, so it is not
  compressed.
- An oversized read or search result the post-check withheld was already spilled to
  `artifact://N`, and `read artifact://N` can still return it; N is not shown to the model.
- `ssh://host/path` reads, searches and writes on any host OpenSSH resolves. Its path
  part is matched against the same deny globs as text, whatever the host, so a remote
  `.env` is denied like a local one and `ssh://localhost/...` cannot reach a local secret.
- The deny globs match case-sensitively, so on a case-insensitive filesystem (macOS,
  Windows) `~/.SSH/id` or `.ENV` passes. A symlink counts only when its target exists, so
  a `write` through a dangling link to a denied path passes. `tools.restrictedFolders`
  resolves both natively.
- `@path` mentions are checked in a `task` item's text only, as typed and as omp's
  double-encoding repair decodes it. Other text omp sends as a prompt, such as queued hidden
  next-turn messages, has its mentions read with no tool call. So does a `taskFile`'s
  contents, which omp reads at dispatch, after the gate: its mentions, and for a judge its
  headings, are not checked. Keep `task.file` off (omp's default), or rely on
  `tools.restrictedFolders`, which covers task files.
- The 20 s gate timeout assumes omp's default `extensionHandlers.toolCallTimeoutMs` of
  30 s. Lowered below about 20 s, a slow gate fails the bash call closed.

OpenCode's git ask-globs (`git commit *`, `git push`, `git push *`, `git push --force *`,
`git rebase *`, `git reset --hard *` in `permission.bash`) are not ported to omp: the
receipt gate covers delivery. omp's native `bash.patterns` is the opt-in replacement:
ordered `{match, approval}` rules, `approval` one of `allow`, `prompt` or `deny`, `*` the
only wildcard. A `prompt` rule asks in the TUI even in the default `yolo` mode and is
refused headless. In `config.yml`:

```yaml
bash:
  patterns:
    - match: "git commit *"
      approval: prompt
    - match: "git push*"
      approval: prompt
    - match: "git rebase *"
      approval: prompt
    - match: "git reset --hard *"
      approval: prompt
```

`bash.gitGuard` (off by default) is omp's separate opt-in refusal of `stash`,
`reset --hard` and `checkout` / `switch` / `restore` outside a conflict.

Same trade as above: a gate against forgetting, not against intent.

### Review mode

`claude/hooks/review-receipt-gate.sh` refuses `git push` and `gh pr create` unless the exact
bytes being delivered have a review receipt — written by `/ecomono-judgment` when it reaches
`APPROVED`, and named by the same subject hash the review froze. It runs on all three harnesses:
Claude Code registers it as a `PreToolUse` hook, on opencode
`opencode/plugins/review-receipt-gate.ts` intercepts the `shell` tool and shells out to the
same script, and on omp the extension runs it on `bash` and on the `github` tool's
`pr_create` / `pr_push`: an ask is confirmed in the TUI and blocked headless, a deny shows
the receipt reason. It is **off in every repository** until you arm that repository:

```bash
d="$(git rev-parse --git-common-dir)/ecomono" && mkdir -p "$d" && touch "$d/review-mode"
```

`rm` that file to turn it off again; with the marker gone the hook exits before it computes a
hash or reads a receipt, so there is nothing to bypass. For a single delivery,
`ECOMONO_ALLOW_UNREVIEWED_PUSH=1` stands the gate down without disarming it — in the
environment, or as a **leading** prefix on the command. Only that position counts: as a
substring it would be disarmed by any branch name carrying the text. Past the leading
assignment it authorises **the whole line, every delivery chained into it included** —
confining it to one command needs a shell parser, and every attempt with string matching
refused ordinary quoted arguments while still missing shapes. The match is textual, so write it
exactly as shown: a quoted `='1'`, or another assignment ahead of it, is not recognised.

What the gate catches is a delivery written plainly. `git push`, `git -C path push`, an aliased
`git p` (chains included), `gh pr create` — those are refused without a receipt.
`$(echo git push)`, a backslash-escaped `gi\t push`, `git${IFS}push`, a `gh` alias, or any
wrapper script that shells out to git are not: the hook reads the command before the shell
expands it, so anything that only becomes a delivery during expansion is invisible to it. Treat
it as a gate against forgetting. Enforcement against intent belongs in CI or branch protection.

If the branch this change is measured against is not one of `@{upstream}`, `origin/HEAD`,
`origin/master`, `origin/main`, `master` or `main`, name it with
`git config ecomono.reviewBase <branch>`. Without it, a stale local `master` resolves ahead of
the real base and denies a push whose review already passed. Armed with no base resolvable at
all, the gate asks rather than allowing silently.

Being a client-side hook, it is bypassable by anyone who wants to — it is a gate against
forgetting, not against intent. Real enforcement belongs in CI or branch protection.

### Env overrides

| Var | Effect |
|-----|--------|
| `ECOMONO_SKIP_PLUGINS=1` | skip Claude plugin/MCP registration (omp's `mcp.json` entries are still written) |
| `ECOMONO_ALLOW_SECRET_PATHS=1` | stand down `secret-access-gate.sh`, for headless runs that must touch a credential path; on omp it never lifts the in-process path deny |
| `ECOMONO_ALLOW_UNREVIEWED_PUSH=1` | stand down `review-receipt-gate.sh` for one delivery, in a repo where review mode is armed |
| `ECOMONO_COMPRESS=off` | turn bash-output compression off (Claude hook, opencode plugin and omp extension; opencode reads it from its managed service environment: export it, then run `opencode service restart`) |
| `ECOMONO_ORG_DIR=<dir>` | org directory the omp org-todo widget scans (default `~/work/org`) |
| `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR` | where `install.sh` puts the omp config, as omp itself reads them (default `~/.omp/agent`) |
| `ECOMONO_TARGET=<id>` | override detected `OS_ID` (e.g. `nixos`, `arch`, `debian`, `ubuntu`) for unrecognized distros |

On omp the `ECOMONO_*` variables come from the omp process environment, so the valves and
`ECOMONO_COMPRESS=off` are per launch (`ECOMONO_COMPRESS=off omp`), and an edit to the
extension needs an omp restart. `omp --no-extensions` is the kill switch: omp runs with no
ecomono handler at all, gates and compression included.

### Prerequisites

- `node` — `sudo pacman -S nodejs` / `sudo apt install nodejs` (runs the Claude hooks and the skill registry)
- `claude` — `npm i -g @anthropic-ai/claude-code`
- `opencode` — `curl -fsSL https://opencode.ai/install | bash`
- `omp` (optional) — https://github.com/can1357/oh-my-pi
- `jq` — `sudo pacman -S jq` / `sudo apt install jq` (the gate scripts and the omp `mcp.json` upsert; without it the upsert warns and skips)
- `bun` — `curl -fsSL https://bun.sh/install | bash` (runs ecomono-memory and the omp extension tests)
- `curl` + `tar` — to fetch the binaries

Make sure `~/.local/bin` is on your `PATH`.

### Checks

`bash check.sh` runs everything: the memory store and its committed MCP bundle, the opencode
plugin suite, the installer's linking primitives, the Claude Code hook gates, the persona-drift
and skill-registry selftests, the compress skill's secret guard, and shell syntax. Nothing runs
it for you — there is no CI and no git hook in this repo, so it is worth running before a
commit that touches `opencode/plugins/`, `claude/hooks/`, `install.sh`, or `lib/common.sh`.

Two of its steps cover omp. **omp extension** runs the fake-pi suites in `omp/tests` with
the repo bun. **omp smoke** (`omp/tests/smoke.sh`) deploys the layout into a temp `HOME`
and drives the real omp against a mock provider; it prints `SKIP` without omp on `PATH`.
It keeps omp's extracted native addons in `${XDG_CACHE_HOME:-~/.cache}/ecomono-omp-natives`
(about 94 MB per omp version; deleting it is always safe, the next run re-extracts it).
After a deployment, `bash omp/tests/smoke.sh --installed` checks the real `~/.omp/agent`
read-only (links resolve, agents and commands match the source, `mcp.json` has both
servers) and then runs the same scenarios against the deployed tree.

## Install — NixOS

Don't run `install.sh` on NixOS (home-manager owns those paths). Consume the flake:

```nix
# flake.nix
inputs.ecomono.url = "github:zapatagustin/ecomono";

# home-manager config
imports = [ inputs.ecomono.homeModules.default ];
```

The module manages the config declaratively, adds `nodejs`, `bun` and `jq` (the gate
scripts run from the harness's own `PATH`), and registers plugins/MCP on activation. `settings.json` is left unmanaged (Claude Code
rewrites it at runtime) — seed it once:

```sh
cp "$(nix eval --raw github:zapatagustin/ecomono#... 2>/dev/null || echo ~/.config/ecomono)/claude/settings.template.json" ~/.claude/settings.json
```

or just copy `claude/settings.template.json` from a checkout.

For omp the module links `~/.omp/agent/extensions/ecomono` from the flake source tree (the
extension imports and runs files relative to its own location, so it must sit inside a
complete copy of the repo), `RULES.md`, `PERSONALITY.md`, and the agents and commands one
file each, and upserts `ecomono-memory` and `context7` into `~/.omp/agent/mcp.json` on
activation. The flake hardcodes `.omp/agent`; installing omp and its credentials stays in
your own config.

To try an unpushed checkout on the machine that builds it, override the flake input.
`git+file` only sees tracked files; intent-to-add marks new ones without staging them.
`<input-name>` is whatever your flake calls this repo (`ecomono` in the author's):

```sh
cd <checkout> && git add -N .
sudo nixos-rebuild switch --flake <your-config>#<host> \
  --override-input <input-name> git+file://<checkout> --no-write-lock-file
bash omp/tests/smoke.sh --installed
```

Roll back with the plain `sudo nixos-rebuild switch --flake <your-config>#<host>` (the
locked github input). After the push, run `nix flake update <input-name>`, switch, then
`bash omp/tests/smoke.sh --installed` again.

## omp (oh-my-pi)

The omp target is one extension (`omp/extensions/ecomono`, loaded from
`~/.omp/agent/extensions/ecomono`) plus the links above. It compresses bash output
(`stats.jsonl` lines tagged `omp.bash`), runs the gates described under Permission
posture, routes subagent tiers, guards memory writes of read-only agents, refreshes the
skill registry, shows an org-todo widget below the editor (TUI only, display only: it
scans `docs/` of the working directory and `ECOMONO_ORG_DIR`), and captures your prompts
into the shared ecomono-memory database, as OpenCode does. The persona is `RULES.md`; the
style is `PERSONALITY.md`; each skill is also `/skill:<name>`.

Opt-ins, all native omp settings (`omp config set <key> <value>` or `config.yml`), none
shipped:

- `statusLine.preset: custom` with `statusLine.rightSegments`: add the `usage` and
  `subagents` segments (the `model` segment is on by default). Arrays replace and `custom`
  drops the default preset's layout and `segmentOptions`, so give the full `leftSegments`
  and `rightSegments` lists, restating the options you want kept; the `custom` defaults are
  left `vim, model, mode, path, git, pr` and right `session_name, token_total, cost,
  context_pct`.
- `personality: none` omits omp's personality block and skips `PERSONALITY.md`; `RULES.md`
  still loads, so it approximates Claude's neutral output style rather than matching it.
- `tools.xdevDocs: inline`, or `tools.xdev: false`: omp mounts MCP tools under `xd://`,
  which costs a docs read before the first `mem_*` call.
- `model.toolCallLoopGuard.threshold`: omp's native loop guard (on, threshold 5) stands in
  for OpenCode's loop-breaker, which is not ported; lower it to steer sooner.
- `tools.restrictedFolders`: folder-level protection for what the path gate cannot see. It is
  an approval prompt for any call at or below a listed folder and for a recursive search
  rooted above one, in every approval mode; headless, it blocks.

Notes:

- `ecomono-sdd-explore` has no web tools on omp: omp drops `WebFetch` and `WebSearch` from
  an agent's `tools:`.
- omp's shell minimizer (`shellMinimizer.enabled`, on by default) stays on and coexists
  with compression. Output it already shortened often passes through unchanged, so
  `stats.jsonl` under-counts minimized commands; its `[raw output: artifact://N]` notice is
  kept.
- Prompt capture stores every prompt omp reports as a user prompt, including ones omp sends
  on its own behalf (the continue key, plan execution, compaction, task prompts), and a
  prompt template as its expanded body. The session id a model passes to the memory tools
  is not joined to the omp session id, as in OpenCode.

Upgrade protocol. The tested version is **omp 18.14.0**, set once as `OMP_TESTED` in
`omp/extensions/ecomono/index.ts`; the smoke reads it and exits non-zero on any other omp
unless `ECOMONO_OMP_UNTESTED=1` is set. The net for an upgrade made outside this protocol:
on any other omp, the first prompt logs a warning, once per process and shown where there
is a UI, and blocks nothing.
After updating whatever pins omp in your config and switching, run
`ECOMONO_OMP_UNTESTED=1 bash omp/tests/smoke.sh` and
`ECOMONO_OMP_UNTESTED=1 bash omp/tests/smoke.sh --installed` before relying on
the gates, and diff the code the extension mirrors (the full list, with ranges, is the
`docs/DESIGN.md` "Version coupling" mirror table) against the new release. If something breaks, `omp --no-extensions` is the kill
switch and `ECOMONO_COMPRESS=off` disables compression alone. Update `OMP_TESTED` and the
version here only after the smoke passes.
Since 18.14.0, a provider-qualified selector (`provider/id`) in `modelRoles`,
`task.agentModelOverrides` or an agent's `model:` must name an exact model id or alias: a near
match fails instead of selecting a sibling model (omp CHANGELOG, 18.14.0 Breaking Changes). Bare
selectors such as the agents' `opus` and `sonnet` keep fuzzy matching, and ecomono routes those
tiers to the `@smol`, `@task` and `@slow` roles, so only a `provider/id` written by hand needs
checking.

## Uninstall

Almost every top-level entry the installer lays down is a symlink. Three are real files,
so the symlink removals below skip them: `~/.claude/settings.json` (seeded once, left alone
on later runs), `~/.config/opencode/cli.json` (a patched copy the installer rewrites
every run) and `~/.omp/agent/mcp.json` (upserted, never replaced; the `jq` step below
removes only its two entries). Delete any of them yourself if you want it gone too. `package.json` is copied too,
and re-copied when the repo file changes, because opencode rewrites it at startup to
re-pin its plugin SDK; the `rm` below removes it along with its `package.json.seed` stamp.
`~/.claude/skills`, `~/.agents/skills`,
`~/.config/opencode/skills`, `~/.config/opencode/plugins`, `~/.omp/agent/agents`, and
`~/.omp/agent/commands` are also real dirs (created by `mkdir -p` for `link_children`) and
are left behind after uninstall — only their symlinked children are removed below. The same
goes for the empty `~/.omp/agent/extensions`. For a named omp profile, use its directory
instead of `~/.omp/agent`.

Remove the top-level symlinks:

```sh
rm ~/.claude/CLAUDE.md ~/.claude/agents ~/.claude/commands ~/.claude/hooks \
   ~/.claude/output-styles ~/.claude/themes
rm ~/.config/opencode/AGENTS.md ~/.config/opencode/opencode.json \
   ~/.config/opencode/package.json ~/.config/opencode/package.json.seed ~/.config/opencode/commands ~/.config/opencode/tui-plugins
rm ~/.omp/agent/extensions/ecomono ~/.omp/agent/RULES.md ~/.omp/agent/PERSONALITY.md
```

Those six dirs' *children* are symlinked one at a time (`link_children`), and that
function is additive — a symlink you added yourself is left untouched. Remove only the
symlinks pointing into this repo, not the dirs and not unrelated symlinks, so any
`*.pre-ecomono.bak` sibling the installer wrote when backing up a pre-existing real file
or dir survives, and so does anything you symlinked in yourself.

**Set `REPO` to the path you actually cloned into before running this** — an empty or
wrong `REPO` turns the `-lname "$REPO/*"` pattern into `-lname "/*"`, which matches (and
deletes) every absolute-path symlink in these dirs, not just the ones this repo put
there. The snippet below checks for that and refuses to run instead:

```sh
REPO=~/.config/ecomono  # path you cloned it into
REPO="${REPO%/}"        # strip a trailing slash, or -lname below matches nothing
if [ -n "$REPO" ] && [ -d "$REPO" ]; then
  for d in ~/.claude/skills ~/.agents/skills ~/.config/opencode/skills ~/.config/opencode/plugins \
           ~/.omp/agent/agents ~/.omp/agent/commands; do
    find "$d" -mindepth 1 -maxdepth 1 -type l -lname "$REPO/*" -delete
  done
else
  echo "REPO not set or not a directory — aborting, nothing deleted" >&2
fi
```

`-lname` is a GNU findutils extension, not POSIX — this snippet assumes GNU find (Arch,
Debian; check first on other generic-Linux distros).

Restore any `*.pre-ecomono.bak` backups you want back (in the dirs above, and next
to the top-level symlinks removed first, e.g. `~/.claude/CLAUDE.md.pre-ecomono.bak`).

Undo the MCP registrations:

```sh
claude mcp remove -s user context7
claude mcp remove -s user ecomono-memory
jq 'del(.mcpServers["ecomono-memory"], .mcpServers.context7)' ~/.omp/agent/mcp.json > ~/.omp/agent/mcp.json.new \
  && mv ~/.omp/agent/mcp.json.new ~/.omp/agent/mcp.json
```

(the installer also retires the old `superpowers` and `engram` plugins/MCP entries —
nothing left to undo there.)
