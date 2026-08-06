#!/usr/bin/env bash
# Every hook the template declares is registered in the live settings. Registered, not
# running — see the ceiling below. An earlier revision of this line said "running", which
# is the overclaim this whole file exists to argue against, and two review rounds read past
# it. Corrected on the third.
#
# This exists because the gap it checks for shipped silently and stayed hidden for
# days. `claude/settings.template.json` is the source of truth for which hooks should
# run, but it is only ever a SEED: install.sh writes it once and then refuses to touch
# it ("settings.json is runtime-mutated by Claude Code — seed once, never overwrite"),
# and flake.nix declines to manage it for the same reason. So a hook added to the
# template after a machine was set up reaches that machine never, with no error and no
# sign — the template says the gate exists, the runtime has no such hook, and nothing
# compares them.
#
# It was found the worst way available. `review-receipt-gate.sh` was written, reviewed
# over four rounds, armed with a marker, and confirmed refusing a push — by running the
# script BY HAND. Its hook was never in the live settings, so a real `git push` sailed
# through an armed repository. Verifying the mechanism is not verifying the wiring, and
# a marker file sitting next to receipts reads exactly like protection while providing
# none.
#
# The first version of this check compared a flat set of script basenames found
# anywhere in any command string, and ignored matchers as "per-machine customization".
# Two blind judges reproduced, against a copy of the live settings, four ways that
# shape prints `ok` while the declared gate does not run: the script registered under
# the wrong EVENT (`Notification` instead of `PreToolUse`), the same script under a
# MATCHER that never fires for the tool it is meant to gate, the script named only in
# a disabling comment (`true # was .../foo.sh, disabled pending fix`), and
# `disableAllHooks: true` set alongside every entry still present. The matcher
# justification was wrong for this hook family; dropped.
#
# ecomono: compares WHOLE HOOK ENTRIES, keyed by (event, matcher, the entry itself), not
# a tuple of fields chosen by hand. Two earlier designs picked fields — first a bare
# script basename, then (event, matcher, if, script) — and successive review rounds kept
# finding fields neither key contained, each one a way to print `ok` while a declared
# hook was not running. Every one was the same mistake: forgetting a field that decides
# whether a hook fires produced a false PASS. Comparing the entry makes forgetting
# impossible, and inverts the failure mode — an unmodelled difference now reports drift,
# which is noisy and visible rather than silent and wrong. `IGNORED_FIELDS` is the
# opt-out and it is two names long. hook_keys carries the full argument.
#
# No count here on purpose. Earlier revisions of this comment kept a running tally of
# defects found, and it was wrong three times — miscounted, then padded with an item
# that had never actually failed. A number maintained by hand in prose is the same
# object as a key maintained by hand in code: it rots silently and nobody notices. The
# history is in `git log -p` on this file and the narrative is in `docs/DESIGN.md`; both
# are derived from something, which this sentence is not.
#
# It also deleted a tokenizer. "Which token is the script" is a question about shell
# grammar, several of the defects lived in the `str.split` that answered it, and this
# repo has the same postmortem already written for the review-receipt-gate's delivery
# scan (see `docs/DESIGN.md`, "Delivery detection went the other way"). Nothing here
# parses a command now.
#
# ecomono: ONE-DIRECTIONAL, deliberately. It reports what the template declares and the
# live file lacks, never the reverse. An extra live hook is usually a local addition and
# not this check's business — but a hook RETIRED from the template is a different story,
# and this repo retires them routinely (the gentle-ai skill-registry hook, the caveman
# plugin). Because settings.json is seeded once and never overwritten, a retired hook
# stays wired and firing forever, and nothing here will say so. That is a known gap in
# the opposite direction from the one this file was built for, recorded rather than
# closed because reporting every local addition as drift is how a check gets ignored.
#
# `disableAllHooks` and `allowManagedHooksOnly` are checked directly and fail the run
# whatever the entries say — both suppress hooks Claude Code would otherwise fire.
#
# ecomono: still deliberately blind to whether a registered hook would actually run.
# Reading ONE settings file cannot know: precedence from the other layers Claude Code
# merges — project `.claude/settings.json`, `.claude/settings.local.json`, flag and
# managed/policy settings, all confirmed real in the installed binary — hooks a plugin
# contributes outside any of them, or whether a hook that IS wired fires and exits zero
# for a real tool call. A judge measured the way to close that last gap:
# `claude -p "<probe>" --output-format stream-json --include-hook-events` emits a real
# `hook_started` per hook that actually fired — genuine ground truth, but it costs a
# model turn per run, so it belongs in an occasional manual check or a CI smoke test,
# not in this script.
#
# ecomono: it skips rather than fails when there is no live settings file, because a
# fresh clone and CI both legitimately have none. That is a silent pass on the machine
# least likely to need the check, which is the honest tradeoff — the check is for an
# installed machine drifting from the repo it was installed from.
set -uo pipefail
cd "$(dirname "$0")"

# Both sides are overridable for tests. The live seam alone was not enough: the defect
# where an interpreter flag is mistaken for the script only shows when BOTH sides use
# that shape, and with the template pinned to the real file the fixture passed for the
# wrong reason — the keys differed anyway. A test that cannot express the failure cannot
# guard against it.
TEMPLATE="${ECOMONO_TEMPLATE_SETTINGS:-claude/settings.template.json}"
LIVE="${ECOMONO_LIVE_SETTINGS:-$HOME/.claude/settings.json}"

[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found" >&2; exit 1; }

if [ ! -f "$LIVE" ]; then
  echo "skip ecomono is not installed here ($LIVE absent) — nothing to compare"
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "skip python3 unavailable"; exit 0; }

python3 - "$TEMPLATE" "$LIVE" <<'PY'
import json, os, sys

HOME = os.environ.get("HOME", "")

# Cosmetic per-hook fields, excluded from the comparison BY NAME so the exclusion is
# visible and short. Everything not listed here is compared. That direction is the whole
# point of this rewrite — see hook_keys.
IGNORED_FIELDS = ("statusMessage", "timeout")

def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {path}: {exc}", file=sys.stderr)
        sys.exit(1)

def normalize_home(text):
    """One spelling for the home directory, whichever way a file spells it.

    The template writes `$HOME/...`; a live file may hold that, `${HOME}/...`, `~/...`,
    or a fully expanded absolute path. All four mean the same location and must compare
    equal, while a same-named script under an unrelated tree must not.
    """
    if not isinstance(text, str):
        return text
    for spelling in ("${HOME}", "$HOME"):
        text = text.replace(spelling, "~")
    if HOME:
        text = text.replace(HOME, "~")
    return text

def canonical(hook):
    """A hook entry reduced to a comparable form: every field kept except the cosmetic
    ones, key order irrelevant."""
    kept = {k: v for k, v in hook.items() if k not in IGNORED_FIELDS}
    return json.dumps(kept, sort_keys=True, default=str)

def hook_keys(doc):
    """The set of (event, matcher, whole-hook) keys a settings file registers.

    THIS COMPARES THE ENTIRE HOOK ENTRY, not a tuple of fields picked by hand, and that
    inversion is the point. Three review rounds found TEN ways the hand-picked version
    printed `ok` while a declared hook was not running: wrong event, wrong matcher, the
    script named inside a disabling comment, a same-named script in another tree, the two
    kill switches, a lost `if:` variant, a non-`command` `type` with a stale command
    string, an interpreter flag mistaken for the script, a quoted path containing a space
    collapsing two scripts into one key, and an `args` exec-form entry invisible on both
    sides. Every one was the same mistake: a field that decides whether a hook runs was
    not in the key, so forgetting it produced a false PASS.

    Comparing the whole entry makes forgetting impossible by construction. `type`, `if`,
    `args`, `once`, `async`, and any field a future release adds are all in the key with
    NO DEDICATED BRANCH for any of them — naming them here is describing the effect, not
    implementing it, and deleting this paragraph would change nothing about what is
    compared. (An earlier version of this claim said such fields were "never named
    anywhere in the check", which was false in three files at once, this one included.) The failure mode inverts with it: an
    unmodelled difference now reports drift — noisy, visible, and safe — instead of
    certifying a gate that is not there. `IGNORED_FIELDS` is the opt-out, and it is two
    names long and in plain sight, which is the opposite of a tuple whose omissions are
    invisible.

    It also deleted the tokenizer. Extracting "the script" from a command string was a
    question about shell grammar answered with `str.split`, and four of the ten defects
    lived in it. Nothing here parses a command any more; two commands are the same
    command when their text matches after the home directory is spelled one way.
    """
    keys = set()
    for event, groups in (doc.get("hooks") or {}).items():
        for group in groups:
            matcher = group.get("matcher", "")
            for hook in group.get("hooks", []):
                keys.add((event, matcher, canonical(normalize_tree(hook))))
    return keys

def normalize_tree(value):
    """normalize_home applied through nested lists and dicts, so a path inside `args`
    normalizes the same way one inside `command` does."""
    if isinstance(value, dict):
        return {k: normalize_tree(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize_tree(v) for v in value]
    return normalize_home(value)

template_path, live_path = sys.argv[1], sys.argv[2]
template_doc, live_doc = load(template_path), load(live_path)

fail = False

for flag, meaning in (
    ("disableAllHooks", "suppresses every hook, managed or not"),
    ("allowManagedHooksOnly", "suppresses every user-configured hook"),
):
    if live_doc.get(flag) is True:
        print(f"DRIFT — {live_path} sets \"{flag}\": true, which {meaning}")
        print("       whatever the registered hooks say, none of them are running.")
        fail = True

declared = hook_keys(template_doc)
installed = hook_keys(live_doc)
missing = sorted(declared - installed)

if missing:
    print(f"DRIFT — {live_path} is missing {len(missing)} hook(s) the template declares:")
    for event, matcher, entry in missing:
        # The whole entry is printed, not a summary of it. The operator has to add this
        # by hand, and a summary would omit exactly the field that differs — which is
        # the mistake the key itself just stopped making.
        print(f"       event={event} matcher={matcher!r} hook={entry}")
    print("       settings.json is seeded once and never overwritten, so a hook added to")
    print("       the template — or moved to a different event/matcher — never arrives.")
    print("       Add it by hand, or the gate it implements is not running on this machine.")
    fail = True

if not declared:
    # An empty declared set makes `declared - installed` empty too, so every check below
    # passes vacuously. Reachable by pointing either env seam at a file with no hooks —
    # most plausibly a human who exported one while debugging this script and forgot to
    # unset it before running check.sh for real. A technically-true `ok 0` on a check
    # whose entire subject is false confidence is the one output it must never produce.
    print(f"error: {template_path} declares no hooks — refusing to report a vacuous pass",
          file=sys.stderr)
    sys.exit(1)

if not fail:
    print(f"ok   all {len(declared)} template hook registrations are present live")

sys.exit(1 if fail else 0)
PY
