# Work Profile Convention

Every employer gets a private git repo following this structure. The repo name
must match the pattern `<slug>-dotfiles`, because the selector holds a slug and
`.zshrc` builds exactly one path from it:

```text
~/code/<slug>-dotfiles/profile.zsh
```

Selection lives in one file, `~/.dotfiles_state/work-profile`, holding one slug:

```bash
echo 'acme' > ~/.dotfiles_state/work-profile
dotfiles-work-profile          # report the resulting state
```

The `.zshrc` block named `Work profile config` owns the grammar, the containment
check, and the reason for each. Contract:
`bin/test/zsh-work-profile-boundary-test.sh`. Read the owner before changing the
shape; do not restate its rules here.

---

## Canonical Directory Structure

```
~/code/<employer>-dotfiles/          # Private git repo (NEVER public)
+-- profile.zsh                      # Entry point -- sourced by .zshrc
+-- install.sh                       # Idempotent setup (symlinks, SSH, git)
+-- .gitconfig.work                  # Work git identity (email, signing key)
+-- ssh_config.work                  # SSH config fragment (optional)
+-- Brewfile.work                    # Employer-specific brew packages (optional)
+-- claude/                          # Work-specific Claude Code config
    +-- CLAUDE.md                    # Work-specific instructions
    +-- commands/                    # Work slash commands
    +-- skills/                      # Work skills
    +-- context/                     # Work context files
```

---

## File Purposes

### profile.zsh (entry point)

The ONLY file sourced by `.zshrc`. It should:
- Export employer-specific env vars (PATH additions, tool config)
- Define employer-specific aliases and functions
- Source additional files from the repo as needed
- Be fast -- runs on every shell startup

### install.sh (one-time setup)

Idempotent script that:
- Creates Claude Code symlinks into `~/.claude/`
- Optionally adds SSH config includes
- Optionally sets up git includeIf for work repos
- Supports `--status` to show current state and `--unlink` to remove

### Claude Code integration

The `install.sh` creates these symlinks:

| Link | Target | Purpose |
|------|--------|---------|
| `~/.claude/CLAUDE.md` | `claude/CLAUDE.md` | Work-specific AI instructions |
| `~/.claude/commands` | `claude/commands/` | Work slash commands |
| `~/.claude/skills` | `claude/skills/` | Work skills |
| `~/.claude/context` | `claude/context/` | Work context files |

**Conflict note:** These symlinks replace the personal Claude config. If Nathan
needs both personal and work Claude config simultaneously, the work `install.sh`
should use subdirectories instead (e.g., `~/.claude/commands/work/` pointing to
the work commands).

---

## Security Rules

- Keep the repo private on GitHub, or self-hosted
- Keep every reference to this repo inside the private repo itself
- Keep `profile.zsh` silent on source; it sets values without echoing them
- Keep credentials in 1Password, delivered per-process by
  `with-one-password-token inject`. `profile.zsh` holds work env vars and
  `~/.dotfiles_state/work-profile` holds the selecting slug; neither holds a
  secret value. Contract:
  [sensitive-material-access.md](sensitive-material-access.md)
- Keep SSH keys in `~/.ssh/`
- Exclude `.env*`, `*.pem`, and `*.key` in the work repo's `.gitignore`
