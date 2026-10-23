#!/usr/bin/env bash
# Run every opencode plugin test. Each test_*.ts is a plain assert script (no
# framework), the same shape as the storage suite next door.
#
# They live in this subdirectory rather than beside the plugins because opencode
# discovers every .ts directly under `plugins/` and loads it as a plugin on every
# session start. Subdirectories without an index/server entry are skipped silently
# (storage/ holds nine .ts files and none of them load), so this is the safe place.
set -euo pipefail
cd "$(dirname "$0")"

# Sourced across directories on purpose: bun is often installed outside PATH and
# duplicating that fallback is how the two copies drift.
. ../storage/_bun.sh

fail=0
for t in test_*.ts; do
  # The EPIPE case is a race: one run caught its regression 30 times in 30 on Bun 1.4.2
  # (about 29 in 30 on Bun 1.3.13), and one run still leaves a chance of missing a change
  # that reintroduces pre-spawn work. Five cold runs cost under two seconds and take that
  # chance to nothing. Its own header has the measurements and explains why the file
  # cannot simply be made deterministic.
  case "$t" in test_review_receipt_gate_epipe.ts) reps=5 ;; *) reps=1 ;; esac
  for _ in $(seq "$reps"); do
    "$BUN" run "$t" || { echo "FAIL: $t" >&2; fail=1; break; }
  done
done

exit "$fail"
