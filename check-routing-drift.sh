#!/usr/bin/env bash
# claude/hooks/routing.json is the single source of model and effort routing. Everything that
# restates it must agree: each claude/agents/*.md frontmatter (model, effort, maxTurns,
# omitClaudeMd — a key the role lacks must be absent), the orchestrator's model-assignments
# table and tier-up ladder, and the final verdict line the review agents and sdd-verify owe.
# One DRIFT: line per mismatch.
#
# ecomono: frontmatter is read as flat `key: value` lines and table rows as `| `name` | model |
# effort |`; the verdict check is presence of the literal, not of its position in the message.
# Upgrade path: a YAML parser if frontmatter ever nests.

set -uo pipefail
cd "$(dirname "$0")"

rt=claude/hooks/routing.json
orch=agent-skills/ecomono-sdd-shared/sdd-orchestrator.md
for f in "$rt" "$orch"; do
  [ -r "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
done

fail=0
drift() { echo "DRIFT: $*"; fail=1; }
role_of() { jq -r --arg n "$1" '.agents[$n] // empty' "$rt"; }
want() { jq -r --arg r "$1" --arg k "$2" '.roles[$r][$k] // empty' "$rt"; } # absent key -> empty
fm() { awk -v k="$2" '/^---$/{n++; next} n==1 && index($0,k": ")==1{print substr($0,length(k)+3); exit}' "$1"; }
has_all() { local f=$1; shift; for s; do grep -qF "$s" "$f" || return 1; done; }

for f in claude/agents/*.md; do
  name=$(basename "$f" .md); role=$(role_of "$name")
  [ -n "$role" ] || { drift "$name is an agent file but not in $rt agents"; continue; }
  for k in model effort maxTurns omitClaudeMd; do
    w=$(want "$role" "$k"); g=$(fm "$f" "$k")
    [ "$w" = "$g" ] || drift "$name: frontmatter $k is '${g:-absent}', role $role wants '${w:-absent}'"
  done
  case $role:$name in
    review:*) has_all "$f" 'VERDICT: CLEAN' 'VERDICT: ISSUES' || drift "$name: review agent lacks the VERDICT: CLEAN / ISSUES final line" ;;
    *:ecomono-sdd-verify) has_all "$f" 'VERDICT: PASS' 'VERDICT: FAIL' || drift "$name: lacks the VERDICT: PASS / FAIL final line" ;;
  esac
done

for name in $(jq -r '.agents | keys[]' "$rt"); do
  [ -e "claude/agents/$name.md" ] || drift "$name is in $rt agents but has no claude/agents/$name.md"
done

ladder=$(jq -r '.ladder | join(" → ")' "$rt")
grep -qF "\`$ladder\`" "$orch" || drift "ladder: $orch does not contain \`$ladder\`"

table=$(sed -n '/<!-- ecomono:sdd-model-assignments -->/,/<!-- \/ecomono:sdd-model-assignments -->/p' "$orch")
row() { awk -F'|' -v n="\`$1\`" '{for(i=2;i<=4;i++)gsub(/^ +| +$/,"",$i)} $2==n{c++; print $3 " " $4} END{if(c!=1)print "rows=" c+0}' <<<"$table"; }
for name in $(jq -r '.agents | keys[]' "$rt") default; do
  role=$(role_of "$name"); [ "$name" = default ] && role=write
  exp="$(want "$role" model) $(want "$role" effort)"; got=$(row "$name")
  [ "$got" = "$exp" ] || drift "$name: orchestrator table has '${got//$'\n'/ }', $rt wants '$exp'"
done
for name in $(grep -o '^| `[^`]*`' <<<"$table" | tr -d '| `'); do
  [ "$name" = default ] || [ -n "$(role_of "$name")" ] || drift "$name: orchestrator table row for an agent not in $rt"
done

[ $fail -eq 0 ] && echo "ok   routing.json, agent frontmatter and the orchestrator agree"
exit $fail
