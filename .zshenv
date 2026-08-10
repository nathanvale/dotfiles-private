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

# Keep the 1Password service-account token out of shell startup.
# bin/with-one-password-token reads dotfiles/.env for the exact `op` child only.

# Shared Node runtime bootstrap. Keeps VS Code, tmux, Ghostty, and non-interactive
# zsh scripts aligned with project .nvmrc/.node-version files.
[ -f "$HOME/.config/fnm/bootstrap.sh" ] && source "$HOME/.config/fnm/bootstrap.sh"
