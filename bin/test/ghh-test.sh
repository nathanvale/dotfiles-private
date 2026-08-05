#!/usr/bin/env bash
# ghh contract and concurrent identity tests.

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLI="$(CDPATH='' cd "$SCRIPT_DIR/.." && pwd -P)/ghh"
TEST_DIR="$(mktemp -d)"
FAKE_BIN="$TEST_DIR/bin"
PASSED=0
FAILED=0

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

pass() {
  echo "ok - $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "not ok - $1"
  echo "  $2"
  FAILED=$((FAILED + 1))
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local name="$3"

  if grep -Fq -- "$needle" <<< "$haystack"; then
    pass "$name"
  else
    fail "$name" "missing: $needle"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local name="$3"

  if grep -Fq -- "$needle" <<< "$haystack"; then
    fail "$name" "unexpected: $needle"
  else
    pass "$name"
  fi
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local name="$3"

  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    fail "$name" "expected '$expected', got '$actual'"
  fi
}

run_cmd() {
  local output
  local status

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e

  printf '%s\n' "$status"
  printf '%s\n' "$output"
}

mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "auth" && "${2:-}" == "token" ]]; then
  if [[ -n "${GH_TOKEN:-}" || -n "${GITHUB_TOKEN:-}" ]]; then
    echo "ambient token reached credential lookup" >&2
    exit 91
  fi
  account=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--user" ]]; then
      account="${2:-}"
      break
    fi
    shift
  done
  case "$account" in
    nathanvale|myagentdojo) printf 'token-%s\n' "$account" ;;
    *) echo "no token for $account" >&2; exit 1 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "api" && "${2:-}" == "user" ]]; then
  case "${GHH_TEST_IDENTITY_OVERRIDE:-${GH_TOKEN:-}}" in
    token-nathanvale) echo "nathanvale" ;;
    token-myagentdojo) echo "myagentdojo" ;;
    *) echo "unknown identity" >&2; exit 1 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "auth" && "${2:-}" == "switch" ]]; then
  echo "global auth switch called" >&2
  exit 92
fi

printf '%s|%s|%s\n' "${GH_TOKEN:-missing}" "${GH_PROMPT_DISABLED:-missing}" "$*" > "${GHH_TEST_LOG:?}"
printf 'forwarded:%s\n' "$*"
exit "${GHH_TEST_FORWARD_STATUS:-0}"
EOF
chmod +x "$FAKE_BIN/gh"

help_output="$($CLI --help)"
assert_contains "$help_output" "ghh check --account <login>" "help discovers check"
assert_contains "$help_output" "ghh exec --account <login> -- <gh arguments...>" "help discovers exec"
assert_contains "$help_output" "Never changes the active gh account" "help explains concurrency"
assert_contains "$help_output" "ghh check --account nathanvale --json" "help includes smoke command"

missing_result="$(run_cmd "$CLI" check)"
missing_status="$(sed -n '1p' <<< "$missing_result")"
missing_output="$(sed -n '2,$p' <<< "$missing_result")"
assert_equals "64" "$missing_status" "missing account exits 64"
assert_contains "$missing_output" "--account is required" "missing account explains repair"

check_json="$(PATH="$FAKE_BIN:$PATH" "$CLI" check --account nathanvale --json)"
assert_equals "ok" "$(jq -r '.status' <<< "$check_json")" "check json reports success"
assert_equals "nathanvale" "$(jq -r '.account' <<< "$check_json")" "check json reports verified account"
assert_equals "read" "$(jq -r '.side_effect' <<< "$check_json")" "check json declares read-only stance"
assert_equals "true" "$(jq -r '.retry_safe' <<< "$check_json")" "check json declares safe retry"
assert_equals "true" "$(jq -r '.run_id | length > 0' <<< "$check_json")" "check json includes run correlation"
assert_not_contains "$check_json" "token-nathanvale" "check json redacts token"

unknown_result="$(PATH="$FAKE_BIN:$PATH" run_cmd "$CLI" check --account unknown --json)"
unknown_status="$(sed -n '1p' <<< "$unknown_result")"
unknown_output="$(sed -n '2,$p' <<< "$unknown_result")"
assert_equals "69" "$unknown_status" "unknown account exits 69"
assert_contains "$unknown_output" '"category":"account_unavailable"' "unknown account is structured"
assert_not_contains "$unknown_output" "token-" "unknown account output contains no token"

mismatch_result="$(PATH="$FAKE_BIN:$PATH" GHH_TEST_IDENTITY_OVERRIDE=token-myagentdojo run_cmd "$CLI" check --account nathanvale --json)"
mismatch_status="$(sed -n '1p' <<< "$mismatch_result")"
mismatch_output="$(sed -n '2,$p' <<< "$mismatch_result")"
assert_equals "70" "$mismatch_status" "identity mismatch exits 70"
assert_contains "$mismatch_output" '"category":"identity_mismatch"' "identity mismatch is structured"
assert_contains "$mismatch_output" '"actual":"myagentdojo"' "identity mismatch reports actual login"
assert_not_contains "$mismatch_output" "token-" "identity mismatch output contains no token"

personal_log="$TEST_DIR/personal.log"
agent_log="$TEST_DIR/agent.log"
PATH="$FAKE_BIN:$PATH" GH_TOKEN=ambient GHH_TEST_LOG="$personal_log" "$CLI" exec --account nathanvale -- pr view 305 > "$TEST_DIR/personal.out" &
personal_pid=$!
PATH="$FAKE_BIN:$PATH" GH_TOKEN=ambient GHH_TEST_LOG="$agent_log" "$CLI" exec --account myagentdojo -- issue list -R myagentdojo/example > "$TEST_DIR/agent.out" &
agent_pid=$!
wait "$personal_pid"
wait "$agent_pid"

assert_equals "token-nathanvale|1|pr view 305" "$(< "$personal_log")" "personal process receives only personal token"
assert_equals "token-myagentdojo|1|issue list -R myagentdojo/example" "$(< "$agent_log")" "agent process receives only agent token"
assert_contains "$(< "$TEST_DIR/personal.out")" "forwarded:pr view 305" "personal stdout passes through"
assert_contains "$(< "$TEST_DIR/agent.out")" "forwarded:issue list" "agent stdout passes through"

forward_log="$TEST_DIR/forward.log"
forward_result="$(PATH="$FAKE_BIN:$PATH" GHH_TEST_LOG="$forward_log" GHH_TEST_FORWARD_STATUS=17 run_cmd "$CLI" exec --account nathanvale -- pr edit 305)"
forward_status="$(sed -n '1p' <<< "$forward_result")"
forward_output="$(sed -n '2,$p' <<< "$forward_result")"
assert_equals "17" "$forward_status" "exec preserves gh exit status"
assert_contains "$forward_output" "forwarded:pr edit 305" "exec preserves gh output"
assert_contains "$forward_output" "run_id=" "exec failure includes run correlation"
assert_contains "$forward_output" "retry depends on the forwarded gh command" "exec failure states retry boundary"
assert_not_contains "$forward_output" "token-nathanvale" "exec failure output contains no token"

echo
echo "$PASSED passed, $FAILED failed"

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
