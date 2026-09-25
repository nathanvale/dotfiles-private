# Nathan's Dotfiles

A comprehensive macOS development environment setup featuring terminal tools, keyboard orchestration, and productivity extensions.

## Quick Start (Fresh Mac)

**One-liner:**
```bash
curl -fsSL https://raw.githubusercontent.com/nathanvale/dotfiles-private/main/setup.sh | bash -s -- --desktop
```

**Or step by step:**
```bash
# 1. Clone the repo
git clone git@github.com:nathanvale/dotfiles-private.git ~/code/dotfiles
cd ~/code/dotfiles

# 2. Run the selected profile (use --server for the server profile)
./setup.sh --desktop
```

**Update existing installation:**
```bash
cd ~/code/dotfiles
git pull
./setup.sh symlinks   # Recreate symlinks
./setup.sh prefs      # Reapply macOS preferences
```

## What Gets Installed

### setup.sh (7 phases)
- **Phase 0:** Preflight checks (macOS, arch, network, disk)
- **Phase 1:** Xcode CLT + Homebrew + repo clone
- **Phase 2:** Native Claude Code + managed Codex CLIs (AI rescue)
- **Phase 3:** 16+ essential CLI tools (git, tmux, fzf, ripgrep, etc.)
- **Phase 4:** Retained fallback runtimes plus one verified Mise toolchain apply
- **Phase 5:** Profile package bundle from `config/brew/Brewfile`; failures stop setup
- **Phase 6:** Symlinks for dotfiles, plus macOS preferences on the desktop profile. The server profile skips interactive macOS preferences.

Supports `--resume` to pick up where it left off and `--start-phase N` to skip ahead.

The Brewfile owns desktop applications, not the Claude Code or Codex CLIs.
After setup, run `claude` and `codex` once to complete interactive sign-in.

## Features

- **HyperFlow**: Hyper key (Right Cmd) orchestration for app switching and keyboard shortcuts
- **Terminal**: Custom tmux config with Night Owl theme, Ctrl-g prefix
- **Shell**: Zsh with syntax highlighting, autosuggestions, and fzf
- **Git**: Lazygit, delta for diffs, conventional commits
- **Productivity**: Raycast, Karabiner-Elements, SuperWhisper voice dictation

## Key Bindings

| Key | Action |
|-----|--------|
| `Ctrl-g` | tmux prefix |
| `Hyper+1-5` | Switch to workspace apps |
| `Hyper+H/J/K/L` | Arrow navigation (Vim-style) |
| `Hyper+\\` | Cycle tmux sessions |

## Project Structure

```
~/code/dotfiles/
├── setup.sh              # Unified installer (full setup + subcommands)
├── verify_install.sh     # Post-install verification
├── config/               # All configuration files
│   ├── brew/Brewfile     # Homebrew packages
│   ├── tmux/             # Tmux configuration
│   ├── karabiner/        # Keyboard remapping
│   ├── vscode/           # VS Code settings
│   ├── agents/claude/    # Claude Code settings
│   └── ...
├── bin/                  # Scripts and utilities
│   ├── dotfiles/         # Symlink management
│   └── ...
└── .zshrc, .gitconfig    # Root dotfiles
```

## Symlinks Created

| Link | Target |
|------|--------|
| `~/.config` | `dotfiles/config` |
| `~/.zshrc` | `dotfiles/.zshrc` |
| `~/.gitconfig` | `dotfiles/.gitconfig` |
| `~/.bunfig.toml` | `dotfiles/config/bun/bunfig.toml` |
| `~/.tmux.conf` | `dotfiles/config/tmux/tmux.conf` |
| `~/.claude/CLAUDE.md` | `dotfiles/config/agents/claude/CLAUDE.md` |
| `~/bin` | `dotfiles/bin` |
| VS Code settings | `dotfiles/config/vscode/` |

Run `./setup.sh status` to see all symlinks and their status.

## Post-Install

1. **Restart terminal** or `source ~/.zshrc`
2. **Check credential custody**: run `bin/with-one-password-token check`, follow its attended repair route, then let each capability inject only its named credential into its child process. See [scoped credential access](.claude/skills/dotfiles/references/sensitive-material-access.md).
3. **Start tmux**: `tmux` or use tmuxinator projects

## Customization

### Add Homebrew packages
```bash
# Edit config/brew/Brewfile
brew "new-package"
cask "new-app"

# Then apply and verify the selected profile
HOMEBREW_DOTFILES_PROFILE=desktop brew bundle --file=config/brew/Brewfile
HOMEBREW_DOTFILES_PROFILE=desktop brew bundle check --file=config/brew/Brewfile
```

### Toolchain ownership

Mise is the selected source owner for Node 26.9.0, Bun 1.4.0, and Python
3.11.9. npm 11.19.1 declares Node as its parent. This
canonical source declaration is inert until a verified revision is explicitly
applied. Setup now declares and installs Mise, publishes one verified applied
revision, and configures terminals and Git hooks to select it. Those repository
changes are implemented and hermetically tested; this checkout does not by
itself prove that the laptop has been installed, activated, or live-qualified.
fnm, pyenv, and Homebrew remain installed fallbacks during that qualification,
so do not treat a Homebrew update as a selected-runtime update.

Check the current Node, Bun, Python, Git, and npm baseline without changing the machine:

```bash
bin/dotfiles/toolchain status --json
bin/dotfiles/toolchain update --preview --json
```

Apply a reviewed revision deliberately; this changes the selected machine toolchain:

```bash
bin/dotfiles/toolchain update --apply --json
```

The check reports declared, selected-owner, observed-owner, and effective
values separately. npm reports Node as its declared parent with the declared
Node version and selected owner only. Live parent-runtime observation remains a
future gap. Git's exact owner is still unresolved, so exact reconstruction
remains unqualified. Preview is read-only. Apply only publishes and selects a
verified Mise-managed revision; it does not qualify Git.

The shared `~/.bunfig.toml` disables implicit dependency installation. Keep
reproducibility and dependency trust project-owned: use `bun install
--frozen-lockfile` or `bun ci`, inspect `bun pm untrusted`, and admit trusted
lifecycle scripts in that project's `package.json`.

### Repository checks

`bun run check` stays a pure verification command. Automation that starts from
a clean checkout can prepare dependencies first:

```bash
bun run prepare:check -- --receipt-dir "$RUNNER_TEMP/dotfiles-preparation"
bun run check
```

Preparation runs the root frozen install first, then the independently locked
My Second Brain Playground. The ownership manifest refuses an unclassified plugin lock or a missing
independent lock; the frozen install rejects a stale lock before checks run. When `--receipt-dir` is supplied, root and
nested stdout/stderr are retained in separate mode-restricted files.

The [Repository checks workflow](.github/workflows/repository-checks.yml) owns
continuous verification on pull requests and main. It uses the Bun version in
`package.json`, prepares independent dependencies, runs the existing full gate
and public shell regressions, and compares root/runtime Fallow against the
immutable commit recorded by the triggering event. A hosted macOS runner proves
source checks; it does not prove a personal machine installation, hook activation
or branch-protection policy.

### Add new symlinks
Edit `bin/dotfiles/symlinks/symlinks_manage.sh` and add to the `symlinks` array.

## Requirements

- macOS (Apple Silicon or Intel)
- Internet connection
- Admin privileges for Homebrew

## License

MIT
