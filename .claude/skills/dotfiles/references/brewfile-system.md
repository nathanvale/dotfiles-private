# Brewfile System Reference

Deep dive on the Brewfile at `config/brew/Brewfile` -- profile conditionals,
complete package list, and how to add new packages.

---

## How It Works

The Brewfile is Ruby, so it supports conditionals. Profile is read from an
environment variable:

```ruby
profile = ENV.fetch("HOMEBREW_DOTFILES_PROFILE", "desktop")
```

**Important:** The env var MUST use the `HOMEBREW_` prefix because Homebrew
filters out all other env vars for security.

---

## Profile Conditionals

```ruby
# Desktop-only packages
if profile == "desktop"
  cask "slack"
  # ...
end

# Server-only packages
if profile == "server"
  cask "orbstack"
  brew "ollama"
end

# Packages outside any conditional are installed for ALL profiles
brew "tmux"
```

---

## Complete Package List

### Taps (all profiles)

- `oven-sh/bun`
- `ognistik/homebrew-formulae`
- `steipete/tap`

### Core CLI Tools (all profiles)

tmux, zoxide, direnv, tmuxinator, atuin, ripgrep, bat, eza, fd, fzf, gh, jq,
yq, lazygit, fnm, shfmt, shellcheck, wget, git-delta, coreutils, tree, watch,
gnu-sed, htop, lnav

### Development Tools (all profiles)

bun, python, uv, pipx, pyenv, pnpm, git-filter-repo, ast-grep, m4, autoconf,
actionlint, yamllint, bats-core

### Shell (all profiles)

zsh, zsh-syntax-highlighting, zsh-autosuggestions

### AI CLI Tools (all profiles)

aider, gemini-cli, whisper-cpp, macrowhisper

### Cloud & Infrastructure (all profiles)

awscli, az, flyctl, ghq

### Utilities (all profiles)

blueutil, m1ddc, poppler, grep, hl, ffmpeg, pandoc

### Shared Casks (all profiles)

karabiner-elements, raycast, 1password, 1password-cli, ghostty, superwhisper,
obsidian, codex-app, gcloud-cli, visual-studio-code

### Desktop-Only Casks

slack, discord, zoom, microsoft-teams, microsoft-outlook, firefox, google-chrome,
notion, chatgpt, claude, betterdisplay, cleanmymac, aldente, imazing,
philips-hue-sync, raspberry-pi-imager, codexbar

The Claude Code and Codex CLIs are Phase 2 native or managed installs owned by
`setup.sh`; the Brewfile owns only their desktop applications.

### Desktop-Only Formulae

jira-cli, yarn

### Server-Only Casks

orbstack

### Server-Only Formulae

ollama

---

## Adding New Packages

1. **Decide the profile scope** -- is it for all machines, desktop only, or server only?
2. **Find the right section** in the Brewfile (organized by category)
3. **Add the entry** with a comment explaining what it is:
   ```ruby
   brew "tool-name"              # What this tool does
   cask "app-name"               # What this app does
   ```
4. **For profile-specific packages**, add inside the appropriate `if` block
5. **Install immediately:**
   ```bash
   HOMEBREW_DOTFILES_PROFILE=desktop brew bundle --file=~/code/dotfiles/config/brew/Brewfile
   ```
6. **Verify:** `brew list | grep tool-name`

### Cleanup

Remove packages not in the Brewfile:
```bash
brew bundle cleanup --file=~/code/dotfiles/config/brew/Brewfile
# Add --force to actually remove them
brew bundle cleanup --file=~/code/dotfiles/config/brew/Brewfile --force
```

---

## Common Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| Env var not reaching Brewfile | Missing `HOMEBREW_` prefix | Rename to `HOMEBREW_<name>` |
| Cask install fails on work laptop | MDM restriction | Skip it, note in PR |
| `brew bundle` hangs | Large cask download | Wait, or install cask separately first |
| Cleanup removes something needed | Package not in Brewfile | Add it to the right section |
