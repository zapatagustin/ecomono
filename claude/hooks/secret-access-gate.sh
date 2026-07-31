#!/usr/bin/env bash
# PreToolUse gate on the Bash tool: when a shell command names credential
# material, downgrade it to a confirmation prompt instead of letting
# bypassPermissions auto-approve it.
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
# ecomono: substring matching on the command line. `cat $HOME/.ss''h/id_rsa`
# defeats it, and so does any variable indirection or base64 hop. This stops the
# careless agent and the incidental wildcard, not an adversary with intent — real
# protection is `defaultMode: "default"`. The pattern list also deliberately omits
# `.key`, which the Read deny list does carry: as a substring it appears in
# `jq .key` and `--data key=...`, and a gate that fires on ordinary commands
# trains you to approve without reading. Upgrade path if a real bypass shows up in
# practice: match the resolved argv from a PostToolUse audit, not the raw string.

set -uo pipefail

# Release valve for non-interactive runs, where an "ask" is an unanswerable block.
# This costs nothing in real security: anything that can set an env var can also
# obfuscate the path past the substring match below.
[ "${ECOMONO_ALLOW_SECRET_PATHS:-0}" = "1" ] && exit 0

# Fail open. A gate that errors must not block every shell command in the session.
command -v jq >/dev/null 2>&1 || exit 0

cmd=$(cat | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

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

jq -nc --arg r "$reason" --arg m "$msg" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: $r,
    additionalContext: $r
  },
  systemMessage: $m
}'
