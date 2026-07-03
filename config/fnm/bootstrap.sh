# Shared fnm bootstrap for terminals, tmux panes, VS Code Git hooks, and scripts.
#
# Keep this POSIX-compatible: Husky sources ~/.config/husky/init.sh with /bin/sh.

case ":$PATH:" in
  *":/opt/homebrew/bin:"*) ;;
  *) [ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH" ;;
esac

case ":$PATH:" in
  *":/usr/local/bin:"*) ;;
  *) [ -d /usr/local/bin ] && PATH="/usr/local/bin:$PATH" ;;
esac

export PATH

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash --log-level quiet --version-file-strategy recursive)"

  # Project version files must beat the global fnm default in non-interactive
  # entrypoints like VS Code Source Control and Husky hooks.
  fnm use --silent-if-unchanged --version-file-strategy recursive >/dev/null 2>&1 || true
fi
