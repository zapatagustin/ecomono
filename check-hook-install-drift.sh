#!/usr/bin/env bash
# Every hook the template declares is actually registered in the live settings.
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
# ecomono: this compares two artifacts as sets — the hook COMMANDS the template names
# against the ones the live file names — and makes no judgment about whether either is
# correct or whether a registered hook would do anything useful. That is the shape
# `docs/DESIGN.md` argues survives. It deliberately does not check matchers, ordering,
# statusMessage or timeout: those are edited on purpose per machine, and failing on them
# would train the reader to ignore this. Missing entirely is the failure that was real.
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
import json, sys, re

def hook_commands(path):
    """The set of ~/.claude/hooks/ scripts a settings file registers, by basename.

    Basename, not the whole command: the template writes `$HOME/...` while a live file
    may hold an expanded path, and a `node "$HOME/..."` wrapper puts the script in
    argument position. Comparing raw strings reports drift on two spellings of one hook.
    """
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {path}: {exc}", file=sys.stderr)
        sys.exit(1)
    found = set()
    for entries in (doc.get("hooks") or {}).values():
        for group in entries:
            for hook in group.get("hooks", []):
                command = hook.get("command", "")
                for match in re.finditer(r"\.claude/hooks/([A-Za-z0-9._-]+)", command):
                    found.add(match.group(1))
    return found

template, live = sys.argv[1], sys.argv[2]
declared = hook_commands(template)
installed = hook_commands(live)
missing = sorted(declared - installed)

if missing:
    print(f"DRIFT — {live} is missing {len(missing)} hook(s) the template declares:")
    for name in missing:
        print(f"       {name}")
    print("       settings.json is seeded once and never overwritten, so a hook added to")
    print("       the template after install never arrives. Add them by hand, or the gate")
    print("       they implement is not running on this machine.")
    sys.exit(1)

print(f"ok   all {len(declared)} template hooks are registered live")
PY
