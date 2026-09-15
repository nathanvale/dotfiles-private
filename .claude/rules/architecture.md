---
paths:
  - "bin/**"
  - "apps/**"
  - "config/**"
---

# Dotfiles Architecture Rules

## Core Architecture Pattern

**Modular Installation System:**
- Each component (brew, symlinks, preferences) has dedicated `install`/`uninstall`/`manage` scripts
- Critical hotspots: `execute_scripts` (orchestration), `get_config` (configuration), `log_error` (error handling)
- Domain organization: `bin/dotfiles/`, `bin/system/`, `bin/tmux/`, `bin/utils/`
- Major applications: `apps/taskdock/`, `apps/hyperflow/`, `apps/vault/`
- **All scripts use `set -e` (fail-fast) and are idempotent (safe to run multiple times)**

## Symlink Strategy

- **Root dotfiles** (`.zshrc`, `.npmrc`, `.gitconfig`) → symlinked from `$HOME` to repo root
- **Config directories** (`config/<tool>/`) → symlinked to `$HOME/.config/<tool>/`
- **Management tool:** `bin/dotfiles/symlinks/symlinks_manage.sh` (single source of truth)

## Secrets Pattern

Shell startup sources no credential. One value reaches one process through
`bin/with-one-password-token inject`. Owner:
`.claude/skills/dotfiles/references/sensitive-material-access.md`. Contract:
`bin/test/generic-credential-consumer-test.sh`.

**Never hardcode secrets**, and do not reintroduce an on-disk file that projects
a set of values into the environment.

## Key Scripts Reference

| Script | Purpose |
|--------|---------|
| `bin/dotfiles/symlinks/symlinks_manage.sh` | Manage all configuration symlinks |
| `config/brew/Brewfile` | Profile-aware package install/update via `./setup.sh` or `brew bundle` (see `AGENTS.md` Routes) |
| `config/macos/defaults.common.sh` | Configure macOS user-domain preferences |
| `bin/tmux/tx` | Universal tmux session launcher (replaces 20+ project configs) |
| `bin/colour_log.sh` | Standardized logging utilities (source in all scripts) |

## Script Development Rules

1. **Always** start scripts with `set -e` for fail-fast behavior
2. **Always** source `bin/colour_log.sh` for consistent logging, except
   a non-mutating retirement/deprecation notice, which uses plain `printf` so
   it stays actionable even copied outside the repository
3. Keep scripts **modular** — prefer multiple small scripts over monoliths
4. Test scripts **independently** before integrating into orchestration workflows
5. For tmux work, edit **universal templates** (`config/tmuxinator/`) — avoid project-specific configs

## File Organization Pattern

```
bin/          → Installation system, utilities, CLI shims (→ apps/)
apps/         → Major applications (taskdock, hyperflow, vault)
config/       → All configuration files (tmux, git, karabiner, etc.)
.claude/      → Claude Code configuration (commands, agents, skills)
misc/         → Fonts, themes, assets
Root dotfiles → Symlinked from $HOME to repo root
```
