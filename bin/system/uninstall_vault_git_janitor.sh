#!/usr/bin/env bash
# Unregister the vault-git Janitor job and remove its generated private files.

set -euo pipefail

readonly LABEL='com.nathanvale.vault-git-janitor'

usage() {
  cat <<'EOF'
Usage:
  uninstall_vault_git_janitor.sh [--dry-run]

Remove the generated launchd plist, runtime admission, state, and bounded logs.

Options:
  --dry-run       Print the removal plan without changing launchd or files.
  -h, --help      Show this help.
EOF
}

is_test_mode() {
  [[ "${VAULT_GIT_JANITOR_TEST_MODE:-0}" == '1' ]]
}

main() {
  local dry_run=false
  local launchctl_bin='/bin/launchctl'
  local uid
  local service_target
  local plist_path="$HOME/Library/LaunchAgents/$LABEL.plist"
  local runtime_root="$HOME/.local/state/vault-git-janitor"
  local state_dir="$runtime_root/state"
  local config_dir="$runtime_root/config"
  local log_dir="$runtime_root/logs"
  local lock_pid=''
  local index
  local candidate

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --dry-run)
        dry_run=true
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        printf 'error=unknown-option option=%s repair=run-with---help\n' "$1" >&2
        return 64
        ;;
    esac
  done

  # A symlinked runtime directory would send every removal below somewhere
  # else: a config_dir pointing at ~/.ssh means `rm -f "$config_dir/runtime.conf"`
  # deletes a file there. The execution wrapper applies the same invariant
  # before it uses these paths.
  for candidate in "$runtime_root" "$config_dir" "$state_dir" "$log_dir"; do
    if [[ -L "$candidate" ]]; then
      printf 'error=runtime-dir-unsafe message=Runtime-directory-is-a-symlink repair=inspect-%s\n' "$candidate" >&2
      return 1
    fi
  done

  if [[ -d "$state_dir/run.lock" ]]; then
    # Reclaim only a verified-dead owner; refuse live or unverifiable owners.
    if [[ -f "$state_dir/run.lock/pid" && ! -L "$state_dir/run.lock/pid" ]]; then
      lock_pid="$(<"$state_dir/run.lock/pid")"
    fi
    # A dry run must not mutate: reclaiming here would clear a stale lock that
    # the caller only asked us to report on.
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null && ! "$dry_run"; then
      rm -f "$state_dir/run.lock/pid"
      rmdir "$state_dir/run.lock" 2>/dev/null || true
    fi
    if [[ -d "$state_dir/run.lock" ]] && ! "$dry_run"; then
      printf 'error=active-run message=Janitor-is-running repair=retry-after-the-current-run\n' >&2
      return 1
    fi
  fi
  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_LAUNCHCTL:-}" ]]; then
    launchctl_bin="$VAULT_GIT_JANITOR_LAUNCHCTL"
  fi
  uid="$(id -u)"
  service_target="gui/$uid/$LABEL"

  if "$dry_run"; then
    printf 'status=dry-run action=uninstall label=%s plist=%s\n' "$LABEL" "$plist_path"
    return 0
  fi

  if "$launchctl_bin" print "$service_target" >/dev/null 2>&1; then
    "$launchctl_bin" bootout "$service_target"
  fi

  # bootout can return before the wrapper finishes. If it took the lock after
  # the check above, removing runtime state now would pull files out from under
  # a live run, so refuse unless the owner is provably dead.
  if [[ -d "$state_dir/run.lock" ]]; then
    lock_pid=''
    if [[ -f "$state_dir/run.lock/pid" && ! -L "$state_dir/run.lock/pid" ]]; then
      lock_pid="$(<"$state_dir/run.lock/pid")"
    fi
    if [[ ! "$lock_pid" =~ ^[0-9]+$ ]] || kill -0 "$lock_pid" 2>/dev/null; then
      printf 'error=active-run message=Janitor-started-during-uninstall repair=retry-after-the-current-run\n' >&2
      return 1
    fi
    rm -f "$state_dir/run.lock/pid"
    rmdir "$state_dir/run.lock" 2>/dev/null || true
  fi

  rm -f "$plist_path"
  rm -f "$config_dir/runtime.conf"
  rm -f "$state_dir/current-run-id" "$state_dir/last-attempt-date" "$state_dir/last-success-date" "$state_dir/last-trigger-kind"
  rm -f "$log_dir/janitor.log"
  for ((index = 1; index <= 5; index++)); do
    rm -f "$log_dir/janitor.log.$index"
  done
  rmdir "$config_dir" "$state_dir" "$log_dir" "$runtime_root" 2>/dev/null || true

  printf 'status=uninstalled label=%s\n' "$LABEL"
}

main "$@"
