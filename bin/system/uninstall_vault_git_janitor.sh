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
  local index

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

  if [[ -d "$state_dir/run.lock" ]]; then
    printf 'error=active-run message=Janitor-is-running repair=retry-after-the-current-run\n' >&2
    return 1
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
