#!/usr/bin/env bash
# Claude Code statusline: model + plan usage (5h/7d windows).
# Reads the statusline JSON contract from stdin; rate_limits fields are
# absent on API-key auth and before the session's first API response.
set -euo pipefail

IFS=$'\t' read -r model p5 r5 p7 r7 < <(jq -r '
  [(.model.display_name // "?"),
   (.rate_limits.five_hour.used_percentage // "-"),
   (.rate_limits.five_hour.resets_at // "-"),
   (.rate_limits.seven_day.used_percentage // "-"),
   (.rate_limits.seven_day.resets_at // "-")] | @tsv')

# ANSI: green <50, yellow <80, red >=80
pct() {
  local p; p=$(LC_ALL=C printf '%.0f' "$1")
  local c
  if ((p >= 80)); then c="31"; elif ((p >= 50)); then c="33"; else c="32"; fi
  printf '\033[%sm%s%%\033[0m' "$c" "$p"
}

out="$model"
[ "$p5" != "-" ] && out="$out \033[2m|\033[0m 5h $(pct "$p5")"
[ "$r5" != "-" ] && out="$out \033[2m→$(date -d "@$r5" +%H:%M)\033[0m"
[ "$p7" != "-" ] && out="$out \033[2m|\033[0m 7d $(pct "$p7")"
[ "$r7" != "-" ] && out="$out \033[2m→$(date -d "@$r7" +'%a %H:%M')\033[0m"

echo -e "$out"
