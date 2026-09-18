# ~/.zshenv - loaded for all zsh instances.
#
# Keep this file side-effect free. Interactive setup, version managers, secrets,
# and launchctl sync belong in explicit shell helpers or login/interactive files.

# ----------------------------------------------------------------------------
# Glob and pattern baseline
# ----------------------------------------------------------------------------
# Issue 48 removed the `setopt` lines that ENABLED these options. That stops
# this repository adding a hazard, but it does not remove one that arrives from
# outside, and those are different guarantees.
#
# An agent harness can start zsh with options already set, so startup inherits
# them and, having nothing to say about them, passes them straight through to
# every agent command. A fresh bound Claude lane hit exactly this: EXTENDED_GLOB
# was on after snapshot replay, and unquoted `HEAD^` expanded to a pattern that
# NULL_GLOB then deleted, leaving the revision argument gone with no error.
#
# So the baseline is stated explicitly rather than assumed. It lives in .zshenv
# because that is the only file every zsh invocation reads: a non-interactive
# `zsh -c` agent command never reaches .zshrc, and it needs this guarantee most.
#
# NOMATCH is asserted on, not merely left alone, so an unmatched pattern fails
# visibly instead of vanishing.
#
# A function that genuinely needs extended patterns takes a local baseline
# (`setopt localoptions extendedglob`) so the option cannot escape into a
# snapshot. See the Globbing section of .zshrc.
#
# Contract: bin/test/zsh-effective-behavior-test.sh
unsetopt EXTENDED_GLOB NULL_GLOB GLOB_DOTS
setopt NOMATCH

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

# User command directories are safe, side-effect-free PATH inputs owned here so
# login, interactive, and non-interactive zsh processes share one lookup rule.
# Keep them ahead of the runtime bootstraps below; a verified fnm or Mise
# selection can then establish its own runtime priority without being shadowed.
typeset -U path PATH
case ":${PATH:-}:" in
  *":$HOME/.local/bin:"*) ;;
  *) path=("$HOME/.local/bin" "${path[@]}") ;;
esac
case ":${PATH:-}:" in
  *":$HOME/bin:"*) ;;
  *) path=("$HOME/bin" "${path[@]}") ;;
esac
export PATH

# Keep the 1Password service-account token out of shell startup.
# bin/with-one-password-token reads dotfiles/.env for the exact `op` child only.

# Shared Node runtime bootstrap. Keeps VS Code, tmux, Ghostty, and non-interactive
# zsh scripts aligned with project .nvmrc/.node-version files.
[ -f "$HOME/.config/fnm/bootstrap.sh" ] && source "$HOME/.config/fnm/bootstrap.sh"

# A verified applied Mise revision takes precedence over the fallback above.
# The bootstrap stays inactive when current is missing or invalid.
[ -f "$HOME/.config/mise/bootstrap.sh" ] && source "$HOME/.config/mise/bootstrap.sh"

# ----------------------------------------------------------------------------
# gogcli home
# ----------------------------------------------------------------------------
# ~/.config is a symlink into this repository, so anything written under
# ~/.config/gogcli lands in the working tree. Credentials and tokens are
# gitignored there, which keeps them out of history but makes them casualties
# of a fresh worktree, a new clone, or `git clean -xdf`. Point gogcli at
# machine-local state instead, so the repository holds the pointer and never
# the secret. Restore on a new machine from the 1Password entries.
export GOG_HOME="$HOME/.local/state/gogcli"
