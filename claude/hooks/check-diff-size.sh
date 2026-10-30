#!/usr/bin/env bash
# PreToolUse reminder: on `git push` / `gh pr create`, if the branch diff vs the
# default-branch merge-base exceeds THRESHOLD changed lines, remind (do NOT block)
# to run the review-4R agents first. Soft nudge by design — see notes below.
#
# ecomono: deliberately a reminder, not a wall. A client-side hook can be bypassed
# in one line, and the party it gates writes its own approval — real enforcement
# belongs in CI / branch protection. This catches the common case: forgetting.
set -euo pipefail

THRESHOLD=400

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
mode=$(printf '%s' "$input" | jq -r '.permission_mode // ""')

case "$cmd" in
  *"git push"*|*"gh pr create"*) ;;
  *) exit 0 ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

base=""
for ref in '@{upstream}' origin/main origin/master main master; do
  if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then base="$ref"; break; fi
done
[ -z "$base" ] && exit 0   # no base to compare against -> allow

lines=$(git diff --numstat "${base}...HEAD" 2>/dev/null | awk '{a+=$1; d+=$2} END{print a+d+0}')
lines=${lines:-0}

[ "$lines" -le "$THRESHOLD" ] && exit 0

reason="Branch diff is ${lines} changed lines (> ${THRESHOLD}). Before pushing/opening the PR, run the review-4R agents in parallel: ecomono-r1-risk, ecomono-r3-reliability, ecomono-r4-resilience, ecomono-r2-readability."
msg="⚠ Large diff (${lines} lines > ${THRESHOLD}). Review-4R recommended before push/PR."

# Three signals: permission "ask" + additionalContext + systemMessage. None block.
#
# The "ask" is honored under bypassPermissions too — measured with `claude -p --settings`
# against secret-access-gate.sh, which returns the same decision, where the gated command
# never ran. In a non-interactive run there is nobody to answer it, so it lands as a block;
# harmless here, since this gate fires only on `git push` / `gh pr create` and a headless
# run of either should stop and let a human look at a 400-line diff anyway.
#
# Under bypassPermissions the "ask" is dropped and the gate is advisory: that mode is the
# user's choice of a session with no prompts, and a hook that reinstates one on every large
# push is the thing they turned off. The reason still reaches the model as additionalContext
# and the banner still shows; the command runs, so the text says so instead of "before
# pushing". Payloads without `permission_mode` (older Claude Code, the omp runner) read as
# "not bypass" and keep the prompt.
ask=true
if [ "$mode" = bypassPermissions ]; then
  ask=false
  reason="Branch diff is ${lines} changed lines (> ${THRESHOLD}) and the command ran without a prompt (bypassPermissions, where this gate is advisory). Run the review-4R agents now, in parallel — ecomono-r1-risk, ecomono-r3-reliability, ecomono-r4-resilience, ecomono-r2-readability — and deliver their findings as a follow-up."
  msg="⚠ Large diff (${lines} lines > ${THRESHOLD}) ran without a prompt (bypassPermissions). Review-4R recommended."
fi
jq -cn --argjson ask "$ask" --arg r "$reason" --arg m "$msg" '{
  hookSpecificOutput: ({hookEventName: "PreToolUse", additionalContext: $r}
    + (if $ask then {permissionDecision: "ask", permissionDecisionReason: $r} else {} end)),
  systemMessage: $m
}'
