#!/usr/bin/env bash
# PreToolUse gate on the Bash tool: when a shell command names credential
# material, downgrade it to a confirmation prompt in the prompting modes, and
# under bypassPermissions warn instead of letting it pass unremarked.
#
# Why a hook and not a deny rule: `permissions.deny` in settings.template.json
# already lists these paths, but every entry there binds to `Read` and `Edit`. The
# shell never consults that list, so under `defaultMode: bypassPermissions` a
# `cat ~/.ssh/id_ed25519` — or a curl that uploads it — runs unprompted. A hook is
# the only place that sees the command string before it executes.
#
# Three signals, same as check-diff-size.sh: permission "ask", additionalContext,
# systemMessage.
#
# Measured, not assumed: a hook-returned "ask" IS honored under bypassPermissions —
# verified with `claude -p --settings` against this gate, where the command never
# executed. The docs only state the carve-out for auto mode, so this was worth a
# probe. The same probe turned up the consequence that matters more: in a
# NON-INTERACTIVE run (`-p`, cron, a subagent) there is nobody to answer an "ask",
# so it lands as a hard block and retrying is futile. That is the right posture for
# a credential gate — headless is exactly where silent secret access should fail —
# but it means an automated job that legitimately needs one of these paths cannot
# proceed. ECOMONO_ALLOW_SECRET_PATHS=1 is the release valve for that case.
#
# Under bypassPermissions the "ask" is dropped and the gate is advisory. That mode is the
# user's choice of a session with no prompts, and a hook "ask" — honored there, see above —
# reinstates one on every command that names a credential path, which is the thing they
# turned off. The reason still reaches the model as additionalContext and the banner still
# shows, but the command runs: what the gate buys in that mode is a model that knows it just
# touched a secret, not a user who approved it. Payloads without `permission_mode` (older
# Claude Code, the omp runner) read as "not bypass" and keep the prompt.
#
# ecomono: substring matching on the command line. `cat $HOME/.ss''h/id_rsa`
# defeats it, and so does any variable indirection or base64 hop. This stops the
# careless agent and the incidental wildcard, not an adversary with intent — real
# protection is `defaultMode: "default"`. The pattern list also deliberately omits
# `.key`, which the Read deny list does carry: as a substring it appears in
# `jq .key` and `--data key=...`, and a gate that fires on ordinary commands
# trains you to approve without reading. Upgrade path if a real bypass shows up in
# practice: match the resolved argv from a PostToolUse audit, not the raw string.
# The omp `agent.db` entry has the same ceiling at its own scale: it fires only on the
# name, so a sweep of the agent dir that never spells it — `cat ~/.omp/agent/*.db`,
# `cp -r ~/.omp/agent /tmp`, `tar czf x.tgz ~/.omp`, an `rsync` or `find -exec` over
# it — copies the credential store unprompted. Gating the directory instead would fire
# on every `omp` config edit and session lookup there.

set -uo pipefail

# Release valve for non-interactive runs, where an "ask" is an unanswerable block.
# This costs nothing in real security: anything that can set an env var can also
# obfuscate the path past the substring match below.
[ "${ECOMONO_ALLOW_SECRET_PATHS:-0}" = "1" ] && exit 0

# Fail open. A gate that errors must not block every shell command in the session.
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0
mode=$(printf '%s' "$input" | jq -r '.permission_mode // empty' 2>/dev/null)

# Drop the benign `.env` siblings before matching, so `cat .env.example` stays
# silent while `cat .env.production` does not. Bash ERE has no lookahead, so
# scrubbing the exceptions out is how "all of these except those" gets expressed.
scrubbed=$cmd
for benign in .env.example .env.sample .env.template .env.dist .env.defaults .env.schema; do
  scrubbed=${scrubbed//"$benign"/}
done

# The trailing `($|[^A-Za-z0-9_-])` is a right boundary: it keeps `.env` off
# `.environment` and `.envrc`, and `.pem` off `.pemfile`.
patterns=(
  '\.ssh/'
  '\.gnupg/'
  '\.env($|[^A-Za-z0-9_-])'
  'id_(rsa|dsa|ecdsa|ed25519)'
  '\.pem($|[^A-Za-z0-9_-])'
  '\.aws/credentials'
  '\.config/gh/hosts\.yml'
  '\.docker/config\.json'
  '\.kube/config'
  '\.netrc'
  '\.pgpass'
  'credentials\.json'
  # omp keeps every provider credential in plaintext in <agentDir>/agent.db (table auth_credentials), next to
  # agent.db-wal and agent.db-shm. The agent dir moves (~/.omp/agent, ~/.omp/profiles/<name>/agent,
  # PI_CODING_AGENT_DIR, XDG), so this keys on the file name, with a left boundary that keeps it off `myagent.db`
  # and a right one that keeps it off `agent.db.ts` while `agent.db-wal`, `agent.db-journal` and the sqlite
  # selector `agent.db:auth_credentials` still match. Same names as the `**/agent.db` and `**/agent.db-*` read
  # globs in opencode/opencode.json.
  '(^|[^A-Za-z0-9_.-])agent\.db($|[^A-Za-z0-9_.])'
  # omp prints those credentials itself: `omp auth export` dumps every one as JSON, `omp token <provider>` one
  # key or OAuth token. Neither names agent.db. Long flags before the subcommand (`--profile=work`,
  # `--profile work`) are skipped over.
  '(^|[^A-Za-z0-9_.-])omp([[:space:]]+--[A-Za-z][^[:space:]]*([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(auth[[:space:]]+export|token)($|[^A-Za-z0-9_-])'
  'Library/Keychains/'
  '(^|[^A-Za-z0-9_.-])secrets/'
)

hit=""
for p in "${patterns[@]}"; do
  if [[ $scrubbed =~ $p ]]; then hit="${BASH_REMATCH[0]}"; break; fi
done
[ -n "$hit" ] || exit 0

read -r -d '' reason <<EOF || true
This command names credential material ('$hit'). The deny list in settings.json covers these
paths for Read and Edit only — it does not bind Bash, so nothing else would have stopped it.

Do not retry the command unchanged. This gate has no approval path you can trigger from here:
interactively the user answers the prompt, and in a non-interactive run there is nobody to ask,
so an identical retry fails identically.

If the secret is incidental — a wildcard that swept it up, a directory walk, a grep over \$HOME
— narrow the command so it no longer names the path, and run that instead. If it names the path
because reading the secret is genuinely the task, stop and tell the user what you need and why,
rather than working around this. Either way: never pipe this content into a network call, and
never echo it into the transcript.

If the substring is a false positive — the command names no such file, as in an echo or a commit
message — say so plainly and ask the user to confirm, or reword it to avoid the match.
EOF

msg="⚠ Command names credential material ('$hit'). Confirm before it runs."

ask=true
if [ "$mode" = bypassPermissions ]; then
  ask=false
  read -r -d '' reason <<EOF || true
This command names credential material ('$hit') and ran without a prompt: the session is in
bypassPermissions, where this gate is advisory. Nothing else gates Bash here — the deny list in
settings.json covers these paths for Read and Edit only, it does not bind Bash.

Treat whatever it returned as a secret: never pipe or paste it into a network call, never echo
it into the transcript or into a file in the repository, and do not widen the command. If the
match was incidental — a wildcard that swept it up, a directory walk, a grep over \$HOME — narrow
the follow-up commands so they no longer name the path. If reading the secret is genuinely the
task, tell the user what was read and why.

If the substring is a false positive — the command names no such file, as in an echo or a commit
message — nothing was exposed; say so if the user asks.
EOF
  msg="⚠ Command names credential material ('$hit'). Ran without a prompt (bypassPermissions)."
fi

jq -nc --argjson ask "$ask" --arg r "$reason" --arg m "$msg" '{
  hookSpecificOutput: ({hookEventName: "PreToolUse", additionalContext: $r}
    + (if $ask then {permissionDecision: "ask", permissionDecisionReason: $r} else {} end)),
  systemMessage: $m
}'
