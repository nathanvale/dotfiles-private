#!/bin/bash
# Deprecated: this helper installs no Homebrew packages. It is a standalone
# front door back to the canonical, profile-aware Brewfile commands. No
# repository-relative dependency: it must print its notice even copied
# outside this repository.

set -e

printf 'brew_remote_bundle.sh is retired; it installs no Homebrew packages.\n' >&2
printf 'Apply the profile-aware Brewfile instead (dotfiles_profile=desktop or server):\n' >&2
printf '  HOMEBREW_DOTFILES_PROFILE="$dotfiles_profile" brew bundle --file=config/brew/Brewfile\n' >&2
printf 'Verify with:\n' >&2
printf '  HOMEBREW_DOTFILES_PROFILE="$dotfiles_profile" brew bundle check --file=config/brew/Brewfile\n' >&2

exit 1
