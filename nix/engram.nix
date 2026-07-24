# engram — agent-agnostic persistent memory for AI coding agents (SQLite +
# MCP server, single static Go binary). Same author as gentle-ai, which uses
# it as its memory layer. NOT in nixpkgs, so we install the release binary.
# The data dir (~/.engram) is runtime state, not managed here.
#
# Bump: pick the newest tag from
#   https://github.com/Gentleman-Programming/engram/releases
# then refresh the hash with:  nix store prefetch-file <tarball url>
{ stdenvNoCC, fetchurl }:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "engram";
  version = "1.19.0";

  src = fetchurl {
    url = "https://github.com/Gentleman-Programming/engram/releases/download/v${finalAttrs.version}/engram_${finalAttrs.version}_linux_amd64.tar.gz";
    hash = "sha256-J4oMPlPNw+e6pwZcH7/P9W5q7pMcCtqdmUwOCfkzFgE=";
  };

  # The tarball is flat (binary + LICENSE/README/CHANGELOG at top level).
  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    install -Dm755 engram $out/bin/engram
    runHook postInstall
  '';

  meta = {
    description = "Persistent, agent-agnostic memory for AI coding agents (SQLite + MCP)";
    homepage = "https://github.com/Gentleman-Programming/engram";
    mainProgram = "engram";
    platforms = [ "x86_64-linux" ];
  };
})
