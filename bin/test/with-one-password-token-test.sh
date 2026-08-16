#!/usr/bin/env bash

set -euo pipefail

SUBJECT="$(cd "$(dirname "$0")/.." && pwd)/with-one-password-token"
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

assert_contains() {
  local value="$1"
  local expected="$2"
  local label="$3"
  [[ "$value" == *"$expected"* ]] || fail "$label"
  pass "$label"
}

assert_not_contains() {
  local value="$1"
  local unexpected="$2"
  local label="$3"
  [[ "$value" != *"$unexpected"* ]] || fail "$label"
  pass "$label"
}

make_fixture() {
  local fixture="$1"
  mkdir -p "$fixture/bin"
  git -C "$fixture" init -q
  git -C "$fixture" config core.excludesFile /dev/null
  printf '.env\n' >"$fixture/.gitignore"
  printf 'export OP_SERVICE_ACCOUNT_TOKEN="ops_SERVICE_SENTINEL"\n' >"$fixture/.env"
  chmod 600 "$fixture/.env"
  cat >"$fixture/bin/op" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == 'read' ]]; then
  [[ "$#" -eq 2 && "${2:-}" == 'op://known-vault/known-item/credential' ]] || exit 18
  printf 'UPLOAD_SECRET_SENTINEL'
  exit 0
fi
if [[ "${1:-}" == 'fail' ]]; then
  exit 19
fi
printf 'token_present=%s\n' "${OP_SERVICE_ACCOUNT_TOKEN:+yes}"
if [[ "${OP_SERVICE_ACCOUNT_TOKEN:-}" == 'ops_SERVICE_SENTINEL' ]]; then
  printf 'token_matches=yes\n'
else
  printf 'token_matches=\n'
fi
printf 'unrelated_present=%s\n' "${UNRELATED_SECRET:+yes}"
if /usr/bin/env | grep -q '^  --ansi='; then
  printf 'invalid_name_present=yes\n'
else
  printf 'invalid_name_present=\n'
fi
if /usr/bin/env | grep -q 'NEWLINE_INHERITED_SENTINEL'; then
  printf 'newline_name_present=yes\n'
else
  printf 'newline_name_present=\n'
fi
case "$(ps -o command= -p $$)" in
  *SERVICE_SENTINEL*) printf 'argv_has_token=yes\n' ;;
  *) printf 'argv_has_token=\n' ;;
esac
printf 'args=%s\n' "$*"
EOF
  chmod +x "$fixture/bin/op"
}

fixture="$TEST_ROOT/happy"
make_fixture "$fixture"

check_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" check)"
assert_contains "$check_output" '"status":"ok"' 'check reports ready without token bytes'
assert_not_contains "$check_output" 'SERVICE_SENTINEL' 'check redacts service token'

op_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" OP_SERVICE_ACCOUNT_TOKEN=ops_AMBIENT_SENTINEL UNRELATED_SECRET=LEAK_SENTINEL "$SUBJECT" op item get known-item --vault known-vault)"
assert_contains "$op_output" 'token_present=yes' 'op receives the service token'
assert_contains "$op_output" 'token_matches=yes' 'op receives the wrapper token instead of an ambient token'
assert_contains "$op_output" 'unrelated_present=' 'op receives no unrelated environment secret'
assert_contains "$op_output" 'argv_has_token=' 'service token is absent from op process arguments'
assert_not_contains "$op_output" 'SERVICE_SENTINEL' 'op output does not expose service token bytes'

invalid_name_output="$(env '  --ansi=INHERITED_SENTINEL' DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" op item get known-item --vault known-vault)"
assert_contains "$invalid_name_output" 'token_present=yes' 'op still receives the service token with a non-shell environment name'
assert_contains "$invalid_name_output" 'invalid_name_present=' 'op receives no inherited non-shell environment name'
assert_not_contains "$invalid_name_output" 'INHERITED_SENTINEL' 'non-shell environment value remains redacted'

newline_name_output="$(/usr/bin/env $'INHERITED\nNAME=NEWLINE_INHERITED_SENTINEL' DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" op item get known-item --vault known-vault)"
assert_contains "$newline_name_output" 'token_present=yes' 'op still receives the service token with a newline-bearing environment name'
assert_contains "$newline_name_output" 'newline_name_present=' 'op receives no inherited newline-bearing environment name'
assert_not_contains "$newline_name_output" 'newline_name_present=yes' 'newline-bearing environment name is removed explicitly'
assert_not_contains "$newline_name_output" 'NEWLINE_INHERITED_SENTINEL' 'newline-bearing environment value remains redacted'

shadow_env_fixture="$TEST_ROOT/shadow-env"
make_fixture "$shadow_env_fixture"
shadow_env_marker="$shadow_env_fixture/shadow-env-called"
cat >"$shadow_env_fixture/bin/env" <<EOF
#!/usr/bin/env bash
: >"$shadow_env_marker"
exit 88
EOF
chmod +x "$shadow_env_fixture/bin/env"
shadow_env_output="$(DOTFILES_DIR="$shadow_env_fixture" PATH="$shadow_env_fixture/bin:$PATH" "$SUBJECT" op item get known-item --vault known-vault)"
assert_contains "$shadow_env_output" 'token_matches=yes' 'trusted environment launcher forwards the wrapper token'
[[ ! -e "$shadow_env_marker" ]] || fail 'PATH-shadowed env cannot intercept token-bearing execution'
pass 'PATH-shadowed env cannot intercept token-bearing execution'

global_op_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" op --account known-account item get known-item)"
assert_contains "$global_op_output" 'args=--account known-account item get known-item' 'ordinary op command after global options is preserved'

# The nested shell must evaluate these expressions.
# shellcheck disable=SC2016
child_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" EXPERIENCE_EXTENSION_UPLOAD_TOKEN=AMBIENT_UPLOAD_SENTINEL UNRELATED_SECRET=LEAK_SENTINEL "$SUBJECT" inject EXPERIENCE_EXTENSION_UPLOAD_TOKEN op://known-vault/known-item/credential -- bash -c 'if [[ "$EXPERIENCE_EXTENSION_UPLOAD_TOKEN" == "UPLOAD_SECRET_SENTINEL" ]]; then printf "upload_matches=yes\\n"; else printf "upload_matches=\\n"; fi; printf "service_present=%s\\n" "${OP_SERVICE_ACCOUNT_TOKEN:+yes}"; printf "unrelated_present=%s\\n" "${UNRELATED_SECRET:+yes}"')"
assert_contains "$child_output" 'upload_matches=yes' 'child receives the requested secret value'
assert_contains "$child_output" 'service_present=' 'child does not receive the service token'
assert_contains "$child_output" 'unrelated_present=' 'child does not receive unrelated secrets'
assert_not_contains "$child_output" 'UPLOAD_SECRET_SENTINEL' 'test output does not expose injected secret bytes'

set +e
DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject EXPERIENCE_EXTENSION_UPLOAD_TOKEN op://known-vault/wrong-item/credential -- true >/dev/null 2>&1
unexpected_reference_status=$?
set -e
[[ "$unexpected_reference_status" -eq 18 ]] || fail 'unexpected op reference is rejected by the fixture'
pass 'unexpected op reference is rejected by the fixture'

set +e
run_error="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" op run -- true 2>&1)"
run_status=$?
set -e
[[ "$run_status" -eq 2 ]] || fail 'op run exits with usage status'
pass 'op run exits with usage status'
assert_contains "$run_error" 'op-run-rejected' 'op run has a stable rejection code'
assert_not_contains "$run_error" 'SERVICE_SENTINEL' 'op run rejection redacts token bytes'

for global_option_case in \
  '--account known-account run -- true' \
  '--account=known-account run -- true' \
  '--format json run -- true' \
  '--debug run -- true'; do
  read -r -a global_option_args <<<"$global_option_case"
  set +e
  global_run_error="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" op "${global_option_args[@]}" 2>&1)"
  global_run_status=$?
  set -e
  [[ "$global_run_status" -eq 2 ]] || fail "op run after global options exits with usage status: $global_option_case"
  assert_contains "$global_run_error" 'op-run-rejected' "op run after global options is rejected: $global_option_case"
  assert_not_contains "$global_run_error" 'SERVICE_SENTINEL' "op run after global options redacts token bytes: $global_option_case"
done

set +e
DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" op fail >/dev/null 2>&1
op_failure_status=$?
set -e
[[ "$op_failure_status" -eq 19 ]] || fail 'op failure status is preserved'
pass 'op failure status is preserved'

set +e
DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject EXPERIENCE_EXTENSION_UPLOAD_TOKEN op://known-vault/known-item/credential -- bash -c 'exit 23' >/dev/null 2>&1
child_failure_status=$?
set -e
[[ "$child_failure_status" -eq 23 ]] || fail 'child failure status is preserved'
pass 'child failure status is preserved'

duplicate_fixture="$TEST_ROOT/duplicate"
make_fixture "$duplicate_fixture"
printf 'OP_SERVICE_ACCOUNT_TOKEN="ops_SECOND_SENTINEL"\n' >>"$duplicate_fixture/.env"
set +e
duplicate_error="$(DOTFILES_DIR="$duplicate_fixture" PATH="$duplicate_fixture/bin:$PATH" "$SUBJECT" check 2>&1)"
duplicate_status=$?
set -e
[[ "$duplicate_status" -eq 3 ]] || fail 'duplicate declaration exits with custody status'
pass 'duplicate declaration exits with custody status'
assert_contains "$duplicate_error" 'token-declaration-count' 'duplicate declaration fails closed'
assert_not_contains "$duplicate_error" 'SENTINEL' 'duplicate declaration redacts token bytes'

mode_fixture="$TEST_ROOT/mode"
make_fixture "$mode_fixture"
chmod 644 "$mode_fixture/.env"
set +e
mode_error="$(DOTFILES_DIR="$mode_fixture" PATH="$mode_fixture/bin:$PATH" "$SUBJECT" check 2>&1)"
mode_status=$?
set -e
[[ "$mode_status" -eq 3 ]] || fail 'unsafe mode exits with custody status'
pass 'unsafe mode exits with custody status'
assert_contains "$mode_error" 'token-file-mode' 'unsafe mode fails closed'
assert_contains "$mode_error" '"status":"blocked"' 'unsafe mode reports a blocked repair envelope'
assert_contains "$mode_error" '"preferred_method":"service-account-token"' 'repair envelope names the preferred token lane'
assert_contains "$mode_error" '"fallback_candidate":"interactive-desktop-signin"' 'repair envelope names the user-present fallback candidate'
assert_contains "$mode_error" '"fallback_requires_user_approval":true' 'repair envelope keeps fallback behind user approval'
assert_contains "$mode_error" '"same_input_retry_safe":true' 'repair envelope says the failed check is safe to retry after repair'
assert_contains "$mode_error" '"repair":"repair token custody through the dotfiles owner, then rerun check"' 'repair envelope gives the next safe action'
assert_contains "$mode_error" '"run_id":"' 'repair envelope includes run correlation'
assert_not_contains "$mode_error" 'SERVICE_SENTINEL' 'unsafe mode error redacts token bytes'

ignore_fixture="$TEST_ROOT/ignore"
make_fixture "$ignore_fixture"
printf '# token file deliberately not ignored\n' >"$ignore_fixture/.gitignore"
set +e
ignore_error="$(DOTFILES_DIR="$ignore_fixture" PATH="$ignore_fixture/bin:$PATH" "$SUBJECT" check 2>&1)"
ignore_status=$?
set -e
[[ "$ignore_status" -eq 3 ]] || fail 'non-ignored file exits with custody status'
pass 'non-ignored file exits with custody status'
assert_contains "$ignore_error" 'token-file-not-ignored' 'non-ignored file fails closed'
assert_not_contains "$ignore_error" 'SERVICE_SENTINEL' 'non-ignored file error redacts token bytes'

git_state_fixture="$TEST_ROOT/git-state"
make_fixture "$git_state_fixture"
printf '# token file deliberately not ignored\n' >"$git_state_fixture/.gitignore"
inherited_git_fixture="$TEST_ROOT/inherited-git"
make_fixture "$inherited_git_fixture"
set +e
GIT_DIR="$inherited_git_fixture/.git" \
  GIT_WORK_TREE="$inherited_git_fixture" \
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=core.excludesFile \
  GIT_CONFIG_VALUE_0="$inherited_git_fixture/.gitignore" \
  DOTFILES_DIR="$git_state_fixture" \
  PATH="$git_state_fixture/bin:$PATH" \
  "$SUBJECT" check >/dev/null 2>&1
inherited_git_status=$?
set -e
[[ "$inherited_git_status" -eq 3 ]] || fail 'inherited Git state cannot redirect the ignore check'
pass 'inherited Git state cannot redirect the ignore check'

symlink_fixture="$TEST_ROOT/symlink"
make_fixture "$symlink_fixture"
mv "$symlink_fixture/.env" "$symlink_fixture/token-source"
ln -s "$symlink_fixture/token-source" "$symlink_fixture/.env"
set +e
symlink_error="$(DOTFILES_DIR="$symlink_fixture" PATH="$symlink_fixture/bin:$PATH" "$SUBJECT" check 2>&1)"
symlink_status=$?
set -e
[[ "$symlink_status" -eq 3 ]] || fail 'symlink exits with custody status'
pass 'symlink exits with custody status'
assert_contains "$symlink_error" 'token-file-symlink' 'symlink fails closed'

shape_fixture="$TEST_ROOT/shape"
make_fixture "$shape_fixture"
printf 'export OP_SERVICE_ACCOUNT_TOKEN="not-a-service-token"\n' >"$shape_fixture/.env"
chmod 600 "$shape_fixture/.env"
set +e
shape_error="$(DOTFILES_DIR="$shape_fixture" PATH="$shape_fixture/bin:$PATH" "$SUBJECT" check 2>&1)"
shape_status=$?
set -e
[[ "$shape_status" -eq 3 ]] || fail 'invalid shape exits with custody status'
pass 'invalid shape exits with custody status'
assert_contains "$shape_error" 'token-shape' 'invalid shape fails closed'

set +e
key_error="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject 'BAD-KEY' op://known-vault/known-item/credential -- true 2>&1)"
key_status=$?
set -e
[[ "$key_status" -eq 2 ]] || fail 'invalid environment key exits with usage status'
pass 'invalid environment key exits with usage status'
assert_contains "$key_error" 'environment-key-invalid' 'invalid environment key fails closed'

printf '1..%d\n' "$pass_count"
