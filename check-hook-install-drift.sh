#!/usr/bin/env bash
# Every hook the template declares is actually running in the live settings.
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
# ecomono: compares (event, matcher, script) TRIPLES, not basenames, and requires the
# script in EXECUTABLE POSITION — token 0 of the command, or token 1 if token 0 is a
# known interpreter (node/bash/sh/python3/python). That is a question about tokens, not
# about what the command would do: the same class of question this repo already got
# wrong once in the review-receipt-gate's own delivery-detection scan (see
# `docs/DESIGN.md`, "Delivery detection went the other way" and the key-learnings
# postmortem it references) — a text scanner reasoning about meaning keeps passing for
# the wrong reason, and a fifth pattern is not the fix. A leading `$HOME`, `${HOME}` or
# `~` is normalized on both sides so the template's unexpanded path and a fully
# expanded live path compare equal, while a same-named script filed under an unrelated
# tree does not. `disableAllHooks` and `allowManagedHooksOnly` are checked directly and
# fail the run whatever the triples say — both suppress hooks Claude Code itself would
# otherwise fire.
#
# ecomono: still deliberately blind to whether a registered hook would actually run.
# Reading a settings file cannot know: managed-settings precedence over this one,
# hooks a plugin contributes outside this file, or whether a hook that IS wired fires
# and exits zero for a real tool call. A judge measured the way to close that last gap:
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

TEMPLATE="claude/settings.template.json"
LIVE="${ECOMONO_LIVE_SETTINGS:-$HOME/.claude/settings.json}"

[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found" >&2; exit 1; }

if [ ! -f "$LIVE" ]; then
  echo "skip ecomono is not installed here ($LIVE absent) — nothing to compare"
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "skip python3 unavailable"; exit 0; }

python3 - "$TEMPLATE" "$LIVE" <<'PY'
import json, os, sys

INTERPRETERS = {"node", "bash", "sh", "python3", "python"}
HOME = os.environ.get("HOME", "")

def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {path}: {exc}", file=sys.stderr)
        sys.exit(1)

def normalize_path(token):
    """Collapse $HOME, ${HOME}, ~ and an already-expanded $HOME into one spelling.

    So the template's `$HOME/...` and a live file holding either the unexpanded
    string or a fully expanded path compare equal, while a same-named script filed
    under an unrelated tree does not.
    """
    for prefix in ("${HOME}", "$HOME"):
        if token.startswith(prefix):
            return "~" + token[len(prefix):]
    if token.startswith("~"):
        return token
    if HOME and token.startswith(HOME):
        return "~" + token[len(HOME):]
    return token

def invoked_script(command):
    """The token in executable position — token 0, or token 1 behind a known
    interpreter. A question about tokens, not about what the command would do."""
    tokens = [t.replace('"', "").replace("'", "") for t in command.split()]
    if not tokens:
        return None
    first = tokens[0]
    if os.path.basename(first) in INTERPRETERS and len(tokens) > 1:
        return normalize_path(tokens[1])
    return normalize_path(first)

def hook_keys(doc):
    """The set of (event, matcher, if, invoked-script) keys a settings file registers.

    `if` is part of the key, not a detail. `check-diff-size.sh` is registered TWICE
    under the same event and matcher, separated only by its `if:` condition — one per
    delivery shape it guards. Keyed on (event, matcher, script) alone the two collapse
    into one, and dropping either registration reads as fully installed while the gate
    silently stops firing for that shape. Measured on the real live file: deleting one
    of the pair printed `ok`. That is the same defect two judges had just closed one
    dimension up, reappearing here — every dimension the settings file uses to decide
    WHETHER a hook runs has to be part of the key.
    """
    keys = set()
    for event, groups in (doc.get("hooks") or {}).items():
        for group in groups:
            matcher = group.get("matcher", "")
            for hook in group.get("hooks", []):
                command = hook.get("command", "")
                script = invoked_script(command)
                if script:
                    keys.add((event, matcher, hook.get("if", ""), script))
    return keys

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
    for event, matcher, cond, script in missing:
        where = f"event={event} matcher={matcher!r}"
        if cond:
            where += f" if={cond!r}"
        print(f"       {where} script={script}")
    print("       settings.json is seeded once and never overwritten, so a hook added to")
    print("       the template — or moved to a different event/matcher — never arrives.")
    print("       Add it by hand, or the gate it implements is not running on this machine.")
    fail = True

if not fail:
    print(f"ok   all {len(declared)} template hooks are registered live")

sys.exit(1 if fail else 0)
PY
