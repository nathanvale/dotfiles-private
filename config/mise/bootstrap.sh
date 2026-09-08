# shellcheck shell=sh
# Select only a verified revision published by bin/dotfiles/toolchain.
#
# This file is sourced by zsh startup and Husky's POSIX shell init. It must stay
# silent: callers learn selection only through DOTFILES_MISE_ACTIVE and
# MISE_GLOBAL_CONFIG_FILE.

unset MISE_GLOBAL_CONFIG_FILE
dotfiles_mise_inherited_data_dir=${MISE_DATA_DIR:-}
dotfiles_mise_inherited_shims_dir=${MISE_SHIMS_DIR:-}
unset MISE_DATA_DIR
unset MISE_INSTALLS_DIR
unset MISE_SHIMS_DIR
unset DOTFILES_MISE_ACTIVE
unset DOTFILES_MISE_CONFIG_FILE

# Remove any inherited Mise shim entry before deciding whether this process may
# use one. This prevents a stale parent environment from bypassing validation.
dotfiles_mise_home=$(CDPATH='' cd -P "$HOME" 2>/dev/null && pwd) || dotfiles_mise_home=
dotfiles_mise_default_shims="$dotfiles_mise_home/.local/share/mise/shims"
dotfiles_mise_home_spelling_shims="$HOME/.local/share/mise/shims"
dotfiles_mise_inherited_shims="$dotfiles_mise_inherited_data_dir/shims"
dotfiles_mise_path_rest="${PATH:-}:"
dotfiles_mise_clean_path=
while [ -n "$dotfiles_mise_path_rest" ]; do
  dotfiles_mise_path_entry=${dotfiles_mise_path_rest%%:*}
  dotfiles_mise_path_rest=${dotfiles_mise_path_rest#*:}
  case "$dotfiles_mise_path_entry" in
    /*) ;;
    *) continue ;;
  esac
  case "$dotfiles_mise_path_entry" in
    "$dotfiles_mise_default_shims"|"$dotfiles_mise_home_spelling_shims"|"$dotfiles_mise_inherited_shims"|"$dotfiles_mise_inherited_shims_dir") continue ;;
  esac
  dotfiles_mise_path_seen=false
  dotfiles_mise_seen_rest="$dotfiles_mise_clean_path:"
  while [ -n "$dotfiles_mise_seen_rest" ]; do
    dotfiles_mise_seen_entry=${dotfiles_mise_seen_rest%%:*}
    dotfiles_mise_seen_rest=${dotfiles_mise_seen_rest#*:}
    if [ "$dotfiles_mise_seen_entry" = "$dotfiles_mise_path_entry" ]; then
      dotfiles_mise_path_seen=true
      break
    fi
  done
  [ "$dotfiles_mise_path_seen" = true ] && continue
  if [ -z "$dotfiles_mise_clean_path" ]; then
    dotfiles_mise_clean_path=$dotfiles_mise_path_entry
  else
    dotfiles_mise_clean_path="$dotfiles_mise_clean_path:$dotfiles_mise_path_entry"
  fi
done
PATH=$dotfiles_mise_clean_path
export PATH

dotfiles_mise_state="$dotfiles_mise_home/.dotfiles_state/toolchain"
dotfiles_mise_current="$dotfiles_mise_state/current"

if [ -n "$dotfiles_mise_home" ] &&
  [ ! -L "$dotfiles_mise_home/.dotfiles_state" ] &&
  [ ! -L "$dotfiles_mise_state" ] &&
  [ ! -L "$dotfiles_mise_state/revisions" ] &&
  [ -L "$dotfiles_mise_current" ]; then
  dotfiles_mise_target=$(readlink "$dotfiles_mise_current" 2>/dev/null) || dotfiles_mise_target=
  case "$dotfiles_mise_target" in
    revisions/*) dotfiles_mise_revision=${dotfiles_mise_target#revisions/} ;;
    *) dotfiles_mise_revision= ;;
  esac

  if [ "${#dotfiles_mise_revision}" -eq 64 ]; then
    case "$dotfiles_mise_revision" in
      *[!0-9a-f]*) dotfiles_mise_revision= ;;
    esac
  else
    dotfiles_mise_revision=
  fi

  dotfiles_mise_revision_dir="$dotfiles_mise_state/revisions/$dotfiles_mise_revision"
  dotfiles_mise_config="$dotfiles_mise_revision_dir/config.toml"
  if [ -n "$dotfiles_mise_revision" ] &&
    [ "$dotfiles_mise_target" = "revisions/$dotfiles_mise_revision" ] &&
    [ -d "$dotfiles_mise_revision_dir" ] &&
    [ ! -L "$dotfiles_mise_revision_dir" ] &&
    [ -f "$dotfiles_mise_config" ] &&
    [ ! -L "$dotfiles_mise_config" ] &&
    [ -r "$dotfiles_mise_config" ] &&
    command -v mise >/dev/null 2>&1; then
    MISE_GLOBAL_CONFIG_FILE=$dotfiles_mise_config
    MISE_DATA_DIR="$dotfiles_mise_home/.local/share/mise"
    MISE_INSTALLS_DIR="$MISE_DATA_DIR/installs"
    MISE_SHIMS_DIR="$MISE_DATA_DIR/shims"
    DOTFILES_MISE_CONFIG_FILE=$dotfiles_mise_config
    DOTFILES_MISE_ACTIVE=1
    PATH="$dotfiles_mise_default_shims:$PATH"
    export MISE_GLOBAL_CONFIG_FILE MISE_DATA_DIR MISE_INSTALLS_DIR MISE_SHIMS_DIR DOTFILES_MISE_CONFIG_FILE DOTFILES_MISE_ACTIVE PATH
  fi
fi

unset dotfiles_mise_clean_path dotfiles_mise_config dotfiles_mise_current
unset dotfiles_mise_default_shims dotfiles_mise_home dotfiles_mise_home_spelling_shims
unset dotfiles_mise_inherited_data_dir dotfiles_mise_inherited_shims
unset dotfiles_mise_inherited_shims_dir
unset dotfiles_mise_path_entry dotfiles_mise_path_rest dotfiles_mise_path_seen
unset dotfiles_mise_seen_entry dotfiles_mise_seen_rest dotfiles_mise_revision
unset dotfiles_mise_revision_dir dotfiles_mise_state dotfiles_mise_target
