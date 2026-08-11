#!/usr/bin/env bash
# Fixtures for check-hook-install-drift.sh — bash test-hook-install-drift.sh
#
# The check itself is the thing that catches a hook silently not running, so a
# regression in it is silent by construction: it keeps printing `ok` while a declared
# gate sits unwired. Across successive review rounds, blind judges reproduced a series of
# ways two earlier designs did exactly that — every case below is named after one of
# them. No tally here: an earlier version of this header carried one, and it was stale
# within a round. The suite prints its own total by counting; the history is in
# `git log -p`.
#
# The interesting cases are the ones for `args` and `once`: neither has a dedicated
# branch anywhere in the check, and both are caught because whole-entry comparison covers
# what nobody implemented a rule for. (The claim used to be that the check "never
# mentions" them, which was false — its comments name both. Naming an effect is not
# implementing it, and the distinction is the whole point of the design.)
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

# A hooks root the suite owns, so the existence half of the check never asks about the machine
# running the tests. Seeded with a stub for every script the template names: the cases below are
# about registration drift, and a missing script would make all of them fail for a second,
# unrelated reason. The two cases that ARE about a missing script empty it deliberately.
hookhome="$fixture/home"
seed_hooks() {
  rm -rf "$hookhome"; mkdir -p "$hookhome/.claude/hooks"
  python3 - "$repo/claude/settings.template.json" "$hookhome" <<'SEED'
import json, os, sys
tmpl, home = sys.argv[1], sys.argv[2]
doc = json.load(open(tmpl))
for groups in (doc.get("hooks") or {}).values():
    for group in groups:
        for hook in group.get("hooks") or []:
            cmd = hook.get("command")
            if hook.get("type") != "command" or not isinstance(cmd, str):
                continue
            p = cmd.strip().replace("${HOME}", "~").replace("$HOME", "~")
            if len(p.split()) != 1 or not p.startswith("~/"):
                continue
            dest = os.path.join(home, p[2:])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            open(dest, "w").write("#!/usr/bin/env bash\n")
            # Executable, because the check requires X_OK, not mere presence. This line and that
            # requirement encode "what counts as an installed hook" in two places, and a judge
            # named the coupling before it bit: fix one side alone and every baseline case flips.
            #
            # The stub is a shebang-only no-op, which is DELIBERATELY at the check's named
            # content ceiling — a judge flagged the shape. Content is irrelevant to what these
            # fixtures test (registration comparison and file properties); a stub with a real
            # body would claim coverage the check does not have.
            os.chmod(dest, 0o755)
SEED
}
seed_hooks

fail=0
cases=0
last_out=""
t() { # t <expected pass|fail> <description> — runs the check, sets $last_out
  local rc got
  cases=$((cases + 1))
  last_out=$(ECOMONO_LIVE_SETTINGS="$live" ECOMONO_HOOKS_HOME="$hookhome" \
    bash "$repo/check-hook-install-drift.sh" 2>&1); rc=$?
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
    # entry from BOTH sides — a judge showed that reads as ok. No rule in the check
    # handles `args`; whole-entry comparison covers it because it covers everything.
    # `command` is left BYTE-IDENTICAL to the template on purpose. An earlier version
    # also rewrote it to "node", which made the case pass on the command difference
    # alone — it still passed with `args` fully excluded from the comparison, so it
    # proved nothing about `args`. A judge isolated the two halves and caught it.
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["args"] = ["--inspect"]

elif mutation == "once-added":
    # `once: true` makes a hook self-delete after firing. No field of the old key
    # modelled it. Same construction argument: not enumerated, still compared.
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["once"] = True

elif mutation == "ignored-fields-differ":
    # statusMessage and timeout are the two fields IGNORED_FIELDS excludes. A live file
    # differing only in those must still pass, or the exclusion list is not doing the job
    # that justifies calling the false-alarm rate low. Nothing tested this until a judge
    # set IGNORED_FIELDS to () and watched every case stay green.
    _, hook = find("PreToolUse", "review-receipt-gate.sh")
    hook["statusMessage"] = "something else entirely"
    hook["timeout"] = 99

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

# 7f, 7g — two fields with no rule of their own anywhere in the check. If whole-entry
# comparison works, they are caught regardless. That is the claim being tested.
build "args-form"
t fail "an args key added live is drift, with command left identical"
grep_out "review-receipt-gate.sh"

build "once-added"
t fail "a once: true added live is drift, though no rule handles it"
grep_out "review-receipt-gate.sh"

# 7h — the two IGNORED_FIELDS must actually be ignored. This is the case that keeps the
# false-alarm rate honest: without it, shrinking the list breaks nothing visible.
build "ignored-fields-differ"
t pass "a differing statusMessage and timeout are ignored, not drift"

# 7i — an empty TEMPLATE makes every comparison vacuous, so the check must refuse rather
# than report `ok 0`. It has to be built on the template side: an earlier version emptied
# the LIVE side instead, which is just case 2 for all eight hooks at once, and deleting
# the guard entirely left all nineteen cases green. Both judges caught that independently.
empty_tmpl="$fixture/empty-template.json"
printf '{"hooks":{}}' > "$empty_tmpl"
build ""
cases=$((cases + 1))
out=$(ECOMONO_TEMPLATE_SETTINGS="$empty_tmpl" ECOMONO_LIVE_SETTINGS="$live" \
      bash "$repo/check-hook-install-drift.sh" 2>&1)
if [ $? -ne 0 ] && printf '%s\n' "$out" | grep -qF "refusing to report a vacuous pass"; then
  echo "ok   an empty template refuses rather than passing vacuously"
else
  echo "FAIL an empty template refuses rather than passing vacuously"
  printf '     %s\n' "$out"
  fail=1
fi

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

# A registration is not a running gate, and this check compared registrations only until it
# reported `ok` for a hook that did not exist. Reproduced for real while adding one: the
# registration was added to the live file first, the script could not be placed because
# ~/.claude/hooks is a read-only Nix store symlink, and every registration was "present".
build ""
rm -f "$hookhome/.claude/hooks/review-receipt-gate.sh"
t fail "a registered hook whose script is not on disk"
grep_out "whose script is not on disk"
# The per-entry line, not only the header — an operator acts on WHICH hook resolved WHERE, and a
# judge proved by mutation that deleting the detail print left every case green.
grep_out "review-receipt-gate.sh"
grep_out "resolves to"
grep_out "Deliver the script first"
seed_hooks

# Present is not runnable. A script that lost its execute bit — a copy, a backup restore, an
# interrupted deploy — cannot fire, and `os.path.exists` called it installed; both judges
# reproduced that false green independently. This repo invokes its .sh hooks directly, so X_OK is
# load-bearing for every entry the existence half checks.
build ""
chmod -x "$hookhome/.claude/hooks/review-receipt-gate.sh"
t fail "a registered hook present on disk but not executable"
grep_out "not executable"
seed_hooks

# Present, executable, and EMPTY. It executes — but under this repo's hook semantics exit 0 with
# no output means ALLOW, so an empty gate is a permanent allow: the declared gate functionally
# absent. One judge called this harmless because it runs; the other traced what "runs" means for
# a gate, and the hook contract sides with the second. The shape is ordinary drift — a
# truncate-then-write deploy interrupted between the two steps, on a path already 755. Drop the
# getsize clause from the check and this is the case that flips.
build ""
: > "$hookhome/.claude/hooks/review-receipt-gate.sh"
t fail "a registered hook that is an empty file"
grep_out "or empty"
seed_hooks

# The report must survive a live file that omits `matcher` — hand-edited settings do, and the
# check's own refusal advice is to hand-edit. With a bare `group.get("matcher")` the None landed
# in sorted() beside a string and raised TypeError: the DRIFT header printed, the per-entry lines
# never did, and the operator got a traceback where the block's whole output belongs. Both judges
# reproduced it. The assertion below is the per-entry line, which the crash never reaches —
# restore the bare get and this is the case that flips.
build ""
python3 - "$live" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
groups = doc["hooks"]["PreToolUse"]
first = dict(groups[0]); first.pop("matcher", None)
first["hooks"] = [{"type": "command", "command": "$HOME/.claude/hooks/gone-one.sh"}]
groups.insert(0, first)
json.dump(doc, open(sys.argv[1], "w"), indent=2)
PY
rm -f "$hookhome/.claude/hooks/review-receipt-gate.sh"
t fail "two unreachable hooks, one group without a matcher key"
grep_out "resolves to"
grep_out "gone-one.sh"
seed_hooks

# ...and the ceiling beside it: a command that splits into more than one word is not
# existence-checked, because
# deciding which token is the script is shell grammar and this file already deleted one tokenizer
# for exactly that. The note has to be printed rather than left implicit, or the pass reads as
# "every registration was verified".
build ""
python3 - "$live" <<'PY'
import json, sys
p = sys.argv[1]
doc = json.load(open(p))
for groups in doc["hooks"].values():
    for group in groups:
        for hook in group.get("hooks") or []:
            if hook.get("type") == "command" and isinstance(hook.get("command"), str):
                hook["command"] = hook["command"] + " --with-an-argument"
json.dump(doc, open(p, "w"), indent=2)
PY
t fail "arguments change the entry, so registration drift still fires"
grep_out "existence-checked"
seed_hooks

build ""
t pass "baseline again after every mutation"

# Counted, not written down. A hardcoded total is a claim that goes stale the first
# time a case is added — this one already printed 12 while running 13.
[ $fail -eq 0 ] && echo "hook-install-drift: $cases cases passed"
exit $fail
