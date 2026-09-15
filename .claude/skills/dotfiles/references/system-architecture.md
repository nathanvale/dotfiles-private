# System Architecture Reference

Deep dive on the dotfiles system architecture: environment variables, symlinks,
profiles, state management, and setup.sh phases.

---

## Repository Layout

```
~/code/dotfiles/                         # Public repo (this repo)
+-- .zshrc, .zprofile, .gitconfig, ...   # Root dotfiles (symlinked from $HOME)
+-- setup.sh                             # 7-phase installer (848 lines)
+-- bin/                                 # Scripts added to $PATH
|   +-- dotfiles/symlinks/               # Symlink manager
|   +-- env/                             # Docker MCP env sync (sync-docker-mcp)
|   +-- tmux/                            # Tmux utilities (tx launcher)
|   +-- utils/                           # Shared utilities (colour_log.sh)
|   +-- vault/                           # Vault utilities
+-- config/                              # XDG configs (symlinked as ~/.config)
|   +-- brew/Brewfile                    # Profile-conditional package manifest
|   +-- tmux/                            # Tmux config + Night Owl theme
|   +-- tmuxinator/                      # Universal session templates
|   +-- karabiner/                       # Keyboard remapping (Hyper key)
|   +-- ghostty/                         # Terminal emulator
|   +-- superwhisper/                    # Voice dictation modes
|   +-- vscode/                          # VS Code settings, MCP config
|   +-- macos/                           # macOS preference scripts
+-- apps/                                # Major standalone apps
|   +-- hyperflow/                       # Hyper key orchestration
|   +-- taskdock/                        # Task management + git worktrees
+-- .claude/                             # Claude Code project config
    +-- commands/, agents/, skills/, rules/
```

---

## Environment Variables

### PATH Precedence (order in .zshrc, later = higher priority)

1. `/usr/bin`, `/bin` -- system
2. `/usr/local/bin` -- user installs
3. `/Applications/Docker.app/.../bin` -- Docker
4. `$PNPM_HOME/bin` (`~/.local/share/pnpm`) -- pnpm
5. `$BUN_INSTALL/bin` (`~/.bun`) -- Bun
6. `$HOME/.local/bin` -- user local
7. `~/code/dotfiles/bin/*` -- dotfiles scripts (6 subdirs added individually)
8. `~/.local/share/fnm/aliases/default/bin` -- fnm Node
9. `/opt/homebrew/bin` -- Homebrew (last = highest priority)

### .env File Hierarchy

| File | Committed? | Purpose | Example content |
|------|-----------|---------|-----------------|
| `~/code/dotfiles/.env` | No, git-ignored, mode 0600 | Service-account token; never sourced into a shell | `OP_SERVICE_ACCOUNT_TOKEN=...` |
| `~/code/<slug>-dotfiles/profile.zsh` | No (private repo) | Work env vars | `export WORK_EMAIL=...` |

No file holds a projected set of secret values. Delivery lanes for keys,
logins, cards, and profiles:
[sensitive-material-access.md](sensitive-material-access.md).

Shell startup sources no credential and no env file of values. The startup files
own what each one loads and why; `bin/test/zsh-startup-silence-test.sh` and
`bin/test/codex-ambient-credential-boundary-test.sh` are the contracts.

### Key Exports

| Variable | Value | Purpose |
|----------|-------|---------|
| `XDG_CONFIG_HOME` | `$HOME/.config` | XDG base directory |
| `HOMEBREW_BUNDLE_FILE` | `$HOME/.config/brew/Brewfile` | Brew bundle default |
| `BAT_THEME` | `Night Owl` | Bat syntax theme |
| `PAGER` | `bat` | Default pager |
| `LANG` | `en_AU.UTF-8` | Australian English |

`.zshrc` deliberately sets no `CDPATH` and no `FNM_STRICT`; each says why at its
own site. Contract: `bin/test/zsh-effective-behavior-test.sh`.

---

## Symlink Strategy

### Core Principle

Dotfiles live in `~/code/dotfiles/`. Symlinks point from where macOS/apps expect
them to the repo. This means `git diff` shows changes, and `git pull` updates everything.

### Full Symlink Table

Managed by `bin/dotfiles/symlinks/symlinks_manage.sh`:

| Symlink | Target | Category |
|---------|--------|----------|
| `~/.zshrc` | `$DOTFILES/.zshrc` | Shell |
| `~/.zprofile` | `$DOTFILES/.zprofile` | Shell |
| `~/.gitconfig` | `$DOTFILES/.gitconfig` | Git |
| `~/.gitignore_global` | `$DOTFILES/.gitignore_global` | Git |
| `~/.gitmessage` | `$DOTFILES/.gitmessage` | Git |
| `~/.config` | `$DOTFILES/config` | XDG (entire dir) |
| `~/bin` | `$DOTFILES/bin` | Scripts |
| `~/Scripts` | `$DOTFILES/Scripts` | Automation |
| `~/.tmux.conf` | `$DOTFILES/config/tmux/tmux.conf` | Tmux |
| VS Code settings.json | `$DOTFILES/config/vscode/settings.json` | VS Code |
| VS Code tasks.json | `$DOTFILES/config/vscode/tasks.json` | VS Code |
| VS Code keybindings.json | `$DOTFILES/config/vscode/keybindings.json` | VS Code |
| VS Code prompts | `$DOTFILES/config/vscode/prompts` | VS Code |
| VS Code mcp.json | `$DOTFILES/config/vscode/mcp.json` | VS Code |
| `~/Documents/superwhisper` | `$DOTFILES/config/superwhisper` | Apps |

VS Code path: `~/Library/Application Support/Code/User/`

### Script Modes

```bash
symlinks_manage.sh --link          # Create all
symlinks_manage.sh --unlink        # Remove all
symlinks_manage.sh --status        # Show colored status table
symlinks_manage.sh --link --dry-run  # Preview changes
symlinks_manage.sh --link --force    # Replace existing files (creates backups)
```

---

## Git Configuration

`.gitconfig` separates two audiences, and each setting says why at its own site.

- **Unattended runs** get deterministic behavior: a command's explicit request
  survives, and a command that would need a human blocks rather than hangs.
- **Human presentation** lives in the aliases a person types, not in defaults
  that would silently rewrite what an unattended command asked for.

Read the file before changing a default; a presentation default and an
unattended guarantee can be the same knob. Contract:
`bin/test/git-effective-behavior-test.sh`.

---

## Machine Profiles

### Two Independent Concerns

| Concern | Where stored | When it matters |
|---------|-------------|-----------------|
| Machine type (desktop/server) | `~/.dotfiles_state/profile` | Install-time: brew bundle, macOS prefs |
| Employer layer | Work-profile slug in machine state | Runtime: `.zshrc` loads `profile.zsh` |

### Profile Selection

`setup.sh` accepts `--desktop` or `--server`. If neither provided (interactive mode),
it prompts. The profile is saved to `~/.dotfiles_state/profile` and used by:

- `brew bundle` (via `HOMEBREW_DOTFILES_PROFILE`)
- macOS preference script (`defaults.common.sh`)
- Verification script (`verify_install.sh`)

---

## setup.sh Deep Dive

### Invocation

```bash
./setup.sh                    # Interactive (prompts for profile)
./setup.sh --desktop          # Desktop workstation
./setup.sh --server           # Headless server
./setup.sh --resume           # Resume from last checkpoint
./setup.sh --start-phase N    # Start from phase N
./setup.sh symlinks           # Just create symlinks
./setup.sh prefs              # Just apply macOS preferences
./setup.sh status             # Show symlink status
./setup.sh verify             # Run verification
```

### Curl | Bash Safety

The script uses a `main()` wrapper to ensure the entire file is parsed before execution.
This prevents partial execution if the download is interrupted.

Non-interactive mode requires explicit `--desktop` or `--server` flag for safety.

### Checkpoint System

State stored in `~/.dotfiles_state/`:
- `checkpoint` file stores last completed phase number
- `history` file logs phase completion timestamps
- `--resume` flag reads the checkpoint and starts from next phase
- Each phase is independently resumable

### Verification

`setup.sh verify` (or `verify_install.sh`) runs post-install checks:
- Per-phase verification with collapsed output
- Counts: PASS, FAIL, WARN
- Actionable recap with fixes for each failure
- Modes: normal (summary), `--quiet` (failures only), `--verbose` (every check)
