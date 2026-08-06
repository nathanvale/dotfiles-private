# ~/.zshenv - loaded for all zsh instances.
#
# Keep this file side-effect free. Interactive setup, version managers, secrets,
# and launchctl sync belong in explicit shell helpers or login/interactive files.

# Codex sandboxes block the default ~/.cache/clang path. Keep Swift module
# compilation in OS-managed temporary storage available to sandboxed workers.
export CLANG_MODULE_CACHE_PATH="${TMPDIR:-/tmp}/clang-module-cache"
#
# Non-interactive SSH commands do not read .zshrc. Keep the package-manager
# prefix available so remote tools resolve installed executables before
# fallback path probes.
case ":${PATH:-}:" in
  *:/opt/homebrew/bin:*) ;;
  *) export PATH="/opt/homebrew/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" ;;
esac

# EXCEPTION: the 1Password service-account token is the bootstrap key that lets
# `op read` fetch every other secret on demand. It must be present in ALL shells
# (interactive, non-interactive, cron, MCP subprocesses) or automation can't
# reach 1Password. dotfiles/.env holds ONLY this token; downstream secrets stay
# in load-secrets / op read.
[ -f "$HOME/code/dotfiles/.env" ] && source "$HOME/code/dotfiles/.env"

# Shared Node runtime bootstrap. Keeps VS Code, tmux, Ghostty, and non-interactive
# zsh scripts aligned with project .nvmrc/.node-version files.
[ -f "$HOME/.config/fnm/bootstrap.sh" ] && source "$HOME/.config/fnm/bootstrap.sh"
