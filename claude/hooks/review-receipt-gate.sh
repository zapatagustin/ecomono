#!/usr/bin/env bash
# PreToolUse gate on the Bash tool: refuse `git push` / `gh pr create` unless a review
# receipt exists for the exact bytes being delivered.
#
# The receipt is written by the `ecomono-judgment` skill at its terminal verdict, twice:
# a memory observation under `review/{subject-hash}`, and a file named by that same hash
# under the repo's git common directory. This gate reads the file, because a hook is
# shell and the memory store is reachable only from inside an agent session.
#
# The hash formula is `ecomono-judgment`'s, unchanged:
#   git diff "$(git merge-base HEAD <base>)" | sha256sum | cut -c1-12
# The skill resolves <base> by judgment; a hook cannot. So this tries every plausible
# base and accepts a receipt matching any of them. Two derivations of one hash that can
# disagree is the failure this repo has already shipped once — trying several bases costs
# nothing and removes the class, since a wrong base yields a hash no receipt was ever
# written under and simply does not match.
#
# OFF BY DEFAULT, and structurally so: with no `ecomono/review-mode` marker in the git
# common directory the gate exits before it looks at anything. That is deliberate — this
# hook installs globally, and a review gate armed in every repo the user owns is a gate
# that gets disabled permanently within a day. Arm one repo with:
#   d="$(git rev-parse --git-common-dir)/ecomono" && mkdir -p "$d" && touch "$d/review-mode"
# and disarm it with `rm` on that file. Deleting the marker is upstream RDD's
# `review mode disable`: when it is off, there is nothing to bypass.
#
# ecomono: the delivery match is a substring on the command line, the same shape
# check-diff-size.sh uses, so `git commit -m "note about git push"` is refused and
# `git   push` is not. Erring toward refusing costs one override; erring the other way is
# a gate that misses the case it exists for. Upgrade path: match the parsed argv from a
# PostToolUse audit rather than the raw string.
#
# ecomono: this fails OPEN on a missing `jq`, a missing `sha256sum`, an unparseable
# payload, or no resolvable base branch — breaking with the "a gate that fails open is
# not a gate" rule on purpose. A review gate that fails closed on a malformed hook
# payload leaves the operator unable to push anything, including the fix for the hook.
# It costs nothing in real enforcement either: anything that can empty `PATH` can also
# set ECOMONO_ALLOW_UNREVIEWED_PUSH=1. Upgrade path if this ever matters: enforce in CI
# or branch protection, where the party being gated does not control the environment.

set -uo pipefail

# Release valve, same shape as secret-access-gate.sh's. Also honored as an inline prefix
# on the command itself, because that is how a user overrides a single push without
# exporting anything into the session.
[ "${ECOMONO_ALLOW_UNREVIEWED_PUSH:-0}" = "1" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v sha256sum >/dev/null 2>&1 || exit 0

cmd=$(cat | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

case "$cmd" in
  *"ECOMONO_ALLOW_UNREVIEWED_PUSH=1"*) exit 0 ;;
esac

case "$cmd" in
  *"git push"*|*"gh pr create"*) ;;
  *) exit 0 ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

gitdir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -n "$gitdir" ] || exit 0
# --git-common-dir answers relative to the cwd (".git", "../.git"), which resolves fine
# but reads badly in a refusal the user has to act on. Absolutise it.
gitdir=$(cd "$gitdir" 2>/dev/null && pwd) || exit 0
marker="$gitdir/ecomono/review-mode"
[ -f "$marker" ] || exit 0          # review mode off -> nothing to bypass

receipts="$gitdir/ecomono/receipts"

# sha256 of an empty diff, i.e. of the empty string. A receipt can never legitimately
# exist under it (the skill refuses to freeze an empty diff for exactly this reason), and
# a base that produces it has no bytes to review, so it is skipped rather than denied.
EMPTY_DIFF_HASH=e3b0c44298fc

approved=""
escalated=""
candidates=""
for ref in '@{upstream}' origin/HEAD origin/master origin/main master main; do
  git rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || continue
  mb=$(git merge-base HEAD "$ref" 2>/dev/null) || continue
  [ -n "$mb" ] || continue
  h=$(git diff "$mb" | sha256sum | cut -c1-12)
  [ "$h" = "$EMPTY_DIFF_HASH" ] && continue
  case " $candidates " in *" $h "*) continue ;; esac
  candidates="$candidates $h"
  [ -f "$receipts/$h" ] || continue
  verdict=$(head -n1 "$receipts/$h" | tr -d '[:space:]')
  if [ "$verdict" = "APPROVED" ]; then approved=$h; break; else escalated="$h ($verdict)"; fi
done

[ -n "$approved" ] && exit 0
[ -n "$candidates" ] || exit 0       # no base to compare against -> nothing to gate

if [ -n "$escalated" ]; then
  headline="the review of these bytes ended ESCALATED, not APPROVED"
  detail="A receipt exists for $escalated. An escalated verdict is a decision the review
deliberately handed to a human; it is not an approval, and delivering on it is the thing
this gate exists to stop."
else
  headline="no review receipt exists for the bytes being delivered"
  detail="Subject hashes tried, none of which has a receipt in $receipts:$candidates
Each is \`git diff \$(git merge-base HEAD <base>) | sha256sum | cut -c1-12\` for one
plausible base branch — the same formula ecomono-judgment freezes with."
fi

read -r -d '' reason <<EOF || true
Refusing this delivery: $headline.

$detail

Review mode is armed for this repository ($marker exists), so the receipt is required
rather than advisory.

To resolve it, run the review: \`/ecomono-judgment <target>\`. Reaching APPROVED writes the
receipt this gate reads, and the same command becomes possible with no further change.

Do not retry the command unchanged, and do not set ECOMONO_ALLOW_UNREVIEWED_PUSH yourself —
the override belongs to the user, not to the agent being reviewed. If the delivery is
genuinely urgent or the gate is wrong, stop and say so: the user can re-run it as
\`ECOMONO_ALLOW_UNREVIEWED_PUSH=1 <command>\`, or disarm review mode entirely with
\`rm $marker\`.
EOF

msg="⛔ Push blocked — $headline. Run /ecomono-judgment, or ask the user to override."

jq -nc --arg r "$reason" --arg m "$msg" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r,
    additionalContext: $r
  },
  systemMessage: $m
}'
