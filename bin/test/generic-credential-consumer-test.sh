#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass_count=0

pass() {
  pass_count=$((pass_count + 1))
  printf 'ok %d - %s\n' "$pass_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

scan_unexpected_consumers() {
  local root="$1"
  local matched_path
  local search_paths=(
    "$root/.zshenv"
    "$root/.zprofile"
    "$root/.zshrc"
    "$root/.zlogin"
    "$root/bin"
    "$root/config"
  )
  while IFS= read -r matched_path; do
    matched_path="${matched_path#"$root/"}"
    case "$matched_path" in
      bin/with-env | bin/env/add-api-key | bin/env/sync-api-keys) ;;
      *) printf '%s\n' "$matched_path" ;;
    esac
  done < <(rg -l 'with-env|\.env\.1password' "${search_paths[@]}" -g '!bin/test/**' 2>/dev/null || true)
}

# A wrapper that delegates to the launcher is the supported shape. The defect is
# a bin that reaches `op` on its own, so a match only counts when the file never
# routes through the launcher.
scan_provider_auth_bins() {
  local root="$1"
  local matched_path
  while IFS= read -r matched_path; do
    matched_path="${matched_path#"$root/"}"
    [[ "$matched_path" != 'bin/with-one-password-token' ]] || continue
    rg -q 'with-one-password-token|CREDENTIAL_WRAPPER' "$root/$matched_path" 2>/dev/null && continue
    printf '%s\n' "$matched_path"
  done < <(rg -l '(^|[^-[:alnum:]])op (item get|read|run)' "$root/bin" -g '!**/test/**' 2>/dev/null || true)
}

unexpected_consumers="$(scan_unexpected_consumers "$REPO_ROOT")"
[[ -z "$unexpected_consumers" ]] || fail "unexpected generic credential consumers: $unexpected_consumers"
pass 'source contains no unowned generic credential consumer'

unexpected_auth_bins="$(scan_provider_auth_bins "$REPO_ROOT")"
[[ -z "$unexpected_auth_bins" ]] || fail "bins read a secret without the credential owner: $unexpected_auth_bins"
pass 'no bin reads a secret outside with-one-password-token'

fixture="$TEST_ROOT/fixture"
mkdir -p "$fixture/bin/env" "$fixture/config"
printf '# legacy owner: with-env\n' >"$fixture/bin/with-env"
printf '# legacy owner: .env.1password\n' >"$fixture/bin/env/add-api-key"
printf '# legacy owner: .env.1password\n' >"$fixture/bin/env/sync-api-keys"
printf '{"command":"with-env"}\n' >"$fixture/config/unowned-client.json"
printf 'source .env.1password\n' >"$fixture/.zprofile"
printf 'exec with-one-password-token inject TOKEN op://vault/item/credential -- provider\n' >"$fixture/bin/provider-login"
printf 'TOKEN="$(op item get PROVIDER --reveal)"\n' >"$fixture/bin/provider-direct"
fixture_result="$(scan_unexpected_consumers "$fixture")"
[[ "$fixture_result" == $'.zprofile\nconfig/unowned-client.json' ]] || fail 'fixture detects unowned startup and client consumers'
pass 'fixture detects unowned startup and client consumers'

fixture_auth_bins="$(scan_provider_auth_bins "$fixture")"
[[ "$fixture_auth_bins" == 'bin/provider-direct' ]] || fail "fixture detects a direct op reader, got: $fixture_auth_bins"
pass 'fixture flags a direct op reader and clears a delegating wrapper'

context7_command="$(jq -r '.servers.context7.command' "$REPO_ROOT/config/vscode/mcp.json")"
[[ "$context7_command" == "\${userHome}/code/dotfiles/bin/with-one-password-token" ]] || fail 'VS Code Context7 uses the single credential owner'
pass 'VS Code Context7 uses the single credential owner'

context7_args="$(jq -c '.servers.context7.args' "$REPO_ROOT/config/vscode/mcp.json")"
expected_context7_args='["inject","CONTEXT7_API_KEY","op://API Credentials/CONTEXT7_API_KEY/credential","--","npx","-y","@upstash/context7-mcp"]'
[[ "$context7_args" == "$expected_context7_args" ]] || fail 'VS Code Context7 launches the real provider command through generic injection'
pass 'VS Code Context7 launches the real provider command through generic injection'

printf '1..%d\n' "$pass_count"
