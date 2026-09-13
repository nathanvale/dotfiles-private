# User command paths are owned by .zshenv for every zsh startup mode.

# Re-select the verified Mise shims after this login file changes PATH.
[ -f "$HOME/.config/mise/bootstrap.sh" ] && source "$HOME/.config/mise/bootstrap.sh"

# OrbStack is installed by the server profile. Use capability detection so this
# shared login-shell file remains harmless on desktops.
[[ -r "$HOME/.orbstack/shell/init.zsh" ]] && source "$HOME/.orbstack/shell/init.zsh"
