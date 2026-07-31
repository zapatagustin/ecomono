#!/usr/bin/env bash
# The bundle check has two paths, and any given machine only ever takes one. Under
# the pinned bun it byte-compares; under any other bun it falls back to the input
# fingerprint. So on the machine that built the bundle the fallback is dead code a
# regression could break silently — which is how it shipped a false pass the first
# time. This drives the fallback deliberately, in a copy, on any bun.
set -euo pipefail
cd "$(dirname "$0")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# check-bundle.sh resolves ../../bun.lock from its own directory, so mirror that
# depth rather than the repo layout.
work="$tmp/root/plugins/storage"
mkdir -p "$work"
cp ./*.ts ./*.sh mcp-server.js mcp-server.inputs.sha256 "$work/"
cp ../../bun.lock "$tmp/root/bun.lock"

# Force the fallback path: no real bun reports this version.
sed -i 's/^BUN_BUNDLE_VERSION=.*/BUN_BUNDLE_VERSION="0.0.0-test"/' "$work/_bun.sh"

fail=0
# Exit code alone is too weak an assertion: a regression that reintroduces the
# swallowed-missing-input bug still exits 1, just for the wrong reason (the hash
# comes out different rather than the guard firing). So each failing case also has
# to say the right thing.
expect() { # expect <want-exit> <want-message|-> <label>
  local want="$1" msg="$2" label="$3" got=0
  bash "$work/check-bundle.sh" >"$tmp/out" 2>&1 || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "FAIL $label (exit $got, wanted $want)" >&2
    sed 's/^/     /' "$tmp/out" >&2
    fail=1
    return
  fi
  if [ "$msg" != "-" ] && ! grep -qF "$msg" "$tmp/out"; then
    echo "FAIL $label (exit $got as wanted, but never said \"$msg\")" >&2
    sed 's/^/     /' "$tmp/out" >&2
    fail=1
    return
  fi
  echo "ok   $label"
}

expect 0 "bytes not compared" "clean tree passes on the fingerprint path"

cp "$work/observations.ts" "$tmp/held"
printf '\n// drift\n' >> "$work/observations.ts"
expect 1 "is stale" "a changed source fails, though bytes were never compared"
cp "$tmp/held" "$work/observations.ts"

mv "$work/mcp-server.inputs.sha256" "$tmp/held"
expect 1 "no mcp-server.inputs.sha256" "a missing fingerprint fails rather than passing"
mv "$tmp/held" "$work/mcp-server.inputs.sha256"

# A deleted source is not a "missing input" — the glob derives the list from what is
# there, so it simply drops out and the hash moves. That is the right answer (the
# bundle really is stale), and it is why the glob replaced the hardcoded list.
mv "$work/protocol.ts" "$tmp/held"
expect 1 "is stale" "a deleted source reads as drift, not as a pass"
mv "$tmp/held" "$work/protocol.ts"

# The case a hand-maintained list cannot catch and the glob can: someone splits a module
# and the new file is simply not in the list. Every other case here mutates a file that
# already existed, so this is the one that actually distinguishes the two designs.
printf 'export const added = 1\n' > "$work/newmodule.ts"
expect 1 "is stale" "a newly added source is covered, not silently omitted"
rm "$work/newmodule.ts"

# The -f guard's reachable trigger is the one input the glob does not discover.
mv "$tmp/root/bun.lock" "$tmp/held"
expect 1 "bundle input missing" "a missing lockfile fails loudly instead of hashing without it"
mv "$tmp/held" "$tmp/root/bun.lock"

expect 0 "bytes not compared" "restored tree passes again"

# The other way into the fingerprint: bun matches the pin, so the version branch is not
# taken, but deps cannot be resolved to rebuild with. That is the read-only vendored copy
# the script's header names. A stub bun reports the pinned version and fails `install`,
# which reaches the branch without a network round-trip.
stub="$tmp/stub"
mkdir -p "$stub"
# From the real _bun.sh: $work's copy already carries the forced mismatch.
pinned="$(sed -n 's/^BUN_BUNDLE_VERSION="\([^"]*\)".*/\1/p' ./_bun.sh)"
[ -n "$pinned" ] || { echo "FAIL could not read BUN_BUNDLE_VERSION from _bun.sh" >&2; exit 1; }
cat > "$stub/bun" <<STUB
#!/usr/bin/env bash
[ "\$1" = "--version" ] && { echo "$pinned"; exit 0; }
[ "\$1" = "install" ] && exit 1
exit 1
STUB
chmod +x "$stub/bun"
# _bun.sh resolves bun from PATH, and $work/_bun.sh still carries the forced mismatch.
sed -i "s/^BUN_BUNDLE_VERSION=.*/BUN_BUNDLE_VERSION=\"$pinned\"/" "$work/_bun.sh"
deps_out="$tmp/deps-out"
if PATH="$stub:$PATH" bash "$work/check-bundle.sh" >"$deps_out" 2>&1; then
  if grep -qF "deps unavailable" "$deps_out"; then
    echo "ok   deps that cannot be installed fall back to the fingerprint, not a skip"
  else
    echo "FAIL deps branch passed without saying why" >&2; sed 's/^/     /' "$deps_out" >&2; fail=1
  fi
else
  echo "FAIL deps branch should have passed on an unchanged tree" >&2; sed 's/^/     /' "$deps_out" >&2; fail=1
fi

printf 'export const drift = 1\n' >> "$work/tools.ts"
if PATH="$stub:$PATH" bash "$work/check-bundle.sh" >"$deps_out" 2>&1; then
  echo "FAIL deps branch passed a genuinely stale tree" >&2; sed 's/^/     /' "$deps_out" >&2; fail=1
else
  if grep -qF "is stale" "$deps_out"; then
    echo "ok   and still fails on real drift when deps are unavailable"
  else
    echo "FAIL deps branch failed for the wrong reason" >&2; sed 's/^/     /' "$deps_out" >&2; fail=1
  fi
fi
sed -i '/^export const drift = 1$/d' "$work/tools.ts"

# The fingerprint skips test_*.ts on the assumption that nothing the bundle imports
# carries that prefix. The prefix is a convention, not a rule, so check the assumption
# rather than trusting it: a real source named test_something.ts would drop silently
# out of the fingerprint and take its drift with it.
if grep -l 'from "\./test_' ./*.ts 2>/dev/null | grep -qv '^\./test_'; then
  echo "FAIL a bundled source imports a test_* module, which the fingerprint excludes" >&2
  grep -ln 'from "\./test_' ./*.ts | grep -v '^\./test_' | sed 's/^/     /' >&2
  fail=1
else
  echo "ok   nothing bundled is named test_* (the fingerprint's exclusion holds)"
fi

exit "$fail"
