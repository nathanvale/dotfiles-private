# Created by `pipx` on 2025-11-24 19:17:40
export PATH="$PATH:$HOME/.local/bin"

# OrbStack is installed by the server profile. Use capability detection so this
# shared login-shell file remains harmless on desktops.
[[ -r "$HOME/.orbstack/shell/init.zsh" ]] && source "$HOME/.orbstack/shell/init.zsh"
