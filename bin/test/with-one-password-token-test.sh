#!/usr/bin/env bash

set -euo pipefail

# CDPATH='' matches every sibling test here. Without it, an inherited CDPATH
# makes `cd` echo the directory it resolved, and that extra line is captured
# into SUBJECT, producing a two-line path that cannot be executed.
SUBJECT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)/with-one-password-token"
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

# A held launch keeps about four processes alive (test subshell, wrapper, op or
# target, sleep). Starting all 240 at once needs about 1,000 concurrent
# processes, which can exceed the per-user process budget on a hosted macOS
# runner: fork then fails inside the wrapper's custody checks, the wrapper
# fails closed, and the suite reports a fixture failure unrelated to argv
# custody. The burst size is also what stretches the argv race window enough
# for the sampler to see it, so each wave is the largest the live budget
# allows (all 240 at once on a roomy machine) rather than a fixed small wave.
# Every one of the 240 launches still runs while the sampler watches.
HELD_LAUNCH_TOTAL=240
HELD_LAUNCH_PROCESS_COST=6
HELD_LAUNCH_RESERVE=128
HELD_LAUNCH_MIN_WAVE=20

held_launch_wave_size() {
  local budget
  local kernel_budget
  local in_use
  local wave
  budget="$(ulimit -u)"
  kernel_budget="$(sysctl -n kern.maxprocperuid 2>/dev/null || true)"
  if [[ "$kernel_budget" =~ ^[0-9]+$ ]] && { [[ ! "$budget" =~ ^[0-9]+$ ]] || ((kernel_budget < budget)); }; then
    budget="$kernel_budget"
  fi
  if [[ ! "$budget" =~ ^[0-9]+$ ]]; then
    printf '%s' "$HELD_LAUNCH_TOTAL"
    return
  fi
  in_use="$(ps -U "$(id -u)" -o pid= | wc -l | tr -d ' ')"
  wave=$(((budget - in_use - HELD_LAUNCH_RESERVE) / HELD_LAUNCH_PROCESS_COST))
  ((wave <= HELD_LAUNCH_TOTAL)) || wave="$HELD_LAUNCH_TOTAL"
  ((wave >= HELD_LAUNCH_MIN_WAVE)) || wave="$HELD_LAUNCH_MIN_WAVE"
  printf '%s' "$wave"
}

start_argv_sampler() {
  local sentinel="$1"
  local result="$2"
  local stop="$3"

  # Pass the sentinel only through the sampler's environment. Passing it as a
  # positional argument would make the sampler itself a false positive. The
  # sampler runs until the stop file exists, so it overlaps every launch wave;
  # it also stops when the EXIT trap removes the test root after a failure.
  SAMPLER_SENTINEL="$sentinel" SAMPLER_RESULT="$result" SAMPLER_STOP="$stop" /bin/bash -c '
    while [[ ! -e "$SAMPLER_STOP" && -d "${SAMPLER_STOP%/*}" ]]; do
      while IFS= read -r process_command; do
        case "$process_command" in
          *"$SAMPLER_SENTINEL"*)
            : >"$SAMPLER_RESULT"
            exit 0
            ;;
        esac
      done < <(ps -Ao command=)
    done
  ' >/dev/null 2>&1 &
  ARGV_SAMPLER_PID="$!"
}

# Wait for the whole wave before judging it, so a failure report names the
# held process's own error and the EXIT trap never deletes the fixture under
# still-running launches.
wait_for_held_wave() {
  local stderr_prefix="$1"
  shift
  local entry
  local status
  local failed_attempt=''
  local failed_status=0
  for entry in "$@"; do
    status=0
    wait "${entry%%:*}" || status=$?
    if [[ "$status" -ne 0 && -z "$failed_attempt" ]]; then
      failed_attempt="${entry#*:}"
      failed_status="$status"
    fi
  done
  if [[ -n "$failed_attempt" ]]; then
    printf '# held launch %s exited %s; its stderr follows\n' "$failed_attempt" "$failed_status" >&2
    sed 's/^/#   /' "$stderr_prefix-$failed_attempt" >&2 || true
    fail 'held fixture process exits successfully'
  fi
}

# Usage: run_held_launches <sentinel> <result-file> <wrapper arguments...>
run_held_launches() {
  local sentinel="$1"
  local result="$2"
  shift 2
  local stderr_prefix="$result.launch"
  local sampler_pid
  local wave_start
  local attempt
  local wave
  local wave_size

  wave_size="$(held_launch_wave_size)"
  printf '# held launches: %s in waves of %s\n' "$HELD_LAUNCH_TOTAL" "$wave_size"
  start_argv_sampler "$sentinel" "$result" "$result.stop"
  sampler_pid="$ARGV_SAMPLER_PID"
  for ((wave_start = 0; wave_start < HELD_LAUNCH_TOTAL; wave_start += wave_size)); do
    wave=()
    for ((attempt = wave_start; attempt < wave_start + wave_size && attempt < HELD_LAUNCH_TOTAL; attempt++)); do
      (
        DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" "$@" >/dev/null 2>"$stderr_prefix-$attempt"
      ) &
      wave+=("$!:$attempt")
    done
    wait_for_held_wave "$stderr_prefix" "${wave[@]}"
  done
  : >"$result.stop"
  wait "$sampler_pid"
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
  if [[ "${2:-}" == '--no-newline' ]]; then
    [[ "$#" -eq 3 ]] || exit 18
    reference="${3:-}"
  else
    [[ "$#" -eq 2 ]] || exit 18
    reference="${2:-}"
  fi
  case "$reference" in
    op://known-vault/known-item/credential)
      printf 'UPLOAD_SECRET_SENTINEL'
      ;;
    op://known-vault/complex-item/credential)
      [[ "${2:-}" == '--no-newline' ]] || exit 18
      printf 'quote"slash\\tab\tcr\rline\nback\bform\ftrailing\n\n'
      ;;
    *) exit 18 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == 'fail' ]]; then
  exit 19
fi
if [[ "${1:-}" == 'hold' ]]; then
  sleep 2
  exit 0
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

  cat >"$fixture/bin/hold-target" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
sleep 2
EOF
  chmod +x "$fixture/bin/hold-target"

  cat >"$fixture/bin/agent-browser" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_bin="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
[[ "$#" -eq 1 && "$1" == 'batch' ]] || : >"$fixture_bin/browser-argv-invalid"
case "$*" in
  *UPLOAD_SECRET_SENTINEL* | *quote*) : >"$fixture_bin/browser-secret-in-argv" ;;
esac
if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN+x}" ]]; then
  : >"$fixture_bin/browser-service-token-in-environment"
fi
if [[ -n "${EXPERIENCE_EXTENSION_UPLOAD_TOKEN+x}" ]]; then
  : >"$fixture_bin/browser-secret-in-environment"
fi
if [[ -n "${UNRELATED_SECRET+x}" ]]; then
  : >"$fixture_bin/browser-unrelated-secret-in-environment"
fi
batch_payload="$(cat)"
if [[ "$batch_payload" == '{"method":"fill","value":"quote\"slash\\tab\tcr\rline\nback\bform\ftrailing\n\n"}' ]]; then
  : >"$fixture_bin/browser-batch-payload-exact"
else
  : >"$fixture_bin/browser-batch-payload-invalid"
fi
EOF
  chmod +x "$fixture/bin/agent-browser"

  cat >"$fixture/bin/stdin-browser-consumer" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_bin="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
if [[ -n "${EXPERIENCE_EXTENSION_UPLOAD_TOKEN+x}" ]]; then
  : >"$fixture_bin/stdin-consumer-secret-in-environment"
fi
if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN+x}" ]]; then
  : >"$fixture_bin/stdin-consumer-service-token-in-environment"
fi
if [[ -n "${UNRELATED_SECRET+x}" ]]; then
  : >"$fixture_bin/stdin-consumer-unrelated-secret-in-environment"
fi
capture_marker=$'\034stdin-consumer-end\035'
stdin_capture="$(cat; printf '%s' "$capture_marker")"
stdin_secret="${stdin_capture%$capture_marker}"
expected_secret=$'quote"slash\\tab\tcr\rline\nback\bform\ftrailing\n\n'
if [[ "$stdin_secret" != "$expected_secret" ]]; then
  : >"$fixture_bin/stdin-consumer-secret-invalid"
  exit 24
fi
json_escape() {
  local escaped="$1"
  escaped="${escaped//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  escaped="${escaped//$'\b'/\\b}"
  escaped="${escaped//$'\f'/\\f}"
  escaped="${escaped//$'\n'/\\n}"
  escaped="${escaped//$'\r'/\\r}"
  escaped="${escaped//$'\t'/\\t}"
  printf '%s' "$escaped"
}
printf '{"method":"fill","value":"%s"}' "$(json_escape "$stdin_secret")" | agent-browser batch
EOF
  chmod +x "$fixture/bin/stdin-browser-consumer"

  cat >"$fixture/bin/no-launch-target" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_bin="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
: >"$fixture_bin/no-launch-target-called"
EOF
  chmod +x "$fixture/bin/no-launch-target"

  cat >"$fixture/bin/stat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_bin="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
preflight_environment="$(/usr/bin/env)"
case "$preflight_environment" in
  *AMBIENT_PREFLIGHT_SENTINEL* | *UNRELATED_PREFLIGHT_SENTINEL* | *HOSTILE_PREFLIGHT_SENTINEL* | *INVALID_PREFLIGHT_SENTINEL* | *NEWLINE_PREFLIGHT_SENTINEL*)
    : >"$fixture_bin/preflight-environment-leak"
    ;;
esac
: >"$fixture_bin/preflight-stat-called"
exec /usr/bin/stat "$@"
EOF
  chmod +x "$fixture/bin/stat"

  cat >"$fixture/bin/id" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_bin="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
preflight_environment="$(/usr/bin/env)"
case "$preflight_environment" in
  *AMBIENT_PREFLIGHT_SENTINEL* | *UNRELATED_PREFLIGHT_SENTINEL* | *HOSTILE_PREFLIGHT_SENTINEL* | *INVALID_PREFLIGHT_SENTINEL* | *NEWLINE_PREFLIGHT_SENTINEL*)
    : >"$fixture_bin/preflight-environment-leak"
    ;;
esac
: >"$fixture_bin/preflight-id-called"
exec /usr/bin/id "$@"
EOF
  chmod +x "$fixture/bin/id"
}

fixture="$TEST_ROOT/happy"
make_fixture "$fixture"

check_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" check)"
assert_contains "$check_output" '"status":"ok"' 'check reports ready without token bytes'
assert_not_contains "$check_output" 'SERVICE_SENTINEL' 'check redacts service token'

help_output="$("$SUBJECT" --help)"
assert_contains "$help_output" 'inject-stdin <op://reference> -- <command> [args...]' 'help documents stdin-only delivery'

op_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" OP_SERVICE_ACCOUNT_TOKEN=ops_AMBIENT_SENTINEL UNRELATED_SECRET=LEAK_SENTINEL "$SUBJECT" op item get known-item --vault known-vault)"
assert_contains "$op_output" 'token_present=yes' 'op receives the service token'
assert_contains "$op_output" 'token_matches=yes' 'op receives the wrapper token instead of an ambient token'
assert_contains "$op_output" 'unrelated_present=' 'op receives no unrelated environment secret'
assert_contains "$op_output" 'argv_has_token=' 'service token is absent from op process arguments'
assert_not_contains "$op_output" 'SERVICE_SENTINEL' 'op output does not expose service token bytes'

preflight_output="$(/usr/bin/env \
  OP_SERVICE_ACCOUNT_TOKEN=ops_AMBIENT_PREFLIGHT_SENTINEL \
  OP_CONNECT_TOKEN=AMBIENT_PREFLIGHT_SENTINEL \
  OP_CONNECT_HOST=AMBIENT_PREFLIGHT_SENTINEL \
  UNRELATED_SECRET=UNRELATED_PREFLIGHT_SENTINEL \
  TOKEN_VALUE=HOSTILE_PREFLIGHT_SENTINEL \
  RESOLVED_STDIN_SECRET=HOSTILE_PREFLIGHT_SENTINEL \
  secret_value=HOSTILE_PREFLIGHT_SENTINEL \
  retained_value=HOSTILE_PREFLIGHT_SENTINEL \
  capture=HOSTILE_PREFLIGHT_SENTINEL \
  line=HOSTILE_PREFLIGHT_SENTINEL \
  raw_value=HOSTILE_PREFLIGHT_SENTINEL \
  WITH_ONE_PASSWORD_TOKEN_CLEAN_START=1 \
  WITH_ONE_PASSWORD_TOKEN_CLEAN_PROOF=HOSTILE_PREFLIGHT_SENTINEL \
  '  --ansi=INVALID_PREFLIGHT_SENTINEL' \
  $'INVALID\nNAME=NEWLINE_PREFLIGHT_SENTINEL' \
  DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" check)"
assert_contains "$preflight_output" '"status":"ok"' 'clean preflight preserves check behavior'
[[ -e "$fixture/bin/preflight-stat-called" ]] || fail 'preflight stat helper runs before token parsing'
pass 'preflight stat helper runs before token parsing'
[[ -e "$fixture/bin/preflight-id-called" ]] || fail 'preflight id helper runs before token parsing'
pass 'preflight id helper runs before token parsing'
[[ ! -e "$fixture/bin/preflight-environment-leak" ]] || fail 'preflight helpers receive no ambient secrets or hostile environment names'
pass 'preflight helpers receive no ambient secrets or hostile environment names'

# This is intentionally a real process-list race test. Before the launcher
# hardening, /usr/bin/env briefly receives NAME=secret as an argument while it
# prepares the final child process. Held children let the sampler overlap many
# independent launches without teaching the fake op about the implementation.
service_argv_result="$TEST_ROOT/service-argv-result"
run_held_launches 'ops_SERVICE_SENTINEL' "$service_argv_result" op hold
[[ ! -e "$service_argv_result" ]] || fail 'service token never appears in process arguments during held op launches'
pass 'service token never appears in process arguments during held op launches'

inject_argv_result="$TEST_ROOT/inject-argv-result"
run_held_launches 'UPLOAD_SECRET_SENTINEL' "$inject_argv_result" inject EXPERIENCE_EXTENSION_UPLOAD_TOKEN op://known-vault/known-item/credential -- "$fixture/bin/hold-target"
[[ ! -e "$inject_argv_result" ]] || fail 'injected secret never appears in process arguments during held target launches'
pass 'injected secret never appears in process arguments during held target launches'

stdin_argv_result="$TEST_ROOT/stdin-argv-result"
run_held_launches 'UPLOAD_SECRET_SENTINEL' "$stdin_argv_result" inject-stdin op://known-vault/known-item/credential -- "$fixture/bin/hold-target"
[[ ! -e "$stdin_argv_result" ]] || fail 'stdin-delivered secret never appears in process arguments during held target launches'
pass 'stdin-delivered secret never appears in process arguments during held target launches'

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
# The child-process credential-delivery boundary.
#
# These four rows are the ones issue 51 relies on when it claims credential
# delivery reaches its target without broker authority or unrelated credentials.
# Read together they say: the requested value arrives at the named child, the
# broker's own service token does not follow it, an unrelated secret in the
# caller's environment is not carried along, and none of the values are printed
# in order to prove any of that.
#
# The startup half of the same criterion is proved separately, in
# bin/test/zsh-work-profile-boundary-test.sh and
# bin/test/codex-ambient-credential-boundary-test.sh: no shell startup sources a
# secret, and GUI projection carries only allowlisted non-secret names. Neither
# claim belongs here, because this file exercises the wrapper rather than a
# shell.
assert_contains "$child_output" 'upload_matches=yes' 'child receives the requested secret value'
assert_contains "$child_output" 'service_present=' 'child does not receive the service token'
assert_contains "$child_output" 'unrelated_present=' 'child does not receive unrelated secrets'
assert_not_contains "$child_output" 'UPLOAD_SECRET_SENTINEL' 'test output does not expose injected secret bytes'

stdin_delivery_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" EXPERIENCE_EXTENSION_UPLOAD_TOKEN=AMBIENT_UPLOAD_SENTINEL UNRELATED_SECRET=LEAK_SENTINEL "$SUBJECT" inject-stdin op://known-vault/complex-item/credential -- "$fixture/bin/stdin-browser-consumer")"
[[ -e "$fixture/bin/browser-batch-payload-exact" ]] || fail 'stdin-only consumer forwards the exact secret bytes as browser batch stdin'
pass 'stdin-only consumer forwards the exact secret bytes as browser batch stdin'
[[ ! -e "$fixture/bin/browser-batch-payload-invalid" ]] || fail 'fake browser receives no altered batch stdin'
pass 'fake browser receives no altered batch stdin'
[[ ! -e "$fixture/bin/browser-argv-invalid" ]] || fail 'fake browser receives only the batch command argument'
pass 'fake browser receives only the batch command argument'
[[ ! -e "$fixture/bin/stdin-consumer-secret-in-environment" ]] || fail 'stdin-only consumer receives no requested-secret environment variable'
pass 'stdin-only consumer receives no requested-secret environment variable'
[[ ! -e "$fixture/bin/stdin-consumer-service-token-in-environment" ]] || fail 'stdin-only consumer receives no service token'
pass 'stdin-only consumer receives no service token'
[[ ! -e "$fixture/bin/stdin-consumer-unrelated-secret-in-environment" ]] || fail 'stdin-only consumer receives no unrelated inherited secret'
pass 'stdin-only consumer receives no unrelated inherited secret'
[[ ! -e "$fixture/bin/browser-secret-in-argv" ]] || fail 'fake browser receives no secret in argv'
pass 'fake browser receives no secret in argv'
[[ ! -e "$fixture/bin/browser-secret-in-environment" ]] || fail 'fake browser receives no secret in environment'
pass 'fake browser receives no secret in environment'
[[ ! -e "$fixture/bin/browser-service-token-in-environment" ]] || fail 'fake browser receives no service token'
pass 'fake browser receives no service token'
[[ ! -e "$fixture/bin/browser-unrelated-secret-in-environment" ]] || fail 'fake browser receives no unrelated inherited secret'
pass 'fake browser receives no unrelated inherited secret'
assert_not_contains "$stdin_delivery_output" 'UPLOAD_SECRET_SENTINEL' 'stdin-only delivery output does not expose injected secret bytes'

set +e
DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject-stdin op://known-vault/wrong-item/credential -- "$fixture/bin/no-launch-target" >/dev/null 2>&1
stdin_failure_status=$?
set -e
[[ "$stdin_failure_status" -eq 18 ]] || fail 'stdin-only delivery preserves failed op read status'
pass 'stdin-only delivery preserves failed op read status'
[[ ! -e "$fixture/bin/no-launch-target-called" ]] || fail 'failed stdin-only lookup does not launch the child'
pass 'failed stdin-only lookup does not launch the child'

set +e
stdin_child_failure_output="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject-stdin op://known-vault/known-item/credential -- bash -c 'exit 23' 2>&1)"
stdin_child_failure_status=$?
set -e
[[ "$stdin_child_failure_status" -eq 23 ]] || fail 'stdin-only delivery preserves child failure status'
pass 'stdin-only delivery preserves child failure status'
assert_not_contains "$stdin_child_failure_output" 'UPLOAD_SECRET_SENTINEL' 'stdin-only child failure redacts secret bytes'

set +e
stdin_reference_error="$(DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject-stdin not-an-op-reference -- true 2>&1)"
stdin_reference_status=$?
set -e
[[ "$stdin_reference_status" -eq 2 ]] || fail 'stdin-only delivery rejects a non-op reference with usage status'
pass 'stdin-only delivery rejects a non-op reference with usage status'
assert_contains "$stdin_reference_error" 'reference-invalid' 'stdin-only delivery has a stable reference validation code'

rm -f "$fixture/bin/no-launch-target-called"
set +e
DOTFILES_DIR="$fixture" PATH="$fixture/bin:$PATH" "$SUBJECT" inject EXPERIENCE_EXTENSION_UPLOAD_TOKEN op://known-vault/wrong-item/credential -- "$fixture/bin/no-launch-target" >/dev/null 2>&1
inject_failure_status=$?
set -e
[[ "$inject_failure_status" -eq 18 ]] || fail 'inject preserves failed op read status'
pass 'inject preserves failed op read status'
[[ ! -e "$fixture/bin/no-launch-target-called" ]] || fail 'failed inject lookup does not launch the child'
pass 'failed inject lookup does not launch the child'

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
