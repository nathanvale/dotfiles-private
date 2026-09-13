#!/bin/bash
# Deprecated: this helper installs nothing. It is a standalone front door back
# to the canonical, profile-aware setup entry point. No repository-relative
# dependency: it must print its notice even copied outside this repository.

set -e

printf 'brew_install.sh is retired; it installs nothing.\n' >&2
printf 'Install Homebrew through the canonical entry point instead:\n' >&2
printf '  ./setup.sh --desktop   (desktop profile)\n' >&2
printf '  ./setup.sh --server    (server profile)\n' >&2

exit 1
