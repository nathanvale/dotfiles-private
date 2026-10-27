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
# Keep them ahead of the runtime bootstrap below; a verified Mise selection can
# then establish its own runtime priority without being shadowed.
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

# Shared toolchain bootstrap. A verified applied Mise revision owns Node, Bun,
# Python, and Beads for VS Code, tmux, Ghostty, and non-interactive zsh scripts;
# Mise reads project .nvmrc/.node-version files itself. The bootstrap stays
# inactive when current is missing or invalid.
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

# ----------------------------------------------------------------------------
# Canonical config home for remote (SSH) commands
# ----------------------------------------------------------------------------
# ~/.config is a symlink into this repository, so the Herdr socket has two
# paths: ~/.config/herdr/herdr.sock and <repo>/config/herdr/herdr.sock. The
# Ovis (herdr-web-ui) connection server resolves the canonical one (`cd -P`)
# and looks for the Laptop bridge's descriptor under it. The bridge builds its
# socket from XDG_CONFIG_HOME or ~/.config WITHOUT resolving it (Bun's
# realpathSync fails on a Unix socket), so a bridge the other machine starts
# over a non-interactive SSH command, which passes no XDG_CONFIG_HOME,
# registers under the alias path and is reported as "Bridge did not start".
#
# Give those commands the resolved path. It is limited to non-interactive SSH
# commands and never overrides a value the caller supplied. Interactive shells
# keep the value .zshrc sets, and the directory is the same either way.
# `:A` resolves symlinks inside zsh, so this costs no subprocess.
# Contract: bin/test/zsh-ssh-config-home-test.sh
# Rollback: delete this block (or revert its commit). The Laptop bridge is then
# registered under the alias path again, so start it by hand with
# XDG_CONFIG_HOME=$HOME/code/dotfiles/config until the block is restored.
if [[ -n "${SSH_CONNECTION:-}" && -z "${XDG_CONFIG_HOME:-}" && ! -o interactive ]]; then
  export XDG_CONFIG_HOME="${${:-$HOME/.config}:A}"
fi
