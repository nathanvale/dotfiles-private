#!/usr/bin/env bash
# Contract tests for the server-profile LM Studio recovery supervisor.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd -P)"
SUBJECT="$REPO_ROOT/bin/system/lm-studio-ensure.sh"
PLIST="$REPO_ROOT/config/launchd/com.nathanvale.lm-studio-ensure.plist"
TEST_ROOT="$(mktemp -d)"
PASSED=0
RUN_STATUS=0
RUN_OUTPUT=''

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok %d - %s\n' "$PASSED" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  printf '  %s\n' "$2" >&2
  exit 1
}

assert_status() {
  local expected="$1" name="$2"
  [[ "$RUN_STATUS" -eq "$expected" ]] ||
    fail "$name" "expected status $expected, got $RUN_STATUS: $RUN_OUTPUT"
  pass "$name"
}

assert_contains() {
  local value="$1" expected="$2" name="$3"
  [[ "$value" == *"$expected"* ]] || fail "$name" "missing [$expected] in [$value]"
  pass "$name"
}

assert_log_contains() {
  local fixture="$1" expected="$2" name="$3"
  grep -Fxq "$expected" "$fixture/commands.log" ||
    fail "$name" "missing [$expected] in command log"
  pass "$name"
}

assert_log_excludes() {
  local fixture="$1" unexpected="$2" name="$3"
  if grep -Fq "$unexpected" "$fixture/commands.log"; then
    fail "$name" "found unexpected [$unexpected] in command log"
  fi
  pass "$name"
}

write_native_models() {
  local fixture="$1" context="$2" parallel="$3"
  if [[ "$context" == absent ]]; then
    printf '{"models":[{"key":"qwen3.8-27b","loaded_instances":[]}]}\n' >"$fixture/native.json"
    return
  fi

  printf '{"models":[{"key":"qwen3.8-27b","loaded_instances":[{"id":"qwen3.8-27b","config":{"context_length":%s,"parallel":%s}}]}]}\n' \
    "$context" "$parallel" >"$fixture/native.json"
}

make_fixture() {
  local fixture="$1" daemon_state="$2" api_state="$3" context="$4" parallel="$5"
  mkdir -p "$fixture/bin" "$fixture/home/.local/state"
  printf '%s\n' "$daemon_state" >"$fixture/daemon.state"
  printf '%s\n' "$api_state" >"$fixture/api.state"
  printf 'absent\n' >"$fixture/core.state"
  : >"$fixture/commands.log"
  write_native_models "$fixture" "$context" "$parallel"

  cat >"$fixture/bin/lms" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$LM_STUDIO_FIXTURE/commands.log"

case "${1:-} ${2:-}" in
  'daemon status')
    if [[ "$(<"$LM_STUDIO_FIXTURE/daemon.state")" == running ]]; then
      printf '{"status":"running","pid":123,"isDaemon":true}\n'
    else
      printf '{"status":"stopped","isDaemon":true}\n'
    fi
    ;;
  'daemon up')
    printf 'running\n' >"$LM_STUDIO_FIXTURE/daemon.state"
    printf '{"status":"running","pid":124,"isDaemon":true}\n'
    ;;
  'server start')
    printf 'ready\n' >"$LM_STUDIO_FIXTURE/api.state"
    printf 'server started\n'
    ;;
  'load '*)
    if [[ "${LM_STUDIO_FIXTURE_HANG_LOAD:-0}" == 1 ]]; then
      exec /bin/sleep 30
    fi
    cat >"$LM_STUDIO_FIXTURE/native.json" <<'JSON'
{"models":[{"key":"qwen3.8-27b","loaded_instances":[{"id":"qwen3.8-27b","config":{"context_length":32768,"parallel":4}}]}]}
JSON
    printf 'model loaded\n'
    ;;
  *)
    printf 'unexpected lms command: %s\n' "$*" >&2
    exit 64
    ;;
esac
STUB
  chmod 700 "$fixture/bin/lms"

  cat >"$fixture/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
[[ "$(<"$LM_STUDIO_FIXTURE/api.state")" == ready ]] || exit 22
case "$url" in
  */api/v1/models) cat "$LM_STUDIO_FIXTURE/native.json" ;;
  */v1/models)
    if grep -Fq '"id":"qwen3.8-27b"' "$LM_STUDIO_FIXTURE/native.json"; then
      printf '{"data":[{"id":"qwen3.8-27b"}]}\n'
    else
      printf '{"data":[]}\n'
    fi
    ;;
  *) exit 22 ;;
esac
STUB
  chmod 700 "$fixture/bin/curl"

  cat >"$fixture/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(<"$LM_STUDIO_FIXTURE/core.state")" == running ]]
STUB
  chmod 700 "$fixture/bin/pgrep"
}

run_subject() {
  local fixture="$1"
  shift
  set +e
  RUN_OUTPUT="$(env \
    HOME="$fixture/home" \
    DOTFILES_PROFILE=server \
    LM_STUDIO_FIXTURE="$fixture" \
    LM_STUDIO_LMS_BIN="$fixture/bin/lms" \
    LM_STUDIO_CURL_BIN="$fixture/bin/curl" \
    LM_STUDIO_JQ_BIN="$(command -v jq)" \
    LM_STUDIO_PGREP_BIN="$fixture/bin/pgrep" \
    LM_STUDIO_LOCK_DIR="$fixture/lock" \
    LM_STUDIO_COMMAND_TIMEOUT=2 \
    LM_STUDIO_HTTP_TIMEOUT=1 \
    LM_STUDIO_READY_ATTEMPTS=3 \
    LM_STUDIO_READY_DELAY=0 \
    "$@" \
    "$SUBJECT" 2>&1)"
  RUN_STATUS=$?
  set -e
}

healthy="$TEST_ROOT/healthy"
make_fixture "$healthy" running ready 32768 4
run_subject "$healthy"
assert_status 0 'healthy service exits zero'
assert_contains "$RUN_OUTPUT" 'status=noop reason=healthy' 'healthy service reports a no-op'
assert_log_excludes "$healthy" 'daemon up' 'healthy service does not start the daemon'
assert_log_excludes "$healthy" 'server start' 'healthy service does not start the server'
assert_log_excludes "$healthy" 'load ' 'healthy service does not load a model'

recovery="$TEST_ROOT/recovery"
make_fixture "$recovery" stopped down absent 4
run_subject "$recovery"
assert_status 0 'missing stack is recovered'
assert_contains "$RUN_OUTPUT" 'status=repaired actions=daemon,server,model' 'recovery reports each repaired layer'
assert_log_contains "$recovery" 'daemon up --json' 'recovery starts one daemon'
assert_log_contains "$recovery" 'server start --port 1234 --bind 127.0.0.1' 'recovery starts the loopback server'
assert_log_contains "$recovery" 'load qwen3.8-27b --identifier qwen3.8-27b --context-length 32768 --parallel 4 --no-speculative-draft-mtp --yes' 'recovery loads the exact model profile'

stuck_core="$TEST_ROOT/stuck-core"
make_fixture "$stuck_core" stopped down absent 4
printf 'running\n' >"$stuck_core/core.state"
run_subject "$stuck_core"
assert_status 5 'an unready existing core exits with a distinct status'
assert_contains "$RUN_OUTPUT" 'status=error cause=core-process-unready' 'an unready existing core is explicit'
assert_log_excludes "$stuck_core" 'daemon up' 'an existing core never triggers a second daemon'
assert_log_excludes "$stuck_core" 'server start' 'an unready core is not mutated blindly'

drift="$TEST_ROOT/drift"
make_fixture "$drift" running ready 16384 4
run_subject "$drift"
assert_status 3 'configuration drift exits with a distinct status'
assert_contains "$RUN_OUTPUT" 'status=error cause=model-config-drift' 'configuration drift is explicit'
assert_log_excludes "$drift" 'load ' 'configuration drift does not trigger a disruptive reload'
assert_log_excludes "$drift" 'unload ' 'configuration drift never unloads the live model'

locked="$TEST_ROOT/locked"
make_fixture "$locked" running ready 32768 4
mkdir "$locked/lock"
printf '%s\n' "$$" >"$locked/lock/pid"
run_subject "$locked"
assert_status 0 'concurrent invocation exits zero'
assert_contains "$RUN_OUTPUT" 'status=noop reason=already-running' 'concurrent invocation reports the live owner'
assert_log_excludes "$locked" 'daemon' 'concurrent invocation performs no daemon command'

timeout="$TEST_ROOT/timeout"
make_fixture "$timeout" running ready absent 4
run_subject "$timeout" env LM_STUDIO_FIXTURE_HANG_LOAD=1 LM_STUDIO_COMMAND_TIMEOUT=1
assert_status 4 'model load timeout exits with a distinct status'
assert_contains "$RUN_OUTPUT" 'status=error cause=model-load-timeout' 'model load timeout is explicit'
assert_log_contains "$timeout" 'load qwen3.8-27b --identifier qwen3.8-27b --context-length 32768 --parallel 4 --no-speculative-draft-mtp --yes' 'timed out load attempted only the exact model'

[[ "$(/usr/bin/plutil -extract StartInterval raw -o - "$PLIST")" == 60 ]] ||
  fail 'launch agent uses a bounded recovery interval' 'StartInterval is not 60'
pass 'launch agent uses a 60 second recovery interval'

if /usr/bin/plutil -extract KeepAlive raw -o - "$PLIST" >/dev/null 2>&1; then
  fail 'launch agent has no immediate failure restart loop' 'KeepAlive is present'
fi
pass 'launch agent has no immediate failure restart loop'

if /usr/bin/plutil -extract RunAtLoad raw -o - "$PLIST" >/dev/null 2>&1; then
  fail 'launch agent leaves login startup to the LM Studio core' 'RunAtLoad is present'
fi
pass 'launch agent leaves login startup to the LM Studio core'

[[ "$(/usr/bin/plutil -extract ProcessType raw -o - "$PLIST")" == Background ]] ||
  fail 'launch agent declares background process type' 'ProcessType is not Background'
pass 'launch agent declares background process type'

expected=28
[[ "$PASSED" -eq "$expected" ]] || fail 'assertion count is pinned' "expected $expected, observed $PASSED"
printf '1..%d\n' "$PASSED"
