#!/usr/bin/env bash
# Runnable check for review-receipt-gate.sh. No framework: builds real git repos in temp
# dirs, writes real receipts, feeds real PreToolUse payloads on stdin.
#
# Git repos rather than stubs because every branch in the gate depends on git's own
# answers — merge-base resolution, the diff bytes, the common directory. A mocked `git`
# would test the mock.
#
# The negatives carry the weight here. A gate that blocks a push it should not blocks the
# fix for itself, so "off by default", "not a push", and the release valve are the cases
# most worth failing on. Several assertions below exist because an earlier version of this
# file passed them for the wrong reason — each of those is marked with what it would have
# to break for the check to fail.

set -uo pipefail
gate="$(cd "$(dirname "$0")" && pwd)/review-receipt-gate.sh"
fail=0

tmproot=$(mktemp -d)
trap 'rm -rf "$tmproot"' EXIT

git_c() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }

# ---------------------------------------------------------------- fixture 1: work/master
# A feature branch off master, which is the ordinary shape: on master itself
# `git merge-base HEAD master` is HEAD, the diff is empty, and there is nothing to review.
# That case is covered explicitly further down.
repo="$tmproot/repo"
mkdir -p "$repo"
git -C "$repo" init -q -b master .
git_c "$repo" commit -q --allow-empty -m base
git -C "$repo" checkout -q -b work
printf 'one\n' > "$repo/file.txt"
git -C "$repo" add file.txt
git_c "$repo" commit -q -m change

gitdir="$repo/.git"
receipts="$gitdir/ecomono/receipts"
marker="$gitdir/ecomono/review-mode"
mkdir -p "$receipts"

# The gate's formula, recomputed here independently so a change to either side shows up as
# a failing test rather than as a gate nobody can satisfy.
subject_hash() { # subject_hash [repo] [base]
  local r=${1:-$repo} b=${2:-master}
  git -C "$r" diff "$(git -C "$r" merge-base HEAD "$b")" | sha256sum | cut -c1-12
}

arm()    { : > "$marker"; }
disarm() { rm -f "$marker"; }
receipt() { printf '%s\n' "$1" "hash: $2" > "${3:-$receipts}/$2"; }   # receipt <verdict> <hash> [dir]
# Same file with the reviewed merge-base recorded, which is what lets the gate re-derive the
# hash after the base branch has moved. Written in the skill's own field order so a drift
# between the two shows up here.
receipt_based() {  # receipt_based <verdict> <hash> <base-sha> <dir>
  printf '%s\n' "$1" "hash: $2" "base: $3" "target: fixture" "rounds: 1" > "$4/$2"
}

# decision <command> [repo] -> "allow" when the gate stays silent, else "<decision>:<reason>"
decision() {
  local out
  out=$(cd "${2:-$repo}" && jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' | "$gate")
  [ -z "$out" ] && { echo allow; return; }
  printf '%s' "$out" \
    | jq -r '.hookSpecificOutput.permissionDecision + ":" + .hookSpecificOutput.permissionDecisionReason' \
    | tr '\n' ' '
}

check() { # check <label> <command> <extended-regex the decision must match> [repo]
  local got; got=$(decision "$2" "${4:-$repo}")
  if printf '%s' "$got" | grep -Eq "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1 — got: ${got:0:160}"
    fail=1
  fi
}

echo "-- off by default: no marker, no gate"
disarm
rm -f "$receipts"/*
check "push with no marker"        'git push'                    '^allow$'
check "gh pr create with no marker" 'gh pr create --fill'        '^allow$'

echo
echo "-- armed, and the receipt decides"
arm
h=$(subject_hash)
check "armed, no receipt at all"   'git push'                    '^deny:.*no review receipt'
check "refusal names the review"   'git push'                    '/ecomono-judgment'
check "refusal names the hash"     'git push'                    "$h"
check "refusal reserves the valve" 'git push'                    'do not set ECOMONO_ALLOW_UNREVIEWED_PUSH yourself'

receipt APPROVED "$h"
check "APPROVED receipt lets it through" 'git push'              '^allow$'
check "same for gh pr create"      'gh pr create --fill'         '^allow$'

receipt ESCALATED "$h"
check "ESCALATED is not approval"  'git push'                    '^deny:.*non-approving'

echo
echo "-- the delivery has to be recognised however it is spelled"
# Measured against a live `claude -p`: an `if: Bash(git push*)` clause in settings would
# never route `git  push` or `bash -c "git push"` here at all, which is why the hook is
# registered with a bare Bash matcher and normalises the command itself. Break the `tr -s`
# and the first of these fails.
rm -f "$receipts"/*
check "two spaces"                 'git  push'                   '^deny:'
# Flags between the program and the subcommand. A contiguous-substring match missed every one
# of these silently — and `git -C ... -c ...` is the shape this file's own git_c() helper uses.
check "git -C"                     'git -C /some/repo push'      '^deny:'
check "git -c with a value"        'git -c user.email=x push origin work' '^deny:'
check "git --no-pager"             'git --no-pager push'         '^deny:'
check "git --git-dir="             'git --git-dir=/r/.git push'  '^deny:'
check "gh -R"                      'gh -R owner/repo pr create --fill' '^deny:'
check "an absolute program path"   '/usr/bin/git push'           '^deny:'
# A shell metacharacter glued to the verb stays inside the token, and the subcommand is
# compared for equality — so these were allowed until the normaliser gave `;` `|` `&` `(` `)`
# their own token. The substring match this scan replaced caught them; the scan regressed on
# them, and one-liners produce this shape constantly.
check "semicolon glued to push"    'git push;'                   '^deny:'
check "push then another command"  'git push; echo done'         '^deny:'
check "piped into tee"             'git push|tee push.log'       '^deny:'
check "backgrounded"               'git push&'                   '^deny:'
check "inside a subshell"          '(cd repo && git push)'       '^deny:'
check "gh with a semicolon"        'gh pr create;'               '^deny:'
# A carriage return is whitespace that bash does NOT split on, so `read -ra` alone leaves
# `git<CR>push` as one token and one token matches nothing. This is what the tr -s normalisation
# actually buys — not the two-space case above, which read collapses on its own.
check "carriage return between the words" "$(printf 'git\rpush')" '^deny:'
# An alias collapses the subcommand into a token the scan cannot know. Configured below.
git -C "$repo" config alias.p push
git -C "$repo" config alias.pf 'push --force-with-lease'
git -C "$repo" config alias.shellpush '!git push'
git -C "$repo" config alias.grepper 'log --grep=push'
git -C "$repo" config alias.tabbed "$(printf 'push\t--force-with-lease')"
git -C "$repo" config alias.aa bb
git -C "$repo" config alias.bb push
git -C "$repo" config alias.loopa loopb
git -C "$repo" config alias.loopb loopa
check "an aliased push"            'git p'                       '^deny:'
check "an alias with arguments"    'git pf origin work'          '^deny:'
check "a shell alias that pushes"  'git shellpush'               '^deny:'
check "an alias separated by a tab" 'git tabbed'                 '^deny:'
# git expands alias chains recursively, so a single lookup is not enough: `aa` -> `bb` -> push
# really does push.
check "a chained alias"            'git aa'                      '^deny:'
check "an alias that only mentions push" 'git grepper'           '^allow$'
git -C "$repo" config alias.pathpush 'log --oneline -- push'
check "push as an argument is not a push" 'git pathpush'         '^allow$'
# A chain longer than the old bound. git follows these; stopping short of the end allowed a
# real push.
prev=push
for n in 11 10 9 8 7 6 5 4 3 2 1 0; do git -C "$repo" config "alias.a$n" "$prev"; prev="a$n"; done
check "a twelve-link alias chain"  'git a0'                      '^deny:'
# Two invocations in one line, only the second aliased.
check "an aliased push after another command" 'git status && git p' '^deny:'
# ...and the token match must not fire on words that merely look like one.
check "git pushing is not a push"  'git commit -m "note about git pushing"' '^allow$'
check "a push subcommand elsewhere" 'echo push | git hash-object --stdin' '^allow$'
check "continuation after the verb" 'git push \
  origin work'                                                   '^deny:'
check "wrapped in bash -c"         'bash -c "git push"'          '^deny:'
check "chained after another"      'true && git push origin work' '^deny:'
check "continuation between the words" 'git \
push'                                                            '^deny:'

echo
echo "-- a receipt is bound to bytes, not to a branch"
h=$(subject_hash)
receipt APPROVED "$h"
printf 'two\n' >> "$repo/file.txt"
check "bytes moved after the receipt" 'git push'                 '^deny:.*no review receipt'
h2=$(subject_hash)
[ "$h" != "$h2" ] && echo "ok   the hash actually moved" \
  || { echo "FAIL fixture did not change the subject hash"; fail=1; }
# Committing the same bytes must NOT invalidate the receipt: the formula diffs the
# merge-base against the working tree, so staged and committed work land on one hash.
receipt APPROVED "$h2"
git -C "$repo" add file.txt
git_c "$repo" commit -q -m more
check "committing the reviewed bytes keeps the receipt valid" 'git push' '^allow$'

echo
echo "-- the empty-diff hash is not a skeleton key"
# sha256 of the empty string is a public constant, so a receipt under it would pass in any
# repo on any tree. The gate must skip that hash even when a resolvable ref produces it
# ALONGSIDE a real candidate — which is the only arrangement that can tell the skip apart
# from an accident. A ref at HEAD gives the empty diff on a clean tree; master gives the
# real one. Delete the EMPTY_DIFF_HASH skip in the gate and this check flips to allow.
rm -f "$receipts"/*
git -C "$repo" update-ref refs/remotes/origin/main HEAD
receipt APPROVED e3b0c44298fc
check "empty-diff receipt unlocks nothing" 'git push'            '^deny:.*no review receipt'
check "and the real candidate is still offered" 'git push'       "$(subject_hash)"
git -C "$repo" update-ref -d refs/remotes/origin/main

echo
echo "-- one hash per merge-base, and an absolute path in the refusal"
# Several candidate refs usually resolve to the same commit. Hashing the whole diff once per
# ref is the cost the gate's header claims the loop does not have, and a duplicated hash in
# the refusal reads as two distinct candidates. Delete the seen_mb block and this counts two.
rm -f "$receipts"/*
git -C "$repo" update-ref refs/heads/main "$(git -C "$repo" rev-parse master)"
h=$(subject_hash)
n=$(decision 'git push' | grep -o "$h" | wc -l)
[ "$n" -eq 1 ] && echo "ok   two refs on one merge-base yield one candidate" \
  || { echo "FAIL candidate listed $n times, expected 1"; fail=1; }
git -C "$repo" update-ref -d refs/heads/main

# `git rev-parse --git-common-dir` answers relative to the cwd, so from a subdirectory the
# refusal would name `../.git/ecomono/receipts` — a path that resolves nowhere the user is
# standing. Drop the cd/pwd absolutisation and this fails.
mkdir -p "$repo/sub"
got=$(decision 'git push' "$repo/sub")
printf '%s' "$got" | grep -q -- '\.\./\.git' \
  && { echo "FAIL refusal names a cwd-relative path"; fail=1; } \
  || echo "ok   refusal names an absolute path from a subdirectory"
printf '%s' "$got" | grep -q "$gitdir/ecomono/receipts" \
  && echo "ok   and it is the real receipts directory" \
  || { echo "FAIL refusal does not name the receipts directory"; fail=1; }

echo
echo "-- commands that are not a delivery"
rm -f "$receipts"/*
check "git status"                 'git status --short'          '^allow$'
check "git commit"                 'git commit -m x'             '^allow$'
# Still a false positive, and still the accepted direction: the two words in sequence inside a
# quoted argument tokenise exactly like a delivery. Tokenising narrowed this surface — it did
# not close it, and closing it needs the argv the hook never sees.
check "the two words inside a message" 'git commit -m "run git push now"' '^deny:'

echo
echo "-- nothing to review"
# On the base branch itself the diff against the merge-base is empty. There are no bytes
# under review, so the gate must not demand a receipt for them.
git -C "$repo" checkout -q master
check "on the base branch, armed, no receipt" 'git push'         '^allow$'
git -C "$repo" checkout -q work

echo
echo "-- release valve, and only in the shape the refusal promises"
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | ECOMONO_ALLOW_UNREVIEWED_PUSH=1 "$gate") || true
[ -z "$out" ] && echo "ok   env valve stands down" || { echo "FAIL env valve ignored"; fail=1; }
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | ECOMONO_ALLOW_UNREVIEWED_PUSH=0 "$gate") || true
[ -n "$out" ] && echo "ok   any value but 1 keeps the gate armed" \
  || { echo "FAIL gate disarmed by a non-1 value"; fail=1; }
# The refusal tells the user to re-run with the prefix, so the prefix must work...
check "inline prefix valve"        'ECOMONO_ALLOW_UNREVIEWED_PUSH=1 git push' '^allow$'
# ...including after a leading space, the habit that keeps a line out of shell history, and
# with a tab as the separator. Requiring one exact ASCII space refused both.
check "leading space before it"    ' ECOMONO_ALLOW_UNREVIEWED_PUSH=1 git push' '^allow$'
check "tab as separator"           'ECOMONO_ALLOW_UNREVIEWED_PUSH=1	git push' '^allow$'
# ...and nothing but that shape may. An unanchored substring match would let a legal ref
# name disarm the gate; these fail the moment the case pattern loses its anchor.
check "not as a ref name"          'git push origin HEAD:refs/heads/x-ECOMONO_ALLOW_UNREVIEWED_PUSH=1' '^deny:'
# The line above cannot fail the anchor on its own: the text ends at `=1`, so the pattern's
# `[[:space:]]` never matches wherever the anchor sits. This one has trailing whitespace and
# no chaining character, so the leading anchor is the only thing refusing it — remove the
# anchor and this is the assertion that flips.
check "not as a ref name mid-command" 'git push origin refs/heads/note-ECOMONO_ALLOW_UNREVIEWED_PUSH=1 ok' '^deny:'
check "not with another digit"     'ECOMONO_ALLOW_UNREVIEWED_PUSH=10 git push' '^deny:'
check "not in a commit message"    'git commit -m "set ECOMONO_ALLOW_UNREVIEWED_PUSH=1 to skip" && git push' '^deny:'
# A plain continuation is still one command and must override.
check "override across a continuation" 'ECOMONO_ALLOW_UNREVIEWED_PUSH=1 \
git push'                                                        '^allow$'
# The override authorises the whole command line, chaining included. Three rounds tried to
# confine it to one command by scanning for `&&`, then `;` `|` and newlines, then `$(` and
# backticks; each shape closed and the next round found another, while the scan started
# refusing ordinary quoted arguments. These pin the contract that replaced it — and the two
# quoted cases below are the ones the scan was breaking.
check "chaining is authorised too"  'ECOMONO_ALLOW_UNREVIEWED_PUSH=1 echo hi && git push' '^allow$'
check "an ampersand in a title"     'ECOMONO_ALLOW_UNREVIEWED_PUSH=1 gh pr create --title "Fix A & B" --fill' '^allow$'
check "a substituted body"          'ECOMONO_ALLOW_UNREVIEWED_PUSH=1 gh pr create --body "$(cat notes.md)" --fill' '^allow$'

# ------------------------------------------------- fixture 2: a base the list cannot guess
echo
echo "-- a base branch the candidate list does not know"
# The failure this guards: a stale local master resolves, produces a hash nobody signed,
# and denies a delivery that has a perfectly good receipt against the real base.
repo2="$tmproot/repo2"
mkdir -p "$repo2"
git -C "$repo2" init -q -b master .
git_c "$repo2" commit -q --allow-empty -m stale        # master stays here, and is wrong
git -C "$repo2" checkout -q -b develop
# Real content, not --allow-empty: two base commits with identical trees produce identical
# diffs against the working tree, so the fixture would pass while proving nothing.
printf 'base\n' > "$repo2/base.txt"
git -C "$repo2" add base.txt
git_c "$repo2" commit -q -m "real base"
git -C "$repo2" checkout -q -b work
printf 'x\n' > "$repo2/f.txt"
git -C "$repo2" add f.txt
git_c "$repo2" commit -q -m change
r2dir="$repo2/.git"; mkdir -p "$r2dir/ecomono/receipts"; : > "$r2dir/ecomono/review-mode"

h_dev=$(subject_hash "$repo2" develop)
h_master=$(subject_hash "$repo2" master)
[ "$h_dev" != "$h_master" ] && echo "ok   the two bases really do disagree" \
  || { echo "FAIL fixture bases produce the same hash"; fail=1; }
mb_dev=$(git -C "$repo2" merge-base HEAD develop)
receipt APPROVED "$h_dev" "$r2dir/ecomono/receipts"
check "stale master shadows the real base" 'git push' '^deny:' "$repo2"
check "and the refusal points at the config" 'git push' 'ecomono.reviewBase' "$repo2"

# F2: a receipt recording the REAL base is honoured in this same shape, where the base-less
# receipt above is refused. `ecomono.reviewBase` is still unset here — this is the
# recorded-base loop consulting the receipt's own `base:` line, not the config.
rm -f "$r2dir/ecomono/receipts"/*
receipt_based APPROVED "$h_dev" "$mb_dev" "$r2dir/ecomono/receipts"
check "a recorded base survives the stale-master shadow" 'git push' '^allow$' "$repo2"
rm -f "$r2dir/ecomono/receipts"/*
receipt APPROVED "$h_dev" "$r2dir/ecomono/receipts"

git -C "$repo2" config ecomono.reviewBase develop
check "the configured base is used alone"  'git push' '^allow$' "$repo2"
# A configured base that does not resolve must say so, and must not claim the setting is
# absent — the operator who already did the thing the message asks for gets told they did
# not. It must also not fall back to the candidate list, which would answer a typo by
# guessing the base this setting exists to stop it guessing.
git -C "$repo2" config ecomono.reviewBase no-such-branch
check "a bad reviewBase asks"              'git push' '^ask:'                "$repo2"
check "and names the value that failed"    'git push' 'no-such-branch'       "$repo2"
check "and does not claim none is set"     'git push' 'set to'               "$repo2"
got=$(decision 'git push' "$repo2")
printf '%s' "$got" | grep -q 'The candidate list was not tried' \
  && echo "ok   and says the fallback was deliberately skipped" \
  || { echo "FAIL bad-config message does not explain the missing fallback"; fail=1; }

# F1: a base:-bearing receipt is honoured even though `ecomono.reviewBase` names a branch that
# does not resolve. "a bad reviewBase asks" above keeps passing only because that receipt has NO
# `base:` line — kept base-less on purpose — so this is the paired case for the same broken
# config: a receipt for the same hash that DOES record its base is honoured instead of asked.
rm -f "$r2dir/ecomono/receipts"/*
receipt_based APPROVED "$h_dev" "$mb_dev" "$r2dir/ecomono/receipts"
check "a recorded base is honoured though reviewBase does not resolve" 'git push' '^allow$' "$repo2"
rm -f "$r2dir/ecomono/receipts"/*
receipt APPROVED "$h_dev" "$r2dir/ecomono/receipts"

git -C "$repo2" config --unset ecomono.reviewBase

# Two candidates, one ESCALATED and one with no receipt at all: the refusal must still list
# EVERY hash tried, or the operator cannot tell which base produced which. Asserting on the
# escalated hash would prove nothing — it appears in the escalated line either way — so this
# asserts on the other one, which the pre-fix message dropped entirely.
git -C "$repo2" update-ref refs/heads/main "$(git -C "$repo2" rev-parse develop)"
rm -f "$r2dir/ecomono/receipts"/*
receipt ESCALATED "$h_master" "$r2dir/ecomono/receipts"
check "escalated refusal names the other candidate too" 'git push' "$h_dev" "$repo2"
check "and still says the verdict was non-approving"    'git push' 'non-approving' "$repo2"
git -C "$repo2" update-ref -d refs/heads/main
rm -f "$r2dir/ecomono/receipts"/*

# ------------------------------------------------------ fixture 3: no base resolves at all
echo
echo "-- armed but unable to run"
# A repo on develop with no upstream, no origin and no master/main. Allowing silently here
# is indistinguishable from a passing review, so the gate has to surface it.
repo3="$tmproot/repo3"
mkdir -p "$repo3"
git -C "$repo3" init -q -b develop .
git_c "$repo3" commit -q --allow-empty -m base
printf 'y\n' > "$repo3/f.txt"
git -C "$repo3" add f.txt
git_c "$repo3" commit -q -m change
r3dir="$repo3/.git"; mkdir -p "$r3dir/ecomono/receipts"; : > "$r3dir/ecomono/review-mode"

check "no resolvable base asks, never silently allows" 'git push' '^ask:' "$repo3"
check "and names the config that fixes it" 'git push' 'ecomono.reviewBase' "$repo3"

# F3: with no candidate base resolving at all, a receipt whose recorded base matches allows,
# instead of the ask above. No `git merge-base` call here — the recorded-base loop diffs the
# receipt's own value directly, so mb3 is just the commit the review would have used as its base.
mb3=$(git -C "$repo3" rev-parse HEAD~1)
h3=$(git -C "$repo3" diff "$mb3" | sha256sum | cut -c1-12)
receipt APPROVED "$h3" "$r3dir/ecomono/receipts"
check "still asks with a base-less receipt" 'git push' '^ask:' "$repo3"
rm -f "$r3dir/ecomono/receipts"/*
receipt_based APPROVED "$h3" "$mb3" "$r3dir/ecomono/receipts"
check "a recorded base allows when no candidate base resolves at all" 'git push' '^allow$' "$repo3"
rm -f "$r3dir/ecomono/receipts"/*

# Unarmed, the same repo must stay silent — the marker is what turns this on.
rm -f "$r3dir/ecomono/review-mode"
check "unarmed, no base, still silent"     'git push' '^allow$' "$repo3"

# ------------------------------------------------------- fixture 4: the diff cannot be read
echo
echo "-- armed, base resolves, diff fails"
# Piped into sha256sum, a failed `git diff` writes nothing and hashes to EMPTY_DIFF_HASH —
# indistinguishable from "no bytes under review", which exits allowing the push. The shape is
# a partial clone whose promisor remote cannot serve a blob; here the blob is simply removed.
repo4="$tmproot/repo4"
mkdir -p "$repo4"
git -C "$repo4" init -q -b master .
printf 'base\n' > "$repo4/f.txt"
git -C "$repo4" add f.txt
git_c "$repo4" commit -q -m base
git -C "$repo4" checkout -q -b work
printf 'changed\n' > "$repo4/f.txt"
git -C "$repo4" add f.txt
git_c "$repo4" commit -q -m change
r4dir="$repo4/.git"; mkdir -p "$r4dir/ecomono/receipts"; : > "$r4dir/ecomono/review-mode"
blob=$(git -C "$repo4" rev-parse master:f.txt)
rm -f "$r4dir/objects/${blob:0:2}/${blob:2}"
git -C "$repo4" diff "$(git -C "$repo4" merge-base HEAD master)" >/dev/null 2>&1 \
  && { echo "FAIL fixture: git diff still succeeds, nothing is being tested"; fail=1; } \
  || echo "ok   the fixture really does break git diff"
check "a failed diff asks, never silently allows" 'git push' '^ask:'        "$repo4"
check "and says the diff failed"                  'git push' 'git diff'     "$repo4"
check "and names how to repair the clone"         'git push' 'refetch'      "$repo4"

# ------------------------------------------------ fixture 5: the base branch moves underneath
echo
echo "-- a receipt against a base that has since advanced"
# Upstream RDD shipped a "pre-PR review tolerates compatible base advance" fix, and this
# repo's own review history records a round whose freeze stopped reproducing when
# origin/master moved with no byte changing. Measured before writing these cases, because the
# framing turned out to be wrong in two of three shapes:
#
#   base gains UNRELATED commits  -> the hash does NOT move. `git merge-base` answers the fork
#                                    point, and commits that are not ancestors of HEAD do not
#                                    move it. The gate is already immune.
#   base absorbs ALL of the work  -> the diff is empty, which the EMPTY_DIFF_HASH skip already
#                                    treats as nothing under review.
#   base absorbs PART of the work -> the hash moves and the receipt stops matching. The one
#                                    real gap, asserted as a known ceiling below.
#
# The immunity is a property of the formula that nothing asserted, so it is pinned here: swap
# the gate's `git diff "$mb"` for `git diff "$ref"` and the second case flips to deny.
repo5="$tmproot/repo5"
mkdir -p "$repo5"
git -C "$repo5" init -q -b master .
printf 'base\n' > "$repo5/base.txt"
git -C "$repo5" add base.txt
git_c "$repo5" commit -q -m base
git -C "$repo5" checkout -q -b work
printf 'one\n' > "$repo5/f.txt"
git -C "$repo5" add f.txt
git_c "$repo5" commit -q -m c1
printf 'two\n' >> "$repo5/f.txt"
git -C "$repo5" add f.txt
git_c "$repo5" commit -q -m c2
r5dir="$repo5/.git"; mkdir -p "$r5dir/ecomono/receipts"; : > "$r5dir/ecomono/review-mode"

h5=$(subject_hash "$repo5" master)
mb5=$(git -C "$repo5" merge-base HEAD master)      # the base as the review saw it
receipt APPROVED "$h5" "$r5dir/ecomono/receipts"
check "receipt matches before the base moves" 'git push' '^allow$' "$repo5"

# Someone else's commit lands on the base. Real content, not --allow-empty: an empty commit
# leaves the tree identical, so the diff would be unchanged for the wrong reason.
before=$(git -C "$repo5" rev-parse master)
git -C "$repo5" checkout -q master
printf 'theirs\n' > "$repo5/other.txt"
git -C "$repo5" add other.txt
git_c "$repo5" commit -q -m "someone else"
git -C "$repo5" checkout -q work
[ "$(git -C "$repo5" rev-parse master)" != "$before" ] \
  && echo "ok   the fixture really did advance the base" \
  || { echo "FAIL base did not move, the case below proves nothing"; fail=1; }
[ "$(subject_hash "$repo5" master)" = "$h5" ] \
  && echo "ok   an unrelated base advance does not move the subject hash" \
  || { echo "FAIL unrelated base advance moved the hash"; fail=1; }
check "the receipt survives an unrelated base advance" 'git push' '^allow$' "$repo5"

# The base absorbs PART of the reviewed work: master merges c1, so the merge-base advances into
# the branch and the diff narrows to c2 alone. Not a rewind of master — the unrelated commit
# above stays, because the two advances have to be able to coexist.
git -C "$repo5" checkout -q master
git_c "$repo5" merge -q --no-edit work~1
git -C "$repo5" checkout -q work
[ "$(subject_hash "$repo5" master)" != "$h5" ] \
  && echo "ok   partial absorption really does move the hash" \
  || { echo "FAIL partial absorption left the hash alone, the cases below prove nothing"; fail=1; }

# A receipt written before this mechanism existed carries no `base:` line, and there is nothing
# to re-derive from — so it keeps the old behaviour rather than being honoured on a guess. This
# is also what proves the tolerance below is driven by the recorded base and not by something
# else in the fixture.
check "a receipt with no recorded base still refuses" 'git push' '^deny:' "$repo5"

# With the reviewed merge-base recorded, the gate re-derives the hash from it: the bytes are
# unchanged relative to what was reviewed, so the receipt still covers them.
receipt_based APPROVED "$h5" "$mb5" "$r5dir/ecomono/receipts"
check "a recorded base survives partial absorption" 'git push' '^allow$' "$repo5"

# ...and every way that must NOT become an allow. The tolerance re-derives a hash from a value
# read out of the receipt BODY, where nothing before it carried a contract, so each of these is
# the boundary rather than a precaution.
#
# 1. The recorded base must reproduce the receipt's OWN name. Otherwise a receipt could name any
#    base and approve bytes nobody reviewed.
rm -f "$r5dir/ecomono/receipts"/*
wrong=$(printf 'not-the-reviewed-bytes' | sha256sum | cut -c1-12)
receipt_based APPROVED "$wrong" "$mb5" "$r5dir/ecomono/receipts"
check "a base that does not reproduce the filename is ignored" 'git push' '^deny:' "$repo5"

# 2. Bytes that moved after the review must still be refused — the whole point of the hash.
rm -f "$r5dir/ecomono/receipts"/*
receipt_based APPROVED "$h5" "$mb5" "$r5dir/ecomono/receipts"
printf 'three\n' >> "$repo5/f.txt"
check "bytes moved since the review are still refused" 'git push' '^deny:' "$repo5"
git -C "$repo5" checkout -q -- f.txt
check "and reverting them makes the same receipt valid again" 'git push' '^allow$' "$repo5"

# 3. A non-approving verdict is not an approval on this path either.
receipt_based ESCALATED "$h5" "$mb5" "$r5dir/ecomono/receipts"
check "an escalated receipt is not honoured by re-derivation" 'git push' '^deny:' "$repo5"

# 4. The empty-diff constant is a public value and must stay a non-key HERE too, not only in the
#    candidate loop. A receipt named e3b0c44298fc whose recorded base is HEAD re-derives to its
#    own name on any clean tree in any repository — the exact skeleton key the candidate loop
#    already refuses. Drop the EMPTY_DIFF_HASH guard from the re-derivation and this flips.
rm -f "$r5dir/ecomono/receipts"/*
receipt_based APPROVED e3b0c44298fc "$(git -C "$repo5" rev-parse HEAD)" "$r5dir/ecomono/receipts"
check "an empty-diff receipt unlocks nothing on re-derivation" 'git push' '^deny:' "$repo5"

# 5. A base value that is not a commit id must be refused without reaching git with it. The body
#    is operator-editable text, so `HEAD`, a refspec or a git option arriving here as a base is
#    input at a trust boundary, not a typo to be forgiving about.
rm -f "$r5dir/ecomono/receipts"/*
for bogus in HEAD master --upstream '$(touch /dev/null)' 0000000000000000000000000000000000000000; do
  receipt_based APPROVED "$h5" "$bogus" "$r5dir/ecomono/receipts"
  got=$(decision 'git push' "$repo5")
  printf '%s' "$got" | grep -Eq '^deny:' \
    && echo "ok   a base of '$bogus' is refused, not resolved" \
    || { echo "FAIL base '$bogus' produced: ${got:0:80}"; fail=1; }
done

# 6. ...and a revision EXPRESSION is refused even though it resolves to the very commit the
#    review used. This is what makes the 40-hex validation load-bearing rather than decorative:
#    loosen the pattern to accept anything and this is the case that flips to allow. Refusing it
#    is the point — `work~2` names a different commit after one more commit lands, so it cannot
#    carry a claim about immutable bytes the way an object id can.
rm -f "$r5dir/ecomono/receipts"/*
[ "$(git -C "$repo5" rev-parse 'work~2')" = "$mb5" ] \
  && echo "ok   work~2 really does resolve to the reviewed base" \
  || { echo "FAIL fixture: work~2 is not the reviewed base, case 6 proves nothing"; fail=1; }
receipt_based APPROVED "$h5" 'work~2' "$r5dir/ecomono/receipts"
check "a base as a revision expression is refused though it resolves" 'git push' '^deny:' "$repo5"
rm -f "$r5dir/ecomono/receipts"/*

echo
echo "-- an unarmed repository pays nothing for alias resolution"
# The alias lookup used to sit in the token scan, which runs before the marker check, so every
# `git status` / `git log` / `git add` in every repository the hook is installed in spawned a
# `git config`. A shim records what the gate actually invokes.
shim=$(mktemp -d)
realgit=$(command -v git)
{ printf '#!/usr/bin/env bash\n'
  printf 'printf "%%s\\n" "$*" >> "$GIT_SHIM_LOG"\n'
  printf 'exec %s "$@"\n' "$realgit"
} > "$shim/git"
chmod +x "$shim/git"
shimlog=$(mktemp)

shim_run() { # shim_run <command>
  : > "$shimlog"
  ( cd "$repo" && jq -nc --arg c "$1" '{tool_input:{command:$c}}' \
      | GIT_SHIM_LOG="$shimlog" PATH="$shim:$PATH" "$gate" >/dev/null ) || true
  grep -c 'config --get alias\.' "$shimlog" 2>/dev/null || true
}

disarm
n=$(shim_run 'git status --short')
[ "${n:-0}" -eq 0 ] && echo "ok   unarmed git status resolves no alias" \
  || { echo "FAIL unarmed git status spawned $n alias lookups"; fail=1; }
n=$(shim_run 'git commit -m x')
[ "${n:-0}" -eq 0 ] && echo "ok   unarmed git commit resolves no alias" \
  || { echo "FAIL unarmed git commit spawned $n alias lookups"; fail=1; }
arm
n=$(shim_run 'git status --short')
[ "${n:-0}" -gt 0 ] && echo "ok   armed, the lookup does happen" \
  || { echo "FAIL armed repo never resolved the alias, so the check above proves nothing"; fail=1; }

# A cycle terminating is not evidence the cycle guard works — the hop backstop alone would
# also terminate, just 64 lookups later. Two judges pointed out that the previous assertion
# could not tell the two apart. Counting the lookups can: the guard stops at the repeat.
# Resuming the outer scan at i+1 re-inspects the flag values it already consumed, so a value
# that reads `git` is taken for a second invocation and its subcommand is queued twice.
n=$(shim_run 'git -C git status')
[ "${n:-0}" -eq 1 ] && echo "ok   consumed flag values are not rescanned as invocations" \
  || { echo "FAIL 'git -C git status' queued $n lookups, expected 1"; fail=1; }

n=$(shim_run 'git loopa')
{ [ "${n:-0}" -gt 0 ] && [ "${n:-0}" -le 4 ]; } \
  && echo "ok   a cyclic alias stops at the repeat, not at the hop backstop ($n lookups)" \
  || { echo "FAIL cyclic alias took $n lookups; the cycle guard is not what stopped it"; fail=1; }
rm -rf "$shim" "$shimlog"

echo
echo "-- fails open"
out=$(cd "$repo" && printf 'not json' | "$gate") || true
[ -z "$out" ] && echo "ok   malformed payload fails open" || { echo "FAIL malformed payload blocked"; fail=1; }

out=$(cd "$repo" && jq -nc '{tool_name:"Bash",tool_input:{}}' | "$gate") || true
[ -z "$out" ] && echo "ok   missing command fails open" || { echo "FAIL empty command blocked"; fail=1; }

sh_bin=$(command -v bash)
empty=$(mktemp -d)
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | PATH="$empty" "$sh_bin" "$gate") || true
rmdir "$empty"
[ -z "$out" ] && echo "ok   missing jq fails open" || { echo "FAIL missing jq blocked"; fail=1; }

# jq present, sha256sum absent. Emptying PATH cannot test this: the jq check short-circuits
# first, so the sha256sum branch would never be reached and the case would pass for the
# wrong reason.
#
# The list has two kinds of entry and conflating them is what kept this case green for several
# rounds while it proved nothing. Two judges mutation-proved that: deleting
# `command -v sha256sum` entirely left the case passing.
#
#   REACH the guard: `jq`, `cat`, `tr`, `sed`, `git` all run before it — `cat` feeds `jq` the
#   payload, `tr` and `sed` normalise the command. `sed` was the one missing, so the normaliser
#   produced an empty string, no delivery was detected, and the gate exited long before the guard.
#
#   DEFEAT MUTATION MASKING: `mktemp` runs AFTER the guard, so it is irrelevant while the guard is
#   there. It is listed because without it the guard-deleted mutant exits open again for an
#   unrelated reason (`mktemp: command not found`), and a mutation that cannot fail is not a check.
#
# `head` and `cut` also run after the guard and are needed for neither job — measured by removing
# them in both directions — so they are gone rather than left as a claim that would rot. Measured
# with the list as it stands: the guard deleted DENIES (the hash is empty and matches nothing),
# the guard present allows.
nosha=$(mktemp -d)
for b in jq git sed mktemp cat tr; do ln -s "$(command -v "$b")" "$nosha/$b"; done
out=$(cd "$repo" && jq -nc '{tool_input:{command:"git push"}}' | PATH="$nosha" "$sh_bin" "$gate") || true
[ -n "$(PATH="$nosha" command -v jq)" ] && [ -z "$(PATH="$nosha" command -v sha256sum)" ] \
  && echo "ok   the no-sha256sum fixture is the state it claims" \
  || { echo "FAIL fixture PATH is wrong"; fail=1; }
rm -rf "$nosha"
[ -z "$out" ] && echo "ok   missing sha256sum fails open" || { echo "FAIL missing sha256sum blocked"; fail=1; }

# A bare repository has no work tree to diff, and `git rev-parse --is-inside-work-tree`
# prints `false` while still exiting 0 — so the usual `>/dev/null || exit 0` idiom lets the
# gate run on inside one. Armed here (the bare repo's own directory IS its common dir), it
# must still stand down rather than reach the base resolution and ask.
bare="$tmproot/bare.git"
git init -q --bare "$bare"
mkdir -p "$bare/ecomono/receipts"; : > "$bare/ecomono/review-mode"
out=$(cd "$bare" && jq -nc '{tool_input:{command:"git push"}}' | "$gate") || true
[ -z "$out" ] && echo "ok   bare repository stands down" || { echo "FAIL bare repo not excluded"; fail=1; }

outside=$(mktemp -d)
out=$(cd "$outside" && jq -nc '{tool_input:{command:"git push"}}' | "$gate") || true
rm -rf "$outside"
[ -z "$out" ] && echo "ok   outside a git repo fails open" || { echo "FAIL non-repo blocked"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then echo "review-receipt-gate: all cases passed"; fi
exit $fail
