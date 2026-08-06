#!/usr/bin/env bash
# Fixtures for check-hook-install-drift.sh — bash test-hook-install-drift.sh
#
# The check itself is the thing that catches a hook silently not running, so a
# regression in it is silent by construction: it keeps printing `ok` while a declared
# gate sits unwired. Across three review rounds, blind judges reproduced TEN ways two
# earlier designs did exactly that — every case below named after one of them. The count
# is not restated here as a number to keep in sync; `docs/DESIGN.md` holds the tally, and
# the suite prints its own total by counting rather than by remembering. An earlier
# version of this header said "four... five" long after there were eight, which is the
# same staleness the closing comment warns about for the numeric total.
#
# The last three cases are the interesting ones: `args` and `once` are fields the check
# never mentions, caught anyway because whole-entry comparison covers what nobody
# enumerated. That is the claim of the current design, so it is tested rather than
# asserted.
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

elif mutation == "wrong-type":
    # Type changed, stale command left behind. A prompt/agent/http/mcp_tool hook
    # never executes the command field, so the gate does not run — but keyed on the
    # command alone it computed the same key and read as installed.
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["type"] = "prompt"

elif mutation == "expanded-home":
    # The live side spells the path out with no $HOME substring at all. The check
    # claims these compare equal to the template's `$HOME/...`; nothing measured it
    # until a judge deleted the branch and watched every case still pass.
    import os as _os
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["command"] = _os.environ["HOME"] + "/.claude/hooks/review-receipt-gate.sh"

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

elif mutation == "args-form":
    # Exec form: the script lives in `args`, and `command` is a bare executable name.
    # The old extractor read `command` only, resolved "node" to nothing, and dropped the
    # entry from BOTH sides — a judge showed that reads as ok. Nothing in the check
    # mentions `args`; whole-entry comparison covers it because it covers everything.
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["command"] = "node"
    hook["args"] = ["$HOME/.claude/hooks/review-receipt-gate.sh"]

elif mutation == "once-added":
    # `once: true` makes a hook self-delete after firing. No field of the old key
    # modelled it. Same construction argument: not enumerated, still compared.
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["once"] = True

elif mutation == "vacuous-empty-hooks":
    doc["hooks"] = {}

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

# 7 — the live command wraps the declared script in an interpreter the template does
# not use. The old extractor called these equal because it reached past the wrapper for
# "the script"; comparing the whole entry calls it what it is. `node foo.sh` and
# `foo.sh` are not the same command, and a wrapper appearing on one side only is either
# a deliberate local change worth surfacing or a mistake worth catching.
build "node-wrapped"
t fail "a wrapper the template does not declare is drift"
grep_out "secret-access-gate.sh"

# 7c — type changed away from "command", stale command string left in place.
build "wrong-type"
t fail "type changed to prompt — the command field no longer executes"
grep_out "review-receipt-gate.sh"

# 7d — an interpreter flag must not be mistaken for the script. BOTH sides need the
# `bash -x` shape, or the keys differ anyway and the case passes for the wrong reason —
# which is what the first version of this fixture did, caught by deleting the flag skip
# and watching all 16 still pass. That is why the template side has a seam too.
alt_template="$fixture/template.json"
python3 - "$repo/claude/settings.template.json" "$alt_template" "$live" <<'PY'
import json, sys

src, tmpl_out, live_out = sys.argv[1:4]

def find(doc, script_suffix):
    for group in doc["hooks"].get("PreToolUse", []):
        for hook in group.get("hooks", []):
            if hook.get("command", "").endswith(script_suffix):
                return hook
    raise SystemExit(f"fixture bug: no PreToolUse hook ending in {script_suffix}")

for out, script in (
    (tmpl_out, "review-receipt-gate.sh"),
    (live_out, "completely-unrelated-noop.sh"),
):
    doc = json.load(open(src))
    find(doc, "review-receipt-gate.sh")["command"] = f"bash -x $HOME/.claude/hooks/{script}"
    json.dump(doc, open(out, "w"), indent=2)
PY
cases=$((cases + 1))
out=$(ECOMONO_TEMPLATE_SETTINGS="$alt_template" ECOMONO_LIVE_SETTINGS="$live" \
      bash "$repo/check-hook-install-drift.sh" 2>&1)
if [ $? -ne 0 ] && printf '%s\n' "$out" | grep -qF "review-receipt-gate.sh"; then
  echo "ok   bash -x <script> on both sides compares the script, not the flag"
else
  echo "FAIL bash -x <script> on both sides compares the script, not the flag"
  printf '     %s\n' "$out"
  fail=1
fi

# 7e — a fully expanded $HOME on the live side still matches the template's $HOME form.
build "expanded-home"
t pass "an expanded absolute path matches the template's \$HOME spelling"

# 7b — one of two registrations that differ only by `if:`. The gate keeps firing for
# one delivery shape and silently stops for the other.
build "lost-one-if"
t fail "one of two registrations differing only by if: is gone"
grep_out "check-diff-size.sh"

# 7f, 7g — two fields NOBODY enumerated. The check never mentions `args` or `once`; if
# whole-entry comparison works, these are caught anyway. That is the claim being tested.
build "args-form"
t fail "an args exec-form entry differs from the declared command form"
grep_out "review-receipt-gate.sh"

build "once-added"
t fail "a once: true added live is drift, though no field of the key names it"
grep_out "review-receipt-gate.sh"

# 7h — a live file with no hooks at all must not read as agreement.
build "vacuous-empty-hooks"
t fail "a live file with an empty hooks object is drift, not a vacuous pass"

# 8 — disableAllHooks kill switch.
build "disable-all"
t fail "disableAllHooks: true fails regardless of the registrations"
grep_out "disableAllHooks"

# 9 — allowManagedHooksOnly kill switch.
build "managed-only"
t fail "allowManagedHooksOnly: true fails regardless of the registrations"
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
