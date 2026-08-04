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
# The skill resolves <base> by judgment; a hook cannot. `git config ecomono.reviewBase`
# is the way to tell it, and without one it tries the usual suspects and accepts a receipt
# matching any of them. Two derivations of one hash that can disagree is the failure this
# repo has already shipped once — a wrong base yields a hash no receipt was written under
# and simply does not match. The config exists because the reverse is not symmetric: a
# stale local `master` in a repo whose real base is `develop` resolves, produces a hash
# nobody signed, and denies a delivery that has a perfectly good receipt.
#
# OFF BY DEFAULT, and structurally so: with no `ecomono/review-mode` marker in the git
# common directory the gate exits before it computes a hash, reads a receipt, or resolves an
# alias. Stating the cost exactly, because a previous version of this comment understated it
# and two judges measured the difference: a command with no `git` or `gh` token spawns only
# `jq`; one that has a git-shaped token but no delivery reaches two `git rev-parse` calls; and
# the `git config` alias lookups happen only past the marker, in an armed repository. That is
# deliberate — this
# hook installs globally, and a review gate armed in every repo the user owns is a gate
# that gets disabled permanently within a day. Arm one repo with:
#   d="$(git rev-parse --git-common-dir)/ecomono" && mkdir -p "$d" && touch "$d/review-mode"
# and disarm it with `rm` on that file. Deleting the marker is upstream RDD's
# `review mode disable`: when it is off, there is nothing to bypass.
#
# Registered with a bare `Bash` matcher and NO `if:` clause, unlike check-diff-size.sh.
# Measured against a live `claude -p --settings`: an `if: "Bash(git push*)"` clause splits
# the command on shell control operators and matches each simple command's own program, so
# `bash -c "git push"` never reaches the hook at all, and neither does `git  push` with two
# spaces. A filter that silently drops the deliveries the gate exists for is worse than the
# per-call cost of running on every Bash call, which is what secret-access-gate.sh already
# does. The whitespace normalisation below covers the second case.
#
# `permissionDecision: "deny"` is honored under `defaultMode: bypassPermissions` — measured
# the same way, against a live armed repo, where the push was genuinely blocked. Recorded
# because the sibling hooks return "ask" and only that value had been probed before.
#
# ecomono: THE DELIVERY DETECTOR HAS AN OPEN CEILING, and the list below is not a list of bugs
# to close — it is the shape of the problem. A hook sees `.tool_input.command` as a string and
# never an argv, so every version of this check has been a scanner reasoning about text about a
# command, and five rounds of judges found five different ways for text to be a delivery
# without looking like one: a contiguous-substring match missed `git -C path push`; token
# matching missed quotes, then aliases. Known and NOT caught today:
#
#   - `$(echo git push)` — the shell executes the substitution's output as the command line
#   - `gi\t push` — a backslash bash strips before the word is a word
#   - `git${IFS}push` — any parameter expansion that only becomes a separator at run time
#   - `gh` aliases (`gh alias set prc 'pr create'`), which would need spawning `gh` to read
#   - any wrapper: `make deploy`, `npm run release`, a script that shells out to git
#
# The common shape of the first three is that the hook reads `.tool_input.command` BEFORE the
# shell expands it, so anything that only becomes a delivery during expansion is invisible by
# construction. That is the boundary, not a list of oversights — and it is why the list is
# open: it grew by one on each of rounds 4, 5 and 6.
#
# Each is closeable in isolation and the next round would find the next one. What is caught is
# the case this gate exists for: a delivery written plainly, forgotten rather than hidden.
#
# It cuts the other way too. Commands that merely CONTAIN the words as data are refused — a
# commit message, a test fixture, a `jq` payload, a heredoc in a document about this gate — and
# a judge tripped exactly that on `check-diff-size.sh` while reviewing this file, so the
# false-positive rate is measured rather than imagined. Erring toward refusing costs one
# override; erring the other way is a gate that misses the case it exists for.
#
# Upgrade path, and the only one that changes the ceiling rather than moving it: match the
# resolved argv from a PostToolUse audit, or enforce in CI, where the party being gated does
# not control the environment. Adding a sixth pattern here does not.
#
# ecomono: this fails OPEN on a missing `jq`, a missing `sha256sum`, an unparseable
# payload, or a `git diff` that cannot be computed (a shallow clone whose merge-base
# objects are absent will hash truncated output or nothing at all) — breaking with the
# "a gate that fails open is not a gate" rule on purpose. A review gate that fails closed
# on a malformed hook payload leaves the operator unable to push anything, including the
# fix for the hook. It costs nothing in real enforcement either: anything that can empty
# `PATH` can also set ECOMONO_ALLOW_UNREVIEWED_PUSH=1. The one case that used to fail open
# silently and no longer does is an armed repo with no resolvable base — that is not an
# environment failure, it is the gate unable to do the job it was armed for, so it asks.
# Upgrade path if this ever matters: enforce in CI or branch protection, where the party
# being gated does not control the environment.

set -uo pipefail

# Release valve, same shape as secret-access-gate.sh's.
[ "${ECOMONO_ALLOW_UNREVIEWED_PUSH:-0}" = "1" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

cmd=$(cat | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# The same valve as an inline prefix on the command, which is how a user overrides one push
# without exporting anything into the session. Three things have to hold, and each one is a
# defect found by a judge rather than a precaution:
#
#   - It must be a LEADING assignment. As an unanchored substring, the legal branch name
#     `git push origin HEAD:refs/heads/x-ECOMONO_ALLOW_UNREVIEWED_PUSH=1` disarmed the gate.
#   - Leading whitespace is stripped first, so the ` cmd` habit that keeps a line out of
#     shell history still overrides. Requiring one exact ASCII space refused it.
#
# What it deliberately does NOT do is enforce that the override applies to one command. Three
# rounds of judges tried: refusing `&&`, then `;` `|` and newlines, then `$(...)` and
# backticks. Each fix closed one shape and the next round found another, because "is this one
# command" is a question about shell grammar and the check is a substring scan. The last
# version refused `gh pr create --body "$(cat <<'EOF' ... EOF)"` — the exact idiom this repo's
# own instructions call canonical — while still admitting shapes nobody had thought of.
#
# So the override authorises the whole command line, and that is the honest contract. Say what
# it costs, because an earlier version of this comment got it wrong: it authorises EVERY
# delivery chained into the same tool call, not one. `ECOMONO_ALLOW_UNREVIEWED_PUSH=1 git push
# origin fix && git push origin master --force` is one override and two pushes. The claim that
# this gives up nothing rested on "whoever types the prefix typed the rest of the line", and
# that is false here — the Bash tool call is composed by the agent, and the hook cannot tell an
# operator's line from one the agent extended. Two judges found that independently.
#
# It is still the right trade, for a reason that does not depend on who typed what: this gates
# forgetting, not intent. An agent set on bypassing writes the bare prefix, one token shorter
# than any chain. What a narrower override buys is not safety, it is the appearance of it, at
# the price of refusing ordinary commands. The check that survives is the one that answers a
# question about text: does the line BEGIN with the assignment. That is what keeps a ref name
# carrying the string from disarming the gate, which is a real accident rather than a threat.
#
# The match is textual, not shell-aware. `ECOMONO_ALLOW_UNREVIEWED_PUSH='1' git push` and
# `FOO=1 ECOMONO_ALLOW_UNREVIEWED_PUSH=1 git push` are legal shell that this does not
# recognise as an override, so they are refused. That direction is safe — a refusal costs one
# retry in the documented spelling.

# Backslash-newline continuations are joined once, here, and both the override check and
# the delivery match below read the result. Doing it only for the delivery match left the
# override stricter than the detector on the same syntax.
joined=${cmd//$'\\'$'\n'/ }

stripped=${joined#"${joined%%[![:space:]]*}"}
case "$stripped" in
  ECOMONO_ALLOW_UNREVIEWED_PUSH=1[[:space:]]*) exit 0 ;;
esac

# Normalise whitespace to plain spaces. `read -ra` below already collapses runs of space, tab
# and newline on its own, so this is NOT what makes `git  push` tokenise correctly — an
# earlier comment claimed it was, and two judges disproved the claim by mutation. What it does
# carry is the whitespace bash does not split on: a carriage return, vertical tab or form feed
# between the two words leaves `git<CR>push` as a single token to `read`, and a single token
# matches nothing. Measured both ways; the CR case is pinned in the test.
norm=$(printf '%s' "$joined" | tr -s '[:space:]' ' ')
# Drop quote characters before tokenising. They are shell syntax, not part of a word, and
# leaving them in makes `bash -c "git push"` tokenise as `"git` — a delivery the substring
# match used to catch and the token scan would otherwise lose.
norm=${norm//\"/}
norm=${norm//\'/}
# Give shell control characters their own token, the way the real shell splits them. `read -ra`
# splits on whitespace only, and the subcommand is compared for equality, so `git push;` and
# `git push|tee log` tokenise as `push;` and `push|tee` — neither equals `push`. That was a
# regression against the substring match this scan replaced: it caught them, and one-liners
# glue `;` and `|` to the preceding word constantly.
norm=$(printf '%s' "$norm" | sed 's/[;&|()<>]/ & /g')

# Find a delivery by TOKEN, not by substring. `git push` as contiguous text misses
# `git -C path push`, `git -c user.email=x push`, `git --no-pager push` and
# `gh -R owner/repo pr create` — every one of them an ordinary invocation, and the first two
# are the shape this hook's own test fixtures use to drive git. A substring check let all of
# them through silently, which is the worst outcome available: no deny, no ask, no record.
#
# `read -ra` splits on the collapsed whitespace without globbing or backslash processing.
# This pass spawns nothing. Subcommands it cannot resolve from text alone are collected as
# `pending` and looked up later, AFTER the marker check — a lookup here would fire on every
# `git status`, `git log` and `git add` in every repository the hook is installed in, armed or
# not. Two judges measured that regression on the version that did.
read -ra tok <<< "$norm"
delivery=""
pending=""
i=0
while [ "$i" -lt "${#tok[@]}" ]; do
  case "${tok[$i]}" in
    git|*/git) prog=git ;;
    gh|*/gh)   prog=gh ;;
    *) i=$((i + 1)); continue ;;
  esac
  # Skip global flags to reach the subcommand. The first group takes a separate value
  # argument; anything else starting with `-` is self-contained (`--git-dir=x`, `--bare`).
  j=$((i + 1))
  while [ "$j" -lt "${#tok[@]}" ]; do
    case "${tok[$j]}" in
      -c|-C|--git-dir|--work-tree|--namespace|--exec-path|-R|--repo) j=$((j + 2)) ;;
      -*) j=$((j + 1)) ;;
      *) break ;;
    esac
  done
  sub=${tok[$j]:-}
  if [ "$prog" = git ]; then
    [ "$sub" = push ] && { delivery=1; break; }
    # The flag-skip loop only stops on a token that does not start with `-`, so `sub` is
    # either empty or a subcommand name — a candidate alias.
    [ -n "$sub" ] && pending="$pending $sub"
  fi
  if [ "$prog" = gh ] && [ "$sub" = pr ] && [ "${tok[$((j + 1))]:-}" = create ]; then
    delivery=1; break
  fi
  # Resume past the flags already consumed, not at i+1: re-scanning them treats a flag VALUE
  # that happens to read `git` (`git -C git status`) as a second invocation.
  i=$((j + 1))
done
[ -n "$delivery" ] || [ -n "$pending" ] || exit 0

# The printed value, not the exit status: in a bare repository this command prints `false`
# and still exits 0, so the usual `>/dev/null || exit 0` idiom does not exclude one.
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit 0

gitdir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -n "$gitdir" ] || exit 0
# --git-common-dir answers relative to the cwd (".git", "../.git"), which resolves fine
# but reads badly in a refusal the user has to act on. Absolutise it.
gitdir=$(cd "$gitdir" 2>/dev/null && pwd) || exit 0
marker="$gitdir/ecomono/review-mode"
[ -f "$marker" ] || exit 0          # review mode off -> nothing to bypass

# An alias collapses the subcommand into one token the scan cannot recognise, and
# `git config alias.p push` is an everyday habit rather than an evasion. Resolved only now,
# so an unarmed repository pays nothing for it. git expands alias chains recursively, so this
# follows them, bounded — `alias.aa = bb` with `alias.bb = push` really does run push. The
# value is whitespace-normalised for the same reason the command line is: a tab between `push`
# and its arguments would otherwise slip past the space-padded match. A value that merely
# mentions push as an argument (`log --grep=push`) does not match; one that runs it
# (`push --force`, `!git push`) does.
if [ -z "$delivery" ]; then
  # `read -ra` rather than an unquoted `for sub in $pending`: the unquoted form also globs
  # against the cwd, which made the verdict depend on what files happened to sit in the
  # directory. Phase one is glob-free for the same reason.
  read -ra pend <<< "$pending"
  for sub in "${pend[@]}"; do
    seen_alias=""
    # The cycle guard is what terminates; the hop count is only a backstop against a chain
    # long enough to be pathological. It was 10, which is BELOW what git itself follows — a
    # 12-link chain resolved to push in git and was allowed here, one hop short.
    hop=0
    while [ "$hop" -lt 64 ]; do
      case " $seen_alias " in *" $sub "*) break ;; esac
      seen_alias="$seen_alias $sub"
      val=$(git config --get "alias.$sub" 2>/dev/null) || break
      [ -n "$val" ] || break
      val=$(printf '%s' "$val" | tr -s '[:space:]' ' ')
      read -ra av <<< "$val"
      first=${av[0]:-}
      [ -n "$first" ] || break
      # `push` has to be the VERB, not any word in the value. `log --oneline -- push` reads a
      # path named push and delivers nothing; matching it anywhere refused ordinary read-only
      # aliases. A `!`-prefixed value is a shell command, so there the whole text counts.
      [ "$first" = push ] && { delivery=1; break; }
      case "$first" in
        !*) case " $val " in *" push "*) delivery=1; break ;; esac ;;
      esac
      sub=$first          # not a push itself: it may name another alias
      hop=$((hop + 1))
    done
    [ -n "$delivery" ] && break
  done
fi
[ -n "$delivery" ] || exit 0

receipts="$gitdir/ecomono/receipts"

command -v sha256sum >/dev/null 2>&1 || exit 0

# sha256 of an empty diff, i.e. of the empty string. A receipt can never legitimately
# exist under it (the skill refuses to freeze an empty diff for exactly this reason), and
# a base that produces it has no bytes to review, so it is skipped rather than denied.
EMPTY_DIFF_HASH=e3b0c44298fc

configured=$(git config --get ecomono.reviewBase 2>/dev/null)
if [ -n "$configured" ]; then
  bases=("$configured")
else
  bases=('@{upstream}' origin/HEAD origin/master origin/main master main)
fi

approved=""
escalated=""
candidates=""
seen_mb=""
resolved=""
diff_failed=""

# The diff goes to a file rather than through a pipe so its exit status is readable. Piped
# into `sha256sum`, a `git diff` that fails — a partial clone whose promisor remote cannot
# serve a blob, a missing object — writes nothing, and hashing nothing produces exactly
# EMPTY_DIFF_HASH. That collapsed "the gate could not compute the subject" into "there is
# nothing under review", and the second one exits allowing the push. Command substitution is
# not an option here either: `$(...)` strips trailing newlines and every diff ends with one,
# so the hash would stop matching the skill's.
difftmp=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$difftmp"' EXIT
for ref in "${bases[@]}"; do
  git rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || continue
  mb=$(git merge-base HEAD "$ref" 2>/dev/null) || continue
  [ -n "$mb" ] || continue
  resolved=1
  # Dedupe on the merge-base commit, before the diff: several of these refs usually
  # resolve to the same commit, and hashing the whole diff once per ref is the cost the
  # header claims this loop does not have.
  case " $seen_mb " in *" $mb "*) continue ;; esac
  seen_mb="$seen_mb $mb"
  if ! git diff "$mb" > "$difftmp" 2>/dev/null; then diff_failed=1; continue; fi
  h=$(sha256sum < "$difftmp" | cut -c1-12)
  [ "$h" = "$EMPTY_DIFF_HASH" ] && continue
  candidates="$candidates $h"
  [ -f "$receipts/$h" ] || continue
  verdict=$(head -n1 "$receipts/$h" | tr -d '[:space:]')
  if [ "$verdict" = "APPROVED" ]; then approved=$h; break; else escalated="$escalated $h ($verdict)"; fi
done

[ -n "$approved" ] && exit 0

if [ -z "$candidates" ]; then
  # A diff that could not be computed is not an empty diff, and must never reach the exit
  # below. Checked first for that reason: a repo can have one base whose diff failed and
  # another whose diff was genuinely empty.
  if [ -n "$diff_failed" ]; then
    read -r -d '' reason <<EOF || true
Review mode is armed for this repository ($marker exists), but \`git diff\` failed against
every base it could resolve, so this gate cannot compute the subject hash.

That is not an empty diff and it is not a passing review — it is the gate unable to run. The
usual cause is a partial or shallow clone that cannot serve an object the diff needs.

Fetch what is missing (\`git fetch --refetch\` on a partial clone, \`git fetch --unshallow\` on
a shallow one) and run the command again. Do not retry it unchanged first; it will land here
again.
EOF
    jq -nc --arg r "$reason" --arg m "⚠ Review gate could not compute the subject hash: git diff failed." '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $r,
        additionalContext: $r
      },
      systemMessage: $m
    }'
    exit 0
  fi

  # A base resolved and every diff against it was empty: standing on the base branch with
  # a clean tree. There are no bytes under review, so there is nothing to demand a receipt
  # for. Distinct from the cases above and below, and that is the whole point of tracking
  # `resolved` and `diff_failed` separately from `candidates`.
  [ -n "$resolved" ] && exit 0

  # Armed, but nothing to compare against. Two ways to get here, and the message has to say
  # which: a configured base that does not resolve, or no configured base and none of the
  # usual refs resolving — the normal shape of a repo on `develop` with no upstream set yet.
  # Allowing silently is indistinguishable from a passing review, which is the failure this
  # gate exists to prevent, so it surfaces instead. "ask" rather than "deny" because the gate
  # has no evidence about the bytes either way.
  #
  # A configured base that does not resolve does NOT fall back to the candidate list. Falling
  # back would answer a typo by guessing, which is the exact failure the config exists to
  # prevent — a base that resolves but is wrong denies a delivery whose review passed.
  if [ -n "$configured" ]; then
    why="\`ecomono.reviewBase\` is set to \`$configured\`, which does not resolve in this
repository. The candidate list was not tried: naming a base is a claim about which one is
right, and falling back to guessing would defeat the reason the setting exists."
    fixline="Correct it with \`git config ecomono.reviewBase <branch>\`, or drop it with
\`git config --unset ecomono.reviewBase\` to go back to the candidate list."
  else
    why="No \`ecomono.reviewBase\` is configured, and none of @{upstream}, origin/HEAD,
origin/master, origin/main, master or main resolve here."
    fixline="Name the base branch this change is measured against:
\`git config ecomono.reviewBase <branch>\`, then run \`/ecomono-judgment\` if no review has
happened yet."
  fi
  read -r -d '' reason <<EOF || true
Review mode is armed for this repository ($marker exists), but this gate cannot tell which
bytes are being delivered.

$why

Without a base branch there is no subject hash, so there is no receipt to look for. This is
not a passing review — it is the gate unable to run.

$fixline Do not retry the command unchanged first; it will land here again.
EOF
  jq -nc --arg r "$reason" --arg m "⚠ Review mode is armed but no base branch resolves. Set git config ecomono.reviewBase." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $r,
      additionalContext: $r
    },
    systemMessage: $m
  }'
  exit 0
fi

# Every candidate is listed either way. Reporting only the escalated one would hide the very
# hashes the operator needs to tell which base was used, which is what `ecomono.reviewBase`
# exists to let them correct.
detail="Subject hashes tried, none of which has an APPROVED receipt in $receipts:$candidates
Each is \`git diff \$(git merge-base HEAD <base>) | sha256sum | cut -c1-12\` for one
candidate base — the same formula ecomono-judgment freezes with. If the base this change is
really measured against is not among them, name it with
\`git config ecomono.reviewBase <branch>\` and the gate will use that one alone."

if [ -n "$escalated" ]; then
  headline="the review of these bytes ended in a non-approving verdict"
  detail="Receipts found, none of them APPROVED:$escalated
An escalated verdict is a decision the review deliberately handed to a human; it is not an
approval, and delivering on it is the thing this gate exists to stop.

$detail"
else
  headline="no review receipt exists for the bytes being delivered"
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
\`ECOMONO_ALLOW_UNREVIEWED_PUSH=1 <command>\` (as a leading prefix, which is the only shape
this gate accepts), or disarm review mode entirely with \`rm $marker\`.
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
