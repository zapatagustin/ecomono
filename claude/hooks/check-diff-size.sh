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

# Three signals: permission "ask" (default mode) + additionalContext + systemMessage
# (both honored regardless of permission mode, including bypassPermissions). None block.
jq -cn --arg r "$reason" --arg m "$msg" '{
  hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r, additionalContext: $r},
  systemMessage: $m
}'
