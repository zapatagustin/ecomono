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
      # gentle-ai — managed separately (engram removed, now the native memory plugin)
      packages = forAll (pkgs: {
        gentle-ai = pkgs.callPackage ./nix/gentle-ai.nix { };
      });

      # home-manager module: lays down the same config the install.sh script
      # does, the declarative way. Wire it into your host config with:
      #   inputs.ecomono.url = "github:zapatagustin/ecomono";
      #   imports = [ inputs.ecomono.homeModules.default ];
      homeModules.default =
        { config, pkgs, lib, ... }:
        let
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
          # bun runs ecomono-memory (opencode plugin + the bundled
          # Claude Code MCP server).
          home.packages = [ pkgs.nodejs pkgs.bun gentle-ai ];

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
            # Same tree Claude gets. The pre-extraction NixOS layout carried a
            # separate compressed copy for opencode; it held no rules the shared
            # one lacks, only tighter prose, and had already gone stale on the
            # engram -> ecomono-memory rename. One tree, no sync to forget.
            skills = ./skills;
          };

          # Plugin sources kept as individual entries so opencode's plugins/
          # dir stays writable for the node_modules it installs at runtime.
          xdg.configFile = {
            "opencode/plugins/ecomono".source = ./opencode/plugins/ecomono;
            "opencode/plugins/cyndaquill".source = ./opencode/plugins/cyndaquill;
            "opencode/plugins/model-variants.ts".source = ./opencode/plugins/model-variants.ts;
            "opencode/plugins/skill-registry.ts".source = ./opencode/plugins/skill-registry.ts;
            "opencode/plugins/cave-compress.ts".source = ./opencode/plugins/cave-compress.ts;
            "opencode/plugins/memory.ts".source = ./opencode/plugins/memory.ts;
            # ecomono-memory storage core (shared by the plugin + MCP server).
            "opencode/plugins/storage".source = ./opencode/plugins/storage;
            "opencode/tui-plugins".source = ./opencode/tui-plugins;
            "opencode/package.json".source = ./opencode/package.json;
          };

          # Imperative bits Nix can't own: user-scope plugins/MCP live under
          # runtime-managed state, so register them idempotently on activation.
          home.activation.ecomonoAgents = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
            # The activation service does not reliably have the new profile on
            # PATH, so fall back to it explicitly before giving up. Still not a
            # pinned package: `claude` stays bring-your-own.
            claude="$(command -v claude || true)"
            [ -x "$claude" ] || claude="${config.home.profileDirectory}/bin/claude"
            if [ -x "$claude" ]; then
              ensurePlugin() {
                local repo="$1" name="$2" market="''${3:-$2}"
                if ! "$claude" plugin list 2>/dev/null | grep -q "$name"; then
                  "$claude" plugin marketplace add "https://github.com/$repo" >/dev/null 2>&1 || true
                  "$claude" plugin install "$name@$market" || echo "warning: could not install plugin $name"
                fi
              }
              # Retire the superpowers plugin: its four load-bearing process skills
              # now ship from agent-skills/ as ecomono-brainstorm, ecomono-plan,
              # ecomono-tdd and ecomono-debug, under our own guidelines. Leaving it
              # installed costs 15 skill listings plus a
              # SessionStart hook that re-injects a skill-discovery rule CLAUDE.md
              # already states.
              if "$claude" plugin list 2>/dev/null | grep -q superpowers; then
                "$claude" plugin uninstall superpowers@claude-plugins-official >/dev/null 2>&1 || true
              fi
              if ! "$claude" mcp get context7 >/dev/null 2>&1; then
                "$claude" mcp add --scope user context7 -- npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp \
                  || echo "warning: could not register context7 mcp"
              fi
              # Retire the old Gentleman-Programming engram plugin and the MCP
              # entry earlier versions named "engram": both serve the same mem_*
              # tools, so leaving them registered means two memory stores answer
              # at once. Data survives — storage/db.ts imports ~/.engram/engram.db.
              if "$claude" plugin list 2>/dev/null | grep -q engram; then
                "$claude" plugin uninstall engram@engram >/dev/null 2>&1 || true
                "$claude" plugin marketplace remove engram >/dev/null 2>&1 || true
              fi
              "$claude" mcp get engram >/dev/null 2>&1 && "$claude" mcp remove engram >/dev/null 2>&1 || true
              # ecomono-memory: our native bun MCP server (self-contained bundle,
              # runs from the store with no node_modules).
              if ! "$claude" mcp get ecomono-memory >/dev/null 2>&1; then
                "$claude" mcp add --scope user ecomono-memory -- ${pkgs.bun}/bin/bun ${./opencode/plugins/storage/mcp-server.js} \
                  || echo "warning: could not register ecomono-memory mcp"
              fi
            fi
          '';
        };
    };
}
