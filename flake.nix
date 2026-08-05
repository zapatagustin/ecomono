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
      # home-manager module: lays down the same config the install.sh script
      # does, the declarative way. Wire it into your host config with:
      #   inputs.ecomono.url = "github:zapatagustin/ecomono";
      #   imports = [ inputs.ecomono.homeModules.default ];
      homeModules.default =
        { config, pkgs, lib, ... }:
        let
          homeDir = config.home.homeDirectory;
          # A couple of vendored files hardcode the authoring machine's home;
          # rewrite it to the target host so any username works.
          patch = builtins.replaceStrings [ "/home/agustin" ] [ homeDir ];
          readCfg = f: builtins.removeAttrs (builtins.fromJSON (patch (builtins.readFile f))) [ "$schema" ];

          # One skill tree. The vendored third-party skills were forked into
          # agent-skills/ under the ecomono prefix (see NOTICE.md), so the split
          # between a claude-only tree and a shared tree no longer exists.
          claudeSkills = pkgs.runCommand "ecomono-claude-skills" { } ''
            mkdir -p $out
            cp -r ${./agent-skills}/. $out/
          '';
        in
        {
          # bun runs ecomono-memory (opencode plugin + the bundled
          # Claude Code MCP server).
          home.packages = [ pkgs.nodejs pkgs.bun ];

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
            # Same tree Claude gets — one tree, no sync to forget.
            skills = ./agent-skills;
          };

          # Plugin sources are entered one child at a time, never as a single
          # `opencode/plugins` entry, so the directory itself stays writable for
          # the node_modules opencode installs into it at runtime. install.sh
          # does the same thing with link_children, for the same reason.
          #
          # The children are READ from the tree rather than listed, because a
          # hand-written list and install.sh's glob are two answers to one
          # question: a plugin added to opencode/plugins/ and forgotten here
          # ships on Arch and Debian and silently does not exist on NixOS. That
          # is a whole class of drift, and enumerating deletes it instead of
          # needing a check to catch it.
          #
          # Untracked cruft is filtered here rather than left to .gitignore.
          # `builtins.readDir` reads the filesystem at eval time and knows
          # nothing about git: consumed as `github:zapatagustin/ecomono` the
          # source only ever holds committed files, but a host evaluating this
          # module from a local checkout (`home-manager switch --flake .`)
          # copies the working directory verbatim. Reproduced, twice.
          #
          # The filter matches the classes .gitignore already names, not just
          # node_modules — opencode installs deps into exactly this directory at
          # runtime, and home-manager leaves *.hm-bak beside the files it
          # replaces. A first version excluded node_modules alone while the
          # comment claimed the general principle; a judge dropped a .hm-bak and
          # a dotfile in and watched both ship.
          xdg.configFile = {
            "opencode/tui-plugins".source = ./opencode/tui-plugins;
            "opencode/package.json".source = ./opencode/package.json;
          } // lib.mapAttrs' (name: _:
            lib.nameValuePair "opencode/plugins/${name}" {
              source = ./opencode/plugins + "/${name}";
            }) (lib.filterAttrs (name: _:
                  name != "node_modules"
                  && !(lib.hasPrefix "." name)
                  && !(lib.hasSuffix ".hm-bak" name)
                  && !(lib.hasSuffix ".bak" name))
                  (builtins.readDir ./opencode/plugins));

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
              #
              # Registering on absence alone is not enough. The command is two absolute
              # store paths, and both move — the bundle's on any change to storage/*.ts,
              # bun's on a nixpkgs bump. A registration made once then keeps launching
              # the build it was created with, through every later rebuild, which is the
              # stale-bundle failure one level up from the committed file: the artifact
              # is current and the thing pointed at it is not. Compare the paths.
              ecomono_bun=${pkgs.bun}/bin/bun
              ecomono_mcp=${./opencode/plugins/storage/mcp-server.js}
              ecomono_registered="$("$claude" mcp get ecomono-memory 2>/dev/null || true)"
              if ! printf '%s' "$ecomono_registered" | grep -qF "$ecomono_bun" \
                 || ! printf '%s' "$ecomono_registered" | grep -qF "$ecomono_mcp"; then
                if [ -n "$ecomono_registered" ]; then
                  "$claude" mcp remove ecomono-memory >/dev/null 2>&1 || true
                fi
                "$claude" mcp add --scope user ecomono-memory -- "$ecomono_bun" "$ecomono_mcp" \
                  || echo "warning: could not register ecomono-memory mcp"
              fi
            fi
          '';
        };
    };
}
