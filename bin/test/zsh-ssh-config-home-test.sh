#!/usr/bin/env bash

# Canonical config home for non-interactive SSH commands.
#
# The Herdr web bridge is started over SSH by another machine and builds its
# socket path from XDG_CONFIG_HOME or ~/.config without resolving symlinks. When
# ~/.config is a symlink into this repository, that path must be the resolved
# one, or the bridge registers under an alias the connection server never looks
# for. Every assertion reads a real /bin/zsh child under a hermetic HOME whose
# .config is a symlink, with a copy of this repository's .zshenv.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

count=0
pass() { count=$((count + 1)); printf 'ok %d - %s\n' "$count" "$1"; }
fail() {
  printf 'not ok - %s\n' "$1" >&2
  printf 'Bail out! %s\n' "$1"
  exit 1
}
assert_equals() {
  [[ "$1" == "$2" ]] || fail "$3 (expected [$2], got [$1])"
  pass "$3"
}

# Resolve the temp root too: macOS places it behind the /var symlink.
physical_root="$(CDPATH='' cd -P "$TEST_ROOT" && pwd -P)"
test_home="$physical_root/home"
canonical="$physical_root/repo/config"
mkdir -p "$test_home" "$canonical/herdr"
ln -s "$canonical" "$test_home/.config"
cp "$REPO_ROOT/.zshenv" "$test_home/.zshenv"

# shellcheck disable=SC2016
probe='print -r -- "[${XDG_CONFIG_HOME-unset}]"'

# Runs a clean zsh child; extra arguments are NAME=value environment entries.
run_zsh() {
  local mode="$1"
  shift
  env -i HOME="$test_home" PATH=/usr/bin:/bin "$@" /bin/zsh "$mode" "$probe" 2>/dev/null
}

assert_equals "$(run_zsh -c SSH_CONNECTION='198.51.100.1 1 198.51.100.2 22')" "[$canonical]" \
  'non-interactive SSH command gets the resolved config home'
assert_equals "$(run_zsh -c)" '[unset]' \
  'a local non-interactive command is left alone'
assert_equals "$(run_zsh -c SSH_CONNECTION='198.51.100.1 1 198.51.100.2 22' XDG_CONFIG_HOME=/caller/value)" '[/caller/value]' \
  'a value the caller supplied is not overridden'
assert_equals "$(run_zsh -ic SSH_CONNECTION='198.51.100.1 1 198.51.100.2 22')" '[unset]' \
  'an interactive SSH shell is left to .zshrc'

# The resolved directory must be the one the bridge needs to reach the socket.
herdr_sock_dir="$(run_zsh -c SSH_CONNECTION='198.51.100.1 1 198.51.100.2 22')"
herdr_sock_dir="${herdr_sock_dir#\[}"
herdr_sock_dir="${herdr_sock_dir%\]}"
[[ "$herdr_sock_dir/herdr" -ef "$test_home/.config/herdr" ]] || fail 'resolved path reaches the same herdr directory'
pass 'resolved path and the alias reach the same herdr directory'

printf '1..%d\n' "$count"
