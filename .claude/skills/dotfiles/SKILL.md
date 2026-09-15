---
name: dotfiles
description: >
  Knowledge base and setup orchestrator for Nathan's dotfiles system. Covers
  environment variables, Brewfile profiles, symlinks, work profiles, server
  setup, API key management, and troubleshooting. Also orchestrates new machine
  setup and work laptop onboarding. Use when: "set up my laptop", "new machine",
  "where do env vars go", "how does the Brewfile work", "how do symlinks work",
  "fix brew error", "new work laptop", dotfiles architecture questions.
argument-hint: "[question or --setup or --work <employer>]"
allowed-tools: Bash, Read, Grep, Glob
---

# Dotfiles Knowledge Base & Setup Orchestrator

This skill is the single source of truth for Nathan's dotfiles system at
`~/code/dotfiles`. It covers everything from "how does X work?" questions to
full machine setup orchestration. Read the inline knowledge below to answer
questions directly. Use the router at the bottom for action workflows.

---

## Security -- Read This First

**CATASTROPHIC RISK: Work content in the public dotfiles repo.**

Work laptops contain employer-sensitive material: company email addresses, internal
hostnames, VPN endpoints, API keys, SSH keys, Jira project IDs, internal tool names,
git signing identities, and proprietary aliases. If ANY of this leaks into the public
dotfiles repo, security scanners will flag it and Nathan faces disciplinary action.

### Hard rules -- no exceptions, no workarounds

- **ALL work config goes in ~/code/<employer>-dotfiles/** (private repo, separate git remote) -- including "harmless" aliases
- **Public dotfiles name the employer only through the work-profile slug** -- keep literal employer names out of `.zshrc`, `.gitconfig`, `Brewfile`, and every tracked file
- **Symlinks point from private to public, never the reverse**
- **Credentials live in 1Password** and reach a process through
  `with-one-password-token inject`; no tracked file holds a value. Lanes:
  [sensitive-material-access.md](references/sensitive-material-access.md)
- **Setup reports status only** -- it prints paths and outcomes, never values
- **If in doubt, it goes in the private repo.** There is no grey area.

The work-profile slug exists specifically to avoid employer names in the public
repo. The `Work profile config` block in `.zshrc` is the ONLY bridge, and it
reads a validated slug from machine state rather than a hardcoded name. Adding a
second loader that names an employer literally bypasses that validation and puts
the name in a public repo.

---

## System Overview

### Machine Types

| Type | setup.sh profile | Work-profile slug | Description |
|------|-----------------|-------------|-------------|
| Desktop workstation | `desktop` | (unset) | Full GUI apps |
| Headless server | `server` | (unset) | Containers and local inference tools |
| Work laptop | `desktop` | `<slug>` | Corporate MacBook + employer layer |

### Key Paths

| Path | Purpose |
|------|---------|
| `~/code/dotfiles/` | Public dotfiles repo (this repo) |
| `~/code/<employer>-dotfiles/` | Private work config repo |
| `~/.dotfiles_state/` | State directory (profile, checkpoint, log) |
| `~/.config/` | Symlink to `~/code/dotfiles/config/` |

### State Directory (`~/.dotfiles_state/`)

Created by `setup.sh` to track installation progress:

| File | Content |
|------|---------|
| `profile` | `desktop` or `server` |
| `checkpoint` | Last completed phase number |
| `history` | Phase completion timestamps |
| `setup.log` | Full log output |
| `ai_rescue_ready` | Marker file (Phase 2 complete) |
| `macos_version` | Stored for compatibility checks |

### setup.sh Architecture (7 Phases)

| Phase | Name | Time | What it does |
|-------|------|------|-------------|
| 0 | Preflight | ~5s | Validate macOS 15+, Apple Silicon, network, disk |
| 1 | Foundation | ~2m | Xcode CLT + Homebrew + repo clone |
| 2 | AI Rescue | ~30s | Native Claude Code + managed Codex CLIs |
| 3 | Core Tools | ~3m | Essential CLI: git, zsh, tmux, fzf, ripgrep, bat, eza, gh... |
| 4 | Development | ~5m | Language runtimes: bun, python, node/fnm, pnpm |
| 5 | Applications | ~10m | GUI apps from Brewfile (profile-aware) |
| 6 | Configuration | ~2m | Symlinks + macOS preferences |

Run modes: `./setup.sh --desktop`, `./setup.sh --server`, `./setup.sh --resume`,
`./setup.sh symlinks`, `./setup.sh prefs`, `./setup.sh verify`, `./setup.sh status`.

---

## Environment Variables

### Startup Responsibilities

`.zshenv` is minimal and universal, `.zprofile` is silent at login, and `.zshrc`
holds interactive behavior. Each file states its own boundary and the reason for
it. Contracts: `bin/test/zsh-effective-behavior-test.sh` and
`bin/test/zsh-startup-silence-test.sh`.

No shell startup path sources a credential. Values and their delivery lanes:
[sensitive-material-access.md](references/sensitive-material-access.md).

### The Work Profile Bridge

The `Work profile config` block in `.zshrc` is the only public-to-private
bridge. It reads one validated slug from machine state, never an ambient
variable, and loads at most one file. That block owns the grammar and the
containment check; `bin/test/zsh-work-profile-boundary-test.sh` proves them.

Report the current state without disclosing contents:

```bash
dotfiles-work-profile
```

### HOMEBREW_ Prefix Requirement

Environment variables must use the `HOMEBREW_` prefix to be passed through to Brewfile
Ruby evaluation. Regular env vars are filtered out by Homebrew's security model.

Example: `HOMEBREW_DOTFILES_PROFILE=desktop` (not `DOTFILES_PROFILE`).

---

## Brewfile System

Location: `config/brew/Brewfile`

The Brewfile is Ruby, using profile conditionals to install different packages
per machine type.

### Profile Detection

```ruby
profile = ENV.fetch("HOMEBREW_DOTFILES_PROFILE", "desktop")
```

Defaults to `desktop` if unset.

### Package Categories

| Category | Profile | Examples |
|----------|---------|----------|
| Core CLI | all | tmux, zoxide, ripgrep, bat, eza, fzf, gh, jq, lazygit |
| Dev tools | all | bun, python, uv, pnpm, fnm, ast-grep |
| Shell | all | zsh, zsh-syntax-highlighting, zsh-autosuggestions |
| AI CLI | all | aider, gemini-cli, whisper-cpp |
| Cloud | all | awscli, az, flyctl |
| Shared casks | all | karabiner-elements, raycast, 1password, ghostty, superwhisper, obsidian |
| Communication | desktop | slack, discord, zoom, teams, outlook |
| Browsers | desktop | firefox, google-chrome |
| AI desktop | desktop | chatgpt, Codex |
| Utilities | desktop | betterdisplay, cleanmymac, aldente |
| Containers | server | orbstack |
| AI/LLM | server | ollama (native for Metal GPU access) |

### Invocation

```bash
HOMEBREW_DOTFILES_PROFILE=desktop brew bundle --file=~/code/dotfiles/config/brew/Brewfile
HOMEBREW_DOTFILES_PROFILE=server  brew bundle --file=~/code/dotfiles/config/brew/Brewfile
```

Cleanup (remove packages not in Brewfile):
```bash
brew bundle cleanup --file=~/code/dotfiles/config/brew/Brewfile
```

---

## Symlink System

Managed by `bin/dotfiles/symlinks/symlinks_manage.sh`.

### What Links Where

| Symlink | Target in repo | Notes |
|---------|---------------|-------|
| `~/.zshrc` | `.zshrc` | Shell config |
| `~/.zprofile` | `.zprofile` | Login shell |
| `~/.gitconfig` | `.gitconfig` | Git config |
| `~/.gitignore_global` | `.gitignore_global` | Global gitignore |
| `~/.gitmessage` | `.gitmessage` | Commit template |
| `~/.config` | `config/` | Entire XDG config dir |
| `~/bin` | `bin/` | Scripts on PATH |
| `~/Scripts` | `Scripts/` | Automation scripts |
| `~/.tmux.conf` | `config/tmux/tmux.conf` | Tmux (doesn't follow XDG) |
| VS Code `settings.json` | `config/vscode/settings.json` | VS Code settings |
| VS Code `tasks.json` | `config/vscode/tasks.json` | VS Code tasks |
| VS Code `keybindings.json` | `config/vscode/keybindings.json` | VS Code keys |
| VS Code `prompts` | `config/vscode/prompts` | VS Code prompts dir |
| VS Code `mcp.json` | `config/vscode/mcp.json` | VS Code MCP config |
| `~/Documents/superwhisper` | `config/superwhisper` | Voice dictation modes |

### Commands

```bash
# Create all symlinks
bin/dotfiles/symlinks/symlinks_manage.sh --link

# Remove all symlinks
bin/dotfiles/symlinks/symlinks_manage.sh --unlink

# Show status (colored OK/MISSING/WRONG)
bin/dotfiles/symlinks/symlinks_manage.sh --status

# Preview changes without applying
bin/dotfiles/symlinks/symlinks_manage.sh --link --dry-run

# Force replace existing files (backups created)
bin/dotfiles/symlinks/symlinks_manage.sh --link --force
```

---

## GitHub CLI Hosts (Multi-Account Pattern)

`gh` reads `~/.config/gh/hosts.yml` for authentication. Since `~/.config` symlinks
to `config/` in the public repo, this file needs special handling to avoid leaking
work GitHub identities or oauth tokens into the public repo.

### Fragment + Gitignore Pattern

| File | Tracked | Purpose |
|------|---------|---------|
| `config/gh/hosts.yml.personal` | Yes | Token-free template (git_protocol, user list) |
| `config/gh/hosts.yml` | No (gitignored) | Runtime file where `gh auth` writes tokens |

**Personal machines:** `symlinks_manage.sh --link` copies `.personal` -> `hosts.yml`
if `hosts.yml` doesn't exist. Uses `cp` (not symlink) so `gh auth login` can write
tokens to the gitignored copy without dirtying the tree.

**Work machines:** The work repo's `install.sh` merges `.personal` + work fragment
via `yq` and symlinks `hosts.yml` to the merged file in the private repo:

```bash
# In ~/code/<employer>-dotfiles/install.sh
yq eval-all 'select(fileIndex==0) * select(fileIndex==1)' \
  "$DOTFILES/config/gh/hosts.yml.personal" \
  "$WORK_DOTFILES/gh/hosts.yml.work" > "$WORK_DOTFILES/gh/hosts.yml.merged"
ln -sf "$WORK_DOTFILES/gh/hosts.yml.merged" "$DOTFILES/config/gh/hosts.yml"
```

### Key Rules

- **NEVER add work GitHub users to `hosts.yml.personal`** -- work identities go in the private repo
- **NEVER track `config/gh/hosts.yml`** -- it's gitignored because `gh auth` writes tokens to it
- **NEVER symlink `hosts.yml` to `.personal` on personal machines** -- use `cp` so tokens stay in the gitignored copy
- `yq` is available (in Brewfile) for YAML merging on work machines

### Useful Commands

```bash
gh auth status                    # Check current auth
gh auth switch -u nathanvale      # Switch to personal account
gh auth login                     # Authenticate (writes to hosts.yml)
```

---

## Work Profile System

Every employer gets a private git repo at `~/code/<employer>-dotfiles/`.

### Canonical Structure

```
~/code/<employer>-dotfiles/
+-- profile.zsh              # Entry point sourced by .zshrc
+-- install.sh               # Idempotent setup (symlinks, SSH, git)
+-- .gitconfig.work          # Work git identity
+-- ssh_config.work          # SSH config (optional)
+-- Brewfile.work            # Employer packages (optional)
+-- Codex/                  # Work-specific Codex config
    +-- AGENTS.md
    +-- commands/
    +-- skills/
    +-- context/
```

### Owners

- Selection and loading: the `Work profile config` block in `.zshrc`. Contract:
  `bin/test/zsh-work-profile-boundary-test.sh`.
- Private repo structure and setup:
  [work-profile-convention.md](references/work-profile-convention.md).

### Scaffolding

The `work-profile-init.sh` script creates the canonical structure:

```bash
.Codex/skills/dotfiles/scripts/work-profile-init.sh <employer>
```

It's idempotent -- skips if the directory already exists.

See [work-profile-convention.md](references/work-profile-convention.md) for the full spec.

---

## Sensitive Material Access

1Password owns every value: API keys and tokens, website logins, payment cards,
identity profiles, and release credentials.

Read [sensitive-material-access.md](references/sensitive-material-access.md)
before delivering any of them, when wiring an MCP server, CLI, or MCPorter
route to a credential, or when a credential route fails, a config calls
`op run` or sources an env file of secrets, a header or config holds a literal
value, or a task needs a card, login, or personal profile.

The process lane is the common one:

```bash
with-one-password-token inject <ENV_KEY> <op://reference> -- <command>
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `brew` SSL errors | Corporate TLS proxy | `export SSL_CERT_FILE=~/CAFile.pem` |
| `gh` auth fails | Not logged in | `gh auth login` |
| `setup.sh` sudo denied | MDM restrictions | Note failures, continue without sudo |
| `profile.zsh` not sourced | Slug unset, rejected, or refused | Run `dotfiles-work-profile`; it names which |
| Symlink shows WRONG | Target changed | `symlinks_manage.sh --link --force` |
| `with-one-password-token check` blocked | OP_SERVICE_ACCOUNT_TOKEN missing or file mode wrong | Add to `~/code/dotfiles/.env`, mode 0600 |
| `brew bundle` ignores env var | Missing HOMEBREW_ prefix | Rename to `HOMEBREW_<name>` |
| Node not found in non-interactive shell | fnm alias not in PATH | Check `~/.local/share/fnm/aliases/default/bin` |
| macOS prefs not applied | Needs restart | `killall SystemUIServer` or restart |
| `gh` auth missing after fresh setup | `hosts.yml` not generated | Run `symlinks_manage.sh --link` then `gh auth login` |
| `hosts.yml` shows in `git status` | Not gitignored | Check `.gitignore` has `config/gh/hosts.yml` entry |
| Work GitHub user in public repo | Leaked to `.personal` | Remove from `.personal`, add to work repo's `hosts.yml.work` |

---

## What Would You Like To Do?

Match the user's request to a workflow:

### Set up a new machine (fresh Mac)

**Keywords:** "new machine", "fresh install", "set up my laptop", "set up my server",
"bootstrap", "--setup"

**Route to:** [fresh-machine-setup.md](workflows/fresh-machine-setup.md)

### Add or manage a work profile

**Keywords:** "new work laptop", "new job", "work profile", "employer", "--work",
"onboarding"

**Route to:** [work-profile-setup.md](workflows/work-profile-setup.md)

### Everything else

Answer from the inline knowledge above. If the question needs more depth than
what's covered here, check the reference files below.

---

## Reference Files (Deep Dives)

| Reference | When to use |
|-----------|-------------|
| [system-architecture.md](references/system-architecture.md) | Deep dive on env vars, symlinks, profiles, setup.sh phases |
| [brewfile-system.md](references/brewfile-system.md) | Brewfile conditionals, all packages, adding new packages |
| [work-profile-convention.md](references/work-profile-convention.md) | Full spec for work-dotfiles repo structure |
| [sensitive-material-access.md](references/sensitive-material-access.md) | Delivering an API key, token, website login, payment card, identity profile, or release credential; wiring an MCP server, CLI, or MCPorter route; any 1Password or credential failure |
| [troubleshooting.md](references/troubleshooting.md) | Expanded common issues with detailed fixes |
