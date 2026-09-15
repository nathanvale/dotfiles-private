#!/usr/bin/env bash
# work-profile-init.sh - Scaffold a new work-dotfiles repo
#
# Creates ~/code/<slug>-dotfiles/ with the canonical structure.
# Idempotent: skips if the directory already exists.
#
# The slug must satisfy the canonical work-profile grammar, because this script
# instructs the operator to select it in ~/.dotfiles_state/work-profile.
#
# Usage:
#   ./work-profile-init.sh <slug>
#   ./work-profile-init.sh acme

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

log() { echo -e "${GREEN}[setup]${RESET} $1"; }
warn() { echo -e "${YELLOW}[warn]${RESET} $1"; }
error() { echo -e "${RED}[error]${RESET} $1" >&2; }

# ---------------------------------------------------------------------------
# Validate input
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
    error "Usage: $0 <slug>"
    error "  slug: 1-32 chars of a-z and 0-9, single interior hyphens (e.g. acme)"
    exit 1
fi

EMPLOYER="$1"

# Validate the slug against the canonical work-profile grammar.
#
# This value becomes the repo name, and this script's closing instructions ask
# the operator to select the same value in ~/.dotfiles_state/work-profile. This
# script never writes that file. It must still be a slug the shell will load,
# because a value accepted here and refused there sends the operator to write a
# selection that silently never loads. The grammar is owned by the `Work profile
# config` block in .zshrc; setup.sh mirrors the same expression for the same
# reason.
# Accepting anything wider here scaffolds a repo the selector then silently
# refuses, which looks like a broken work profile rather than a rejected name.
#
# The pattern bounds repetitions, and a `-x` repetition is two characters, so
# the length check is what enforces the documented 32-character total.
#
# Contract: bin/test/work-profile-slug-parity-test.sh
if [[ ! "$EMPLOYER" =~ ^[a-z0-9]([a-z0-9]|-[a-z0-9]){0,31}$ ]] || (( ${#EMPLOYER} > 32 )); then
    error "Invalid slug: '$EMPLOYER'"
    error "Must be 1-32 characters of lowercase a-z and 0-9, with single"
    error "interior hyphens only: no leading or trailing hyphen, no '--'."
    exit 1
fi

REPO_DIR="$HOME/code/${EMPLOYER}-dotfiles"

# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------
if [[ -d "$REPO_DIR" ]]; then
    warn "Directory already exists: $REPO_DIR"
    warn "Skipping scaffold. Run install.sh from the existing repo."
    exit 0
fi

# ---------------------------------------------------------------------------
# Scaffold
# ---------------------------------------------------------------------------
log "Creating ${EMPLOYER}-dotfiles at $REPO_DIR"

mkdir -p "$REPO_DIR"/{claude/{commands,skills,context},bin}

# ---- profile.zsh (entry point sourced by .zshrc) ----
cat > "$REPO_DIR/profile.zsh" << 'PROFILE_EOF'
#!/usr/bin/env zsh
# profile.zsh - Work profile entry point
# Loaded by the "Work profile config" block in ~/.zshrc when the work-profile
# slug in machine state selects this repo.
#
# Keep this fast -- it runs on every shell startup.
# Put slow operations in install.sh instead.

SCRIPT_DIR="${0:A:h}"

# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------
# export WORK_EMAIL="you@employer.com"
# Non-secret settings only. A credential reaches one process at its own
# boundary via `with-one-password-token inject`, never an export here.

# ---------------------------------------------------------------------------
# PATH additions
# ---------------------------------------------------------------------------
# export PATH="$SCRIPT_DIR/bin:$PATH"

# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Git identity for work repos (via includeIf)
# ---------------------------------------------------------------------------
# Handled by .gitconfig includeIf -- see install.sh
PROFILE_EOF

# ---- install.sh (idempotent setup) ----
cat > "$REPO_DIR/install.sh" << INSTALL_EOF
#!/usr/bin/env bash
# install.sh - Set up ${EMPLOYER}-dotfiles on a work machine
#
# Usage:
#   ./install.sh           Create all symlinks
#   ./install.sh --unlink  Remove all symlinks
#   ./install.sh --status  Show current status

set -e

SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
CLAUDE_HOME="\${HOME}/.claude"

# Claude Code symlinks: "link_path|target_path"
claude_symlinks=(
	"\${CLAUDE_HOME}/CLAUDE.md|\${SCRIPT_DIR}/claude/CLAUDE.md"
	"\${CLAUDE_HOME}/context|\${SCRIPT_DIR}/claude/context"
	"\${CLAUDE_HOME}/commands|\${SCRIPT_DIR}/claude/commands"
	"\${CLAUDE_HOME}/skills|\${SCRIPT_DIR}/claude/skills"
)

all_symlinks=("\${claude_symlinks[@]}")

create_links() {
	echo "Creating symlinks..."
	mkdir -p "\$CLAUDE_HOME"

	for entry in "\${all_symlinks[@]}"; do
		local link="\${entry%%|*}"
		local target="\${entry##*|}"

		if [[ ! -e "\$target" ]]; then
			echo "  SKIP (target missing): \$target"
			continue
		fi

		if [[ -L "\$link" ]]; then
			if [[ "\$(readlink "\$link")" == "\$target" ]]; then
				echo "  OK:   \$link"
			else
				ln -sf "\$target" "\$link"
				echo "  UPDATED: \$link -> \$target"
			fi
		elif [[ -e "\$link" ]]; then
			echo "  EXISTS (not a symlink): \$link"
			echo "         Remove it manually first, then re-run."
		else
			ln -s "\$target" "\$link"
			echo "  CREATED: \$link -> \$target"
		fi
	done

	echo ""
	echo "Done. Select this profile:  echo '${EMPLOYER}' > ~/.dotfiles_state/work-profile"
}

remove_links() {
	echo "Removing symlinks..."
	for entry in "\${all_symlinks[@]}"; do
		local link="\${entry%%|*}"
		if [[ -L "\$link" ]]; then
			rm "\$link"
			echo "  REMOVED: \$link"
		else
			echo "  SKIP (not a symlink): \$link"
		fi
	done
	echo "Done."
}

show_status() {
	echo "Work Profile Symlinks (${EMPLOYER})"
	echo "Repo: \$SCRIPT_DIR"
	echo ""
	printf "%-40s %-10s %s\n" "LINK" "STATUS" "TARGET"
	printf "%-40s %-10s %s\n" "----" "------" "------"

	for entry in "\${all_symlinks[@]}"; do
		local link="\${entry%%|*}"
		local target="\${entry##*|}"
		local display="\${link/#\$HOME/~}"

		if [[ -L "\$link" ]]; then
			local actual
			actual="\$(readlink "\$link")"
			if [[ "\$actual" == "\$target" ]]; then
				printf "%-40s \033[32m%-10s\033[0m %s\n" "\$display" "OK" "\${actual/#\$SCRIPT_DIR/\\\$REPO}"
			else
				printf "%-40s \033[33m%-10s\033[0m %s\n" "\$display" "WRONG" "\${actual/#\$HOME/~}"
			fi
		elif [[ -e "\$link" ]]; then
			printf "%-40s \033[33m%-10s\033[0m %s\n" "\$display" "EXISTS" "(not a symlink)"
		else
			printf "%-40s \033[31m%-10s\033[0m %s\n" "\$display" "MISSING" "-"
		fi
	done
	echo ""
}

case "\${1:-}" in
--unlink)
	remove_links
	;;
--status)
	show_status
	;;
*)
	create_links
	;;
esac
INSTALL_EOF
chmod +x "$REPO_DIR/install.sh"

# ---- claude/CLAUDE.md (work-specific Claude instructions) ----
cat > "$REPO_DIR/claude/CLAUDE.md" << CLAUDE_EOF
# ${EMPLOYER} Work Profile - Claude Code Instructions

## Security

- NEVER commit files from this repo to ~/code/dotfiles (public repo)
- NEVER reference employer-specific content in public dotfiles
- Credentials stay in 1Password and reach one process through
  `with-one-password-token inject`. No file here holds a value.

## Work Context

<!-- Add employer-specific instructions for Claude Code here -->
<!-- e.g., coding standards, repo conventions, internal tool usage -->
CLAUDE_EOF

# ---- .gitconfig.work (work git identity) ----
cat > "$REPO_DIR/.gitconfig.work" << 'GITCONFIG_EOF'
# Work git identity
# Add to ~/.gitconfig:
#   [includeIf "gitdir:~/code/work/"]
#     path = ~/code/<employer>-dotfiles/.gitconfig.work

[user]
	# name = Your Name
	# email = you@employer.com
	# signingkey = ...
GITCONFIG_EOF

# ---- .gitignore ----
cat > "$REPO_DIR/.gitignore" << 'IGNORE_EOF'
# Secrets - NEVER commit these
.env
.env.*
*.pem
*.key
*.p12
*.pfx

# OS
.DS_Store

# Editor
*.swp
*.swo
*~
IGNORE_EOF

# ---- Initialize git ----
cd "$REPO_DIR"
git init -q
git add -A
git commit -q -m "chore: initial ${EMPLOYER}-dotfiles scaffold"

echo ""
log "Scaffolded ${EMPLOYER}-dotfiles at $REPO_DIR"
log ""
log "Structure:"
echo "  $REPO_DIR/"
echo "  +-- profile.zsh              # Entry point (sourced by .zshrc)"
echo "  +-- install.sh               # Symlink manager"
echo "  +-- .gitconfig.work          # Work git identity"
echo "  +-- claude/"
echo "      +-- CLAUDE.md            # Work Claude instructions"
echo "      +-- commands/            # Work slash commands"
echo "      +-- skills/              # Work skills"
echo "      +-- context/             # Work context files"
echo ""
log "Next steps:"
echo "  1. Edit profile.zsh with your work config"
echo "  2. Run: ./install.sh"
echo "  3. Select it: echo '${EMPLOYER}' > ~/.dotfiles_state/work-profile"
echo "  4. Create a private GitHub repo:"
echo "     gh repo create nathanvale/${EMPLOYER}-dotfiles --private --source=. --push"
