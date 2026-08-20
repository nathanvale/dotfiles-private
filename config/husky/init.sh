# shellcheck shell=sh
# Shared Husky init. Sourced by Husky before repo hooks.
#
# VS Code Source Control does not always inherit an interactive zsh environment,
# so Git hooks need their own fnm bootstrap.

[ -f "$HOME/.config/fnm/bootstrap.sh" ] && . "$HOME/.config/fnm/bootstrap.sh"
