#!/usr/bin/env bash
# Fixtures for check-hook-install-drift.sh — bash test-hook-install-drift.sh
#
# The check itself is the thing that catches a hook silently not running, so a
# regression in it is silent by construction: it keeps printing `ok` while a declared
# gate sits unwired. Two blind judges reproduced, against a copy of the real live
# settings, four ways the previous basename-set version passed while a declared hook
# was not running (cases 3-6 below) plus the kill switches (cases 8-9) — this suite
# exists so none of the five can regress unnoticed.
#
# Every case builds a throwaway "live settings" file and points the check at it
# through ECOMONO_LIVE_SETTINGS, the seam the script already exposes. The real
# ~/.claude/settings.json is never read or written — an operator's live file is
# theirs, not a fixture.

set -uo pipefail
cd "$(dirname "$0")"
repo=$PWD

fixture=$(mktemp -d) || exit 1
trap 'rm -rf "$fixture"' EXIT
live="$fixture/settings.json"

fail=0
cases=0
last_out=""
t() { # t <expected pass|fail> <description> — runs the check, sets $last_out
  local rc got
  cases=$((cases + 1))
  last_out=$(ECOMONO_LIVE_SETTINGS="$live" bash "$repo/check-hook-install-drift.sh" 2>&1); rc=$?
  got=$([ $rc -eq 0 ] && echo pass || echo fail)
  if [ "$got" = "$1" ]; then
    echo "ok   $2"
  else
    echo "FAIL $2 — got $got, wanted $1"
    printf '     %s\n' "$last_out"
    fail=1
  fi
}

grep_out() { # grep_out <pattern> — asserts the last t() output contained <pattern>
  printf '%s\n' "$last_out" | grep -qF -- "$1" || {
    echo "FAIL   expected output to contain: $1"
    printf '     %s\n' "$last_out"
    fail=1
  }
}

# Builds a fixture live settings file: an exact copy of the template's "hooks"
# section, wrapped in a minimal settings document, then run through a python
# mutation named by $1 (or no mutation for the baseline).
build() { # build <mutation-name-or-empty> [extra json to merge at top level]
  python3 - "$repo/claude/settings.template.json" "$live" "$1" <<'PY'
import json, sys

template_path, out_path, mutation = sys.argv[1:4]
doc = json.load(open(template_path))
hooks = doc["hooks"]

def find(event, script_suffix):
    for group in hooks.get(event, []):
        for hook in group.get("hooks", []):
            if hook.get("command", "").endswith(script_suffix):
                return group, hook
    raise SystemExit(f"fixture bug: no hook ending in {script_suffix} under {event}")

if mutation == "hook-absent":
    group, _ = find("PreToolUse", "review-receipt-gate.sh")
    hooks["PreToolUse"].remove(group)

elif mutation == "wrong-event":
    group, _ = find("PreToolUse", "review-receipt-gate.sh")
    hooks["PreToolUse"].remove(group)
    hooks.setdefault("Notification", []).append(group)

elif mutation == "wrong-matcher":
    group, _ = find("PreToolUse", "review-receipt-gate.sh")
    group["matcher"] = "Read"

elif mutation == "comment-only":
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["command"] = (
        'true # was $HOME/.claude/hooks/review-receipt-gate.sh, disabled pending fix'
    )

elif mutation == "unrelated-tree":
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["command"] = "$HOME/.config/other-tools/review-receipt-gate.sh"

elif mutation == "node-wrapped":
    _, hook = find("PreToolUse", "secret-access-gate.sh")
    hook["command"] = 'node "$HOME/.claude/hooks/secret-access-gate.sh"'

elif mutation == "lost-one-if":
    # check-diff-size.sh is registered twice under the same event AND matcher,
    # separated only by its `if:`. Drop the second. Keyed on anything less than the
    # full (event, matcher, if, script) this reads as fully installed — measured on
    # the real live file before `if` was part of the key.
    matches = [
        (group, hook)
        for group in hooks.get("PreToolUse", [])
        for hook in group.get("hooks", [])
        if hook.get("command", "").endswith("check-diff-size.sh")
    ]
    if len(matches) < 2:
        raise SystemExit("fixture bug: expected check-diff-size.sh registered twice")
    group, hook = matches[1]
    group["hooks"].remove(hook)

elif mutation == "disable-all":
    doc["disableAllHooks"] = True

elif mutation == "managed-only":
    doc["allowManagedHooksOnly"] = True

elif mutation == "":
    pass

else:
    raise SystemExit(f"fixture bug: unknown mutation {mutation}")

with open(out_path, "w") as fh:
    json.dump(doc, fh, indent=2)
PY
}

# 1 — the unmutated baseline has to pass, or every other case below proves nothing.
build ""
t pass "baseline: an exact copy of the template passes"

# 2 — a hook missing entirely.
build "hook-absent"
t fail "hook absent — DRIFT names it"
grep_out "review-receipt-gate.sh"

# 3 — right script, registered under the wrong event (the Notification failure a
# judge reproduced against a copy of the live settings).
build "wrong-event"
t fail "right script under the wrong EVENT (Notification instead of PreToolUse)"
grep_out "event=PreToolUse"

# 4 — right script, registered under a matcher that never fires for Bash.
build "wrong-matcher"
t fail "right script under the wrong MATCHER (Read instead of Bash)"
grep_out "matcher='Bash'"

# 5 — script named only in a disabling comment, never actually invoked.
build "comment-only"
t fail "script named only in a comment (true # was ..., disabled)"
grep_out "review-receipt-gate.sh"

# 6 — same basename, unrelated tree.
build "unrelated-tree"
t fail "same basename filed under an unrelated tree"
grep_out "review-receipt-gate.sh"

# 7 — a node "$HOME/..." wrapped command still resolves to the right script.
build "node-wrapped"
t pass "a node \"\$HOME/...\" wrapped command is still recognized"

# 7b — one of two registrations that differ only by `if:`. The gate keeps firing for
# one delivery shape and silently stops for the other.
build "lost-one-if"
t fail "one of two registrations differing only by if: is gone"
grep_out "check-diff-size.sh"

# 8 — disableAllHooks kill switch.
build "disable-all"
t fail "disableAllHooks: true fails regardless of the triples"
grep_out "disableAllHooks"

# 9 — allowManagedHooksOnly kill switch.
build "managed-only"
t fail "allowManagedHooksOnly: true fails regardless of the triples"
grep_out "allowManagedHooksOnly"

# 10 — live file absent: skip, exit 0.
rm -f "$live"
t pass "live settings file absent — skip, exit 0"
grep_out "skip"

# 11 — malformed JSON: non-zero with a clear message.
printf '{ not json' > "$live"
t fail "malformed JSON — non-zero with a clear message"
grep_out "error: cannot read"

# 12 — back to the baseline, proving no case leaked state into the fixture.
build ""
t pass "baseline again after every mutation"

# Counted, not written down. A hardcoded total is a claim that goes stale the first
# time a case is added — this one already printed 12 while running 13.
[ $fail -eq 0 ] && echo "hook-install-drift: $cases cases passed"
exit $fail
