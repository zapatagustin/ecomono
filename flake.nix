{
  description = "ecomono — portable Claude Code + opencode config (Arch/Debian/NixOS)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      # The two custom Go binaries, so `nix run` / overlays can reach them too.
      packages = forAll (pkgs: {
        engram = pkgs.callPackage ./nix/engram.nix { };
        gentle-ai = pkgs.callPackage ./nix/gentle-ai.nix { };
      });

      # home-manager module: lays down the same config the install.sh script
      # does, the declarative way. Wire it into your host config with:
      #   inputs.ecomono.url = "github:zapataagustin/ecomono";
      #   imports = [ inputs.ecomono.homeModules.default ];
      homeModules.default =
        { config, pkgs, lib, ... }:
        let
          engram = pkgs.callPackage ./nix/engram.nix { };
          gentle-ai = pkgs.callPackage ./nix/gentle-ai.nix { };

          homeDir = config.home.homeDirectory;
          # A couple of vendored files hardcode the authoring machine's home;
          # rewrite it to the target host so any username works.
          patch = builtins.replaceStrings [ "/home/agustin" ] [ homeDir ];
          readCfg = f: builtins.removeAttrs (builtins.fromJSON (patch (builtins.readFile f))) [ "$schema" ];

          # ~/.claude/skills as ONE store dir: claude-only skills + the shared
          # agent-skills merged, so the whole tree resolves under a single link.
          claudeSkills = pkgs.runCommand "ecomono-claude-skills" { } ''
            mkdir -p $out
            cp -r ${./skills}/. $out/
            cp -r ${./agent-skills}/. $out/
          '';
        in
        {
          home.packages = [ pkgs.nodejs engram gentle-ai ];

          programs.claude-code = {
            enable = true;
            # Bring your own claude binary; manage config only.
            package = null;
            context = ./claude/CLAUDE.md;
          };

          # settings.json is intentionally NOT managed: Claude Code rewrites it
          # at runtime. Seed it once from claude/settings.template.json.
          home.file = {
            ".claude/agents".source = ./claude/agents;
            ".claude/commands".source = ./claude/commands;
            ".claude/hooks".source = ./claude/hooks;
            ".claude/output-styles".source = ./claude/output-styles;
            ".claude/themes".source = ./claude/themes;
            ".claude/skills".source = claudeSkills;
            ".agents/skills".source = ./agent-skills;
          };

          programs.opencode = {
            enable = true;
            settings = readCfg ./opencode/opencode.json;
            tui = readCfg ./opencode/tui.json;
            context = ./opencode/AGENTS.md;
            commands = ./opencode/commands;
          };

          # Plugin sources kept as individual entries so opencode's plugins/
          # dir stays writable for the node_modules it installs at runtime.
          xdg.configFile = {
            "opencode/plugins/ecomono".source = ./opencode/plugins/ecomono;
            "opencode/plugins/cyndaquill".source = ./opencode/plugins/cyndaquill;
            "opencode/plugins/model-variants.ts".source = ./opencode/plugins/model-variants.ts;
            "opencode/plugins/skill-registry.ts".source = ./opencode/plugins/skill-registry.ts;
            "opencode/plugins/cave-compress.ts".source = ./opencode/plugins/cave-compress.ts;
            "opencode/plugins/engram.ts".source = ./opencode/plugins/engram.ts;
            "opencode/tui-plugins".source = ./opencode/tui-plugins;
            "opencode/package.json".source = ./opencode/package.json;
          };

          # Imperative bits Nix can't own: user-scope plugins/MCP live under
          # runtime-managed state, so register them idempotently on activation.
          home.activation.ecomonoAgents = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
            claude="$(command -v claude || true)"
            if [ -n "$claude" ]; then
              ensurePlugin() {
                local repo="$1" name="$2" market="''${3:-$2}"
                if ! "$claude" plugin list 2>/dev/null | grep -q "$name"; then
                  "$claude" plugin marketplace add "https://github.com/$repo" >/dev/null 2>&1 || true
                  "$claude" plugin install "$name@$market" || echo "warning: could not install plugin $name"
                fi
              }
              ensurePlugin Gentleman-Programming/engram engram
              ensurePlugin anthropics/claude-plugins-official superpowers claude-plugins-official
              if ! "$claude" mcp get context7 >/dev/null 2>&1; then
                "$claude" mcp add --scope user context7 -- npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp \
                  || echo "warning: could not register context7 mcp"
              fi
            fi
            # engram <= 0.1.1 ships #!/bin/bash hooks, absent on NixOS — patch them.
            find "$HOME/.claude/plugins/cache/engram" -name '*.sh' \
              -exec ${pkgs.gnused}/bin/sed -i '1s|^#!/bin/bash$|#!/usr/bin/env bash|' {} + 2>/dev/null || true
            if ${engram}/bin/engram --help >/dev/null 2>&1 && ! grep -rqs engram "$HOME/.config/opencode"; then
              ${engram}/bin/engram setup opencode || echo "warning: engram setup opencode failed"
            fi
          '';
        };
    };
}
