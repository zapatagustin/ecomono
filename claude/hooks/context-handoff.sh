#!/usr/bin/env bash
# UserPromptSubmit hook: tell the user, and the model, that a new session is advisable once the
# context passes a threshold — once per 50k-token step, never on every prompt.
#
# Why: turns above 200k context hold about 65% of main-thread cost, and the user prefers a clean
# session over compaction. This hook only advises; it never blocks, rewrites or delays a prompt,
# and every error path exits 0 silently.
#
# Context size = last assistant line with `message.usage` in the transcript:
# input_tokens + cache_read_input_tokens + cache_creation_input_tokens (the same sum the status
# line reports). Only the tail of the transcript is read.
#
# ecomono: the tail is a fixed 1 MB; a single assistant line larger than that (huge inline tool
# output) reads as "no usage" and stays silent. Upgrade path: read the tail by line count.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat)
read -r sid tp agent < <(printf '%s' "$payload" \
  | jq -r '[(.session_id // ""), (.transcript_path // ""), (.agent_id // "")] | @tsv' 2>/dev/null) || exit 0
# A subagent's context dies on return; only the main thread is worth a handoff.
[ -n "$agent" ] && exit 0
sid=${sid//[^A-Za-z0-9_-]/}
[ -n "$sid" ] && [ -r "$tp" ] || exit 0

limit=${ECOMONO_HANDOFF_TOKENS:-200000}
case "$limit" in ''|*[!0-9]*) limit=200000 ;; esac
step=50000

tokens=$(tail -c 1000000 "$tp" 2>/dev/null | jq -R -r '
  fromjson? | select(.type == "assistant" and .message.usage != null) | .message.usage
  | (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)' 2>/dev/null | tail -n 1)
case "$tokens" in ''|*[!0-9]*) exit 0 ;; esac
[ "$tokens" -ge "$limit" ] || exit 0

n=$(((tokens - limit) / step))
dir="${XDG_STATE_HOME:-$HOME/.local/state}/ecomono/handoff"
last=$(cat "$dir/$sid" 2>/dev/null) || last=""
case "$last" in ''|*[!0-9]*) last=-1 ;; esac
[ "$n" -gt "$last" ] || exit 0
mkdir -p "$dir" 2>/dev/null && printf '%s' "$n" > "$dir/$sid" 2>/dev/null || exit 0

jq -n --arg t "$tokens" --arg s "$sid" --arg p "$tp" '{
  systemMessage: ("Context is at \($t) tokens. A new session is advisable: run /handoff, then continue there. Resume this one with: claude --resume \($s)"),
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: ("The session context is \($t) tokens, past the handoff threshold. The user prefers a new session over compaction: do not compact to keep going. Steps: (1) tell the user in one line now that a new session is advisable; (2) at the next natural stop, save the session summary (goal, discoveries, done, next steps, files) including session id \($s) and transcript path \($p); (3) give the user the opener for the new session and `claude --resume \($s)` for coming back. Read the previous transcript only through ecomono-explore.")
  }
}'
exit 0
