#!/usr/bin/env bash
# Runnable check for context-handoff.sh and the context fields of statusline.sh. No framework:
# feeds real UserPromptSubmit payloads on stdin and asserts on stdout and exit status.
#
# Field names verified on claude-code 2.1.329: a capture hook on UserPromptSubmit saw
# session_id, transcript_path and no agent_id in the main thread; its `systemMessage` reached
# the stream output and its `hookSpecificOutput.additionalContext` reached the model.

set -uo pipefail
here="$(dirname "$0")"
hook="$here/context-handoff.sh"
sl="$here/statusline.sh"
fail=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export XDG_STATE_HOME="$tmp/state"
unset ECOMONO_HANDOFF_TOKENS

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1 — $2"; fail=1; }

# Statusline first: with no context fields the output must not change at all.
sl_in='{"model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1800000000}}}'
want=$(printf 'Opus \033[2m|\033[0m 5h \033[32m42%%\033[0m \033[2m→%s\033[0m' "$(date -d @1800000000 +%H:%M)")
got=$(printf '%s' "$sl_in" | bash "$sl" | tr -d '\n')
[ "$got" = "$want" ] && ok "statusline without context fields is unchanged" || bad "statusline unchanged" "got: $got"

sl_ctx=$(printf '%s' '{"model":{"display_name":"Opus"},"context_window":{"total_input_tokens":250000}}' | bash "$sl")
case "$sl_ctx" in *250k*) ok "statusline shows context tokens" ;; *) bad "statusline context" "got: $sl_ctx" ;; esac
sl_lo=$(printf '%s' '{"model":{"display_name":"Opus"},"context_window":{"total_input_tokens":120000}}' | bash "$sl")
case "$sl_lo" in *120k*) ok "statusline shows context below threshold" ;; *) bad "statusline low" "got: $sl_lo" ;; esac
case "$sl_lo" in *'!'*) bad "statusline marker" "marker below threshold" ;; *) ok "no marker below threshold" ;; esac
case "$sl_ctx" in *'!'*) ok "marker past threshold" ;; *) bad "statusline marker" "none at 250k" ;; esac

# transcript <file> <input> <cache_read> <cache_create>: a tail-heavy fake transcript.
transcript() {
  {
    echo '{"type":"user","message":{"content":"hi"}}'
    echo '{"type":"assistant","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1}}}'
    printf '{"type":"assistant","message":{"usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s}}}\n' "$2" "$3" "$4"
    echo '{"type":"user","message":{"content":"later"}}'
  } > "$1"
}

# run <session> <transcript> [extra top-level JSON, leading comma] -> hook stdout
run() { printf '{"session_id":"%s","transcript_path":"%s"%s}' "$1" "$2" "${3:-}" | "$hook"; }
silent() { # silent <label> <session> <transcript> [extra]
  local out rc; out=$(run "$2" "$3" "${4:-}"); rc=$?
  [ -z "$out" ] && [ $rc -eq 0 ] && ok "$1" || bad "$1" "rc=$rc out: ${out:0:100}"
}

transcript "$tmp/t190" 10 150000 40000   # 190000
transcript "$tmp/t200" 10 150000 49990   # 200000
transcript "$tmp/t250" 10 200000 49990   # 250000
transcript "$tmp/t260" 10 200000 59990   # 260000
transcript "$tmp/t300" 10 250000 49990   # 300000

silent "below threshold is silent" s1 "$tmp/t190"

out=$(run s2 "$tmp/t250")
msg=$(printf '%s' "$out" | jq -r '.systemMessage // empty' 2>/dev/null)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput | select(.hookEventName=="UserPromptSubmit") | .additionalContext // empty' 2>/dev/null)
[ -n "$msg" ] && ok "prints a line for the user (systemMessage)" || bad "systemMessage" "out: ${out:0:120}"
case "$ctx" in *250000*"--resume s2"*) ok "context for the model carries size and resume command" ;; *) bad "additionalContext" "got: ${ctx:0:160}" ;; esac
case "$ctx" in *compact*) ok "context states the new-session preference" ;; *) bad "additionalContext" "no mention of compaction" ;; esac

out=$(run s3 "$tmp/t200"); [ -n "$out" ] && ok "fires exactly at the threshold" || bad "threshold" "silent at 200000"

# once per 50k step
run s4 "$tmp/t250" >/dev/null
silent "same step does not notify again" s4 "$tmp/t250"
silent "later prompt in the same step stays silent" s4 "$tmp/t260"
out=$(run s4 "$tmp/t300"); [ -n "$out" ] && ok "next 50k step notifies again" || bad "next step" "silent at 300000"
silent "a different session is tracked on its own" s4b "$tmp/t190"

# threshold override
out=$(ECOMONO_HANDOFF_TOKENS=100000 run s5 "$tmp/t190"); [ -n "$out" ] && ok "ECOMONO_HANDOFF_TOKENS lowers the threshold" || bad "override" "silent at 190000 with 100000"

# subagent skip
silent "subagent call is skipped" s6 "$tmp/t250" ',"agent_id":"a1"'
out=$(run s7 "$tmp/t250" ',"agent_id":""'); [ -n "$out" ] && ok "empty agent_id is the main thread" || bad "agent_id empty" "silent"

# fail open: exit 0 and no output
silent "missing transcript fails open" s8 "$tmp/nope"
: > "$tmp/empty"; silent "empty transcript fails open" s9 "$tmp/empty"
printf 'not json\n{broken' > "$tmp/junk"; silent "garbage transcript fails open" s10 "$tmp/junk"
cp "$tmp/t250" "$tmp/unread"; chmod 000 "$tmp/unread"; silent "unreadable transcript fails open" s11 "$tmp/unread"
out=$(printf 'not json' | "$hook"); rc=$?; [ -z "$out" ] && [ $rc -eq 0 ] && ok "unparseable input fails open" || bad "unparseable" "rc=$rc"
out=$(printf '{"transcript_path":"%s"}' "$tmp/t250" | "$hook"); rc=$?; [ -z "$out" ] && [ $rc -eq 0 ] && ok "missing session_id fails open" || bad "no session_id" "rc=$rc"
sh_bin=$(command -v bash); empty=$(mktemp -d)
out=$(printf '{"session_id":"s12","transcript_path":"%s"}' "$tmp/t250" | PATH="$empty" "$sh_bin" "$hook"); rc=$?
rmdir "$empty"
[ -z "$out" ] && [ $rc -eq 0 ] && ok "missing jq fails open" || bad "missing jq" "rc=$rc out: ${out:0:80}"
[ ! -e "$HOME/.local/state/ecomono/handoff/s1" ] || bad "state" "wrote outside XDG_STATE_HOME"

exit $fail
