#!/usr/bin/env bash
# Report whether the generated vault-git Janitor job is installed and loaded.

set -euo pipefail

readonly LABEL='com.nathanvale.vault-git-janitor'

usage() {
  cat <<'EOF'
Usage:
  status_vault_git_janitor.sh

Report the generated plist, runtime admission, and loaded launchd state.

Options:
  -h, --help      Show this help.
EOF
}

is_test_mode() {
  [[ "${VAULT_GIT_JANITOR_TEST_MODE:-0}" == '1' ]]
}

main() {
  local launchctl_bin='/bin/launchctl'
  local plist_path="$HOME/Library/LaunchAgents/$LABEL.plist"
  local config_path="$HOME/.local/state/vault-git-janitor/config/runtime.conf"
  local uid
  local service_target
  local plist_state='missing'
  local config_state='missing'
  local loaded_state='no'

  if [[ "$#" -gt 0 ]]; then
    case "$1" in
      -h|--help)
        usage
        return 0
        ;;
      *)
        printf 'error=unknown-option option=%s repair=run-with---help\n' "$1" >&2
        return 64
        ;;
    esac
  fi

  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_LAUNCHCTL:-}" ]]; then
    launchctl_bin="$VAULT_GIT_JANITOR_LAUNCHCTL"
  fi
  uid="$(id -u)"
  service_target="gui/$uid/$LABEL"
  [[ -f "$plist_path" && ! -L "$plist_path" ]] && plist_state='present'
  [[ -f "$config_path" && ! -L "$config_path" ]] && config_state='present'
  if "$launchctl_bin" print "$service_target" >/dev/null 2>&1; then
    loaded_state='yes'
  fi

  printf 'label=%s loaded=%s plist=%s config=%s\n' "$LABEL" "$loaded_state" "$plist_state" "$config_state"
  [[ "$loaded_state" == 'yes' && "$plist_state" == 'present' && "$config_state" == 'present' ]]
}

main "$@"
