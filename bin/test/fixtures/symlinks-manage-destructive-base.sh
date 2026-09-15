#!/bin/bash

# Deliberately unsafe sensitivity fixture for symlinks-real-directory-test.sh.
# It models the retired interactive rm -rf path against a disposable HOME.

set -euo pipefail

script_dir="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
dotfiles="$(cd "$script_dir/../../.." && pwd)"
destination="$HOME/.config"
target="$dotfiles/config"

case "${1:-}" in
  --link)
    if [[ -d "$destination" && ! -L "$destination" ]]; then
      read -r -p "Directory exists; replace with symlink? [y/N] " answer
      [[ "$answer" == [yY] ]] || exit 1
      rm -rf "$destination"
    fi
    ln -s "$target" "$destination"
    ;;
  *) exit 64 ;;
esac
