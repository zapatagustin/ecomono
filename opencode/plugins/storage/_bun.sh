# Resolve bun into $BUN. Sourced by the scripts in this dir; not executable.
# bun is often installed outside PATH (~/.bun/bin), the same fallback install.sh
# uses, so a plain `bun` would fail on exactly the machines that have it.
BUN="$(command -v bun 2>/dev/null || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; })"
[ -n "$BUN" ] || { echo "error: bun not found (curl -fsSL https://bun.sh/install | bash)" >&2; exit 1; }

# The version that built the committed mcp-server.js. bun's bundler is not stable
# across releases — a different one re-emits identical sources with cosmetic
# differences, which a byte comparison reports as staleness. Neither install.sh
# (curl | bash) nor flake.nix (pkgs.bun from nixpkgs) pins bun, so the mismatch is
# normal, not a misconfiguration. Bump this line in the same commit as any bundle
# rebuilt with a newer bun.
BUN_BUNDLE_VERSION="1.3.13"
BUN_VERSION="$("$BUN" --version 2>/dev/null)" \
  || { echo "error: '$BUN --version' failed — bun is present but not runnable" >&2; exit 1; }

# Fingerprint of everything the bundle is built from: every non-test .ts in this dir
# and the lockfile that pins the external deps. Recorded at build time in
# BUNDLE_INPUTS, so staleness stays detectable under a bun whose bundler output
# differs byte-wise from the one that built the committed artifact.
#
# Globbed, not listed: a hand-maintained list silently stops covering a source the
# day someone splits a module, which reopens the false pass this fallback exists to
# close. The glob errs the other way — a new non-test .ts that the bundle does not
# actually import still counts, so at worst it asks for a rebuild that changes
# nothing. Over-reporting staleness is the safe direction here.
#
# ecomono: the fingerprint is over source bytes, so a comment-only edit that leaves
# the bundle byte-identical still reads as stale on this path. Deliberate — the
# alternative is parsing bundler output to tell cosmetic from real. Upgrade path:
# bun's --metafile, once the input set justifies it.
BUNDLE_INPUTS="mcp-server.inputs.sha256"
bundle_inputs_hash() {
  local f files=()
  # Plain glob, not $(ls): command substitution word-splits, so a filename with a
  # space would silently become two inputs that both fail the -f check below.
  # LC_ALL=C keeps the expansion order identical across machines — the hash is
  # order-sensitive.
  local prev_lc="${LC_ALL-}"
  LC_ALL=C
  for f in *.ts; do
    case "$f" in test_*.ts) continue ;; esac
    files+=("$f")
  done
  if [ -n "$prev_lc" ]; then LC_ALL="$prev_lc"; else unset LC_ALL; fi
  files+=(../../bun.lock)
  # cat inside a loop feeding a pipeline does not trip errexit — a missing input
  # would just be omitted from the stream, yielding a wrong hash that reports
  # success. Check first, and NUL-delimit so a name can never be read as content.
  for f in "${files[@]}"; do
    [ -f "$f" ] || { echo "error: bundle input missing: $f" >&2; return 1; }
  done
  { for f in "${files[@]}"; do printf '%s\0' "$f"; cat "$f"; printf '\0'; done; } \
    | sha256sum | cut -d' ' -f1
}
