# gentle-ai — Gentleman-Programming's ecosystem configurator for AI coding
# agents (sub-agents, SDD workflows, skill registry, model routing) targeting
# Claude Code, opencode and others. NOT in nixpkgs, so we install the static
# Go binary from the GitHub release (no deps, runs on NixOS unpatched).
#
# Bump: pick the newest tag from
#   https://github.com/Gentleman-Programming/gentle-ai/releases
# then refresh the hash with:  nix store prefetch-file <tarball url>
{ stdenvNoCC, fetchurl, makeWrapper, writeShellScriptBin }:

let
  # gentle-ai refuses to run on distros it doesn't know (NixOS reads as
  # "unknown"), EXCEPT when brew is on PATH — then any Linux is supported
  # (internal/system/detect.go). Its deps (git/curl/node) come from Nix, so
  # this stub only has to exist; it errors loudly if asked to install.
  brewShim = writeShellScriptBin "brew" ''
    if [ "$1" = "--version" ]; then
      echo "Homebrew 4.6.0 (gentle-ai NixOS shim — packages live in nixos-config)"
      exit 0
    fi
    echo "brew shim: refusing 'brew $*' — install via nixos-config instead" >&2
    exit 1
  '';
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gentle-ai";
  version = "1.49.0";

  src = fetchurl {
    url = "https://github.com/Gentleman-Programming/gentle-ai/releases/download/v${finalAttrs.version}/gentle-ai_${finalAttrs.version}_linux_amd64.tar.gz";
    hash = "sha256-CRH3biJEY2F1jB7OHLJvN//JEkKpirxbEi3pPthaOVQ=";
  };

  # The tarball is flat (binary + LICENSE/README at top level).
  sourceRoot = ".";

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    install -Dm755 gentle-ai $out/bin/gentle-ai
    wrapProgram $out/bin/gentle-ai --suffix PATH : ${brewShim}/bin
    runHook postInstall
  '';

  meta = {
    description = "Ecosystem configurator for AI coding agents (agents, SDD, skills, model routing)";
    homepage = "https://github.com/Gentleman-Programming/gentle-ai";
    mainProgram = "gentle-ai";
    platforms = [ "x86_64-linux" ];
  };
})
