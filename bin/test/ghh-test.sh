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
  if [[ -n "${GHH_TEST_APILOG:-}" ]]; then
    echo "api-user" >> "$GHH_TEST_APILOG"
  fi
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

printf '%s|%s|%s\n' "${GH_TOKEN:-missing}" "${GH_PROMPT_DISABLED:-missing}" "$*" >> "${GHH_TEST_LOG:?}"
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

# --- gh routing: shim-aware resolution, child routing, recursion bound -------
#
# Production consumer: a repository-owned script that calls bare `gh` and cannot
# be edited (for example my-second-brain-plugin scripts/repository-readiness.ts,
# which spawns ["gh", ...args]). Machine policy requires those calls to reach gh
# with an explicitly selected account. The only way to route them is a `gh` shim
# first on PATH, which is exactly what makes ghh call itself.

assert_at_most() {
  local ceiling="$1"
  local actual="$2"
  local name="$3"

  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual <= ceiling )); then
    pass "$name"
  else
    fail "$name" "expected at most $ceiling, got '$actual'"
  fi
}

assert_contains "$help_output" "ghh run --account <login> -- <command> [arguments...]" "help discovers run"
assert_contains "$help_output" "71   gh routing is recursive" "help documents the recursion exit code"
assert_contains "$help_output" "GHH_GH_BIN" "help documents the real-gh override"

# A PATH with no dotfiles bin directory. Routing that survives here proves the
# shim reaches ghh by absolute path rather than through PATH lookup, which is
# the restricted-PATH failure this repair exists to close.
RESTRICTED_PATH="$FAKE_BIN:/usr/bin:/bin"

run_log="$TEST_DIR/run.log"
cat > "$TEST_DIR/child.sh" <<'CHILD'
#!/usr/bin/env bash
set -euo pipefail
dirname "$(command -v gh)" > "$GHH_TEST_SHIMDIR"
cat "$(command -v gh)" > "$GHH_TEST_SHIMCOPY"
printf 'child-gh-token:%s\n' "${GH_TOKEN:-unset}"
printf 'child-github-token:%s\n' "${GITHUB_TOKEN:-unset}"
gh api rate_limit
gh pr view 34
gh issue list
CHILD
chmod +x "$TEST_DIR/child.sh"

run_result="$(PATH="$RESTRICTED_PATH" GH_TOKEN=ambient GITHUB_TOKEN=ambient \
  GHH_TEST_LOG="$run_log" GHH_TEST_APILOG="$TEST_DIR/apiuser.log" \
  GHH_TEST_SHIMDIR="$TEST_DIR/shimdir" GHH_TEST_SHIMCOPY="$TEST_DIR/shimcopy" \
  run_cmd "$CLI" run --account myagentdojo -- "$TEST_DIR/child.sh")"
run_status="$(sed -n '1p' <<< "$run_result")"
run_output="$(sed -n '2,$p' <<< "$run_result")"

assert_equals "0" "$run_status" "run exits zero when the child succeeds"
assert_equals "token-myagentdojo|1|api rate_limit
token-myagentdojo|1|pr view 34
token-myagentdojo|1|issue list" "$(< "$run_log")" "every bare gh call in the child reaches gh with the selected token"
assert_contains "$run_output" "forwarded:pr view 34" "run passes child stdout through"
assert_contains "$run_output" "child-gh-token:unset" "run withholds GH_TOKEN from the child tree"
assert_contains "$run_output" "child-github-token:unset" "run withholds GITHUB_TOKEN from the child tree"
assert_not_contains "$run_output" "token-myagentdojo" "run output contains no token"

# Three routed gh calls, one identity round trip. Without the per-run mark, a
# script making many gh calls pays one gh api user call for each of them.
assert_equals "1" "$(wc -l < "$TEST_DIR/apiuser.log" | tr -d ' ')" "run verifies the account once for the whole child tree"

shim_dir="$(< "$TEST_DIR/shimdir")"
assert_contains "$shim_dir" "ghh-shim." "run puts its own shim first on the child PATH"
if [[ -e "$shim_dir" ]]; then
  fail "run removes the shim directory when the child exits" "still present: $shim_dir"
else
  pass "run removes the shim directory when the child exits"
fi

status_log="$TEST_DIR/run-status.log"
run_fail_result="$(PATH="$RESTRICTED_PATH" GHH_TEST_LOG="$status_log" \
  run_cmd "$CLI" run --account nathanvale -- /usr/bin/env bash -c 'exit 23')"
assert_equals "23" "$(sed -n '1p' <<< "$run_fail_result")" "run preserves the child exit status"
assert_contains "$(sed -n '2,$p' <<< "$run_fail_result")" "retry depends on the child command" "run failure states retry boundary"

run_usage_result="$(run_cmd "$CLI" run --account nathanvale)"
assert_equals "64" "$(sed -n '1p' <<< "$run_usage_result")" "run without a command exits 64"
assert_contains "$(sed -n '2,$p' <<< "$run_usage_result")" "A command is required after --" "run without a command explains repair"

run_account_result="$(run_cmd "$CLI" run -- /usr/bin/true)"
assert_equals "64" "$(sed -n '1p' <<< "$run_account_result")" "run without an account exits 64"

# GHH_GH_BIN is the documented escape hatch for a PATH that ghh cannot clean.
override_log="$TEST_DIR/override.log"
override_result="$(PATH="/usr/bin:/bin" GHH_GH_BIN="$FAKE_BIN/gh" GHH_TEST_LOG="$override_log" \
  run_cmd "$CLI" exec --account nathanvale -- pr view 305)"
assert_equals "0" "$(sed -n '1p' <<< "$override_result")" "GHH_GH_BIN resolves gh when PATH holds none"
assert_equals "token-nathanvale|1|pr view 305" "$(< "$override_log")" "GHH_GH_BIN forwards to the named binary"

override_bad_result="$(PATH="$FAKE_BIN:$PATH" GHH_GH_BIN="$TEST_DIR/absent-gh" run_cmd "$CLI" check --account nathanvale)"
assert_equals "69" "$(sed -n '1p' <<< "$override_bad_result")" "an unusable GHH_GH_BIN exits 69"
assert_contains "$(sed -n '2,$p' <<< "$override_bad_result")" "GHH_GH_BIN is not an executable gh binary" "an unusable GHH_GH_BIN explains repair"

# A foreign wrapper carries no ghh marker, so resolution cannot skip it. The
# claim here is that the loop is bounded and named, not that it never starts.
# The wrapper caps itself at 20 so a lost depth guard fails these rows instead
# of forking until the process table is exhausted.
FOREIGN_BIN="$TEST_DIR/foreign"
FOREIGN_COUNT="$TEST_DIR/foreign.count"
mkdir -p "$FOREIGN_BIN"
echo 0 > "$FOREIGN_COUNT"
cat > "$FOREIGN_BIN/gh" <<FOREIGN
#!/usr/bin/env bash
set -euo pipefail
count=\$(( \$(cat "$FOREIGN_COUNT") + 1 ))
echo "\$count" > "$FOREIGN_COUNT"
if (( count > 20 )); then
  echo "foreign wrapper safety cap reached" >&2
  exit 99
fi
exec "$CLI" exec --account nathanvale -- "\$@"
FOREIGN
chmod +x "$FOREIGN_BIN/gh"

foreign_log="$TEST_DIR/foreign.log"
foreign_result="$(PATH="$FOREIGN_BIN:$FAKE_BIN:/usr/bin:/bin" GHH_TEST_LOG="$foreign_log" \
  run_cmd "$CLI" exec --account nathanvale -- api rate_limit)"
foreign_status="$(sed -n '1p' <<< "$foreign_result")"
foreign_output="$(sed -n '2,$p' <<< "$foreign_result")"
foreign_count="$(< "$FOREIGN_COUNT")"

assert_equals "71" "$foreign_status" "a foreign gh wrapper that calls ghh back exits 71"
assert_contains "$foreign_output" "routes back into ghh" "recursive routing names the cause"
assert_contains "$foreign_output" "Set GHH_GH_BIN to the real gh binary" "recursive routing names the repair"
assert_at_most 12 "$foreign_count" "recursive routing is bounded well below the wrapper safety cap"
assert_not_contains "$foreign_output" "token-nathanvale" "recursive routing output contains no token"

# A ghh shim can outlive the run that wrote it, or sit on PATH because an
# operator put it there. Outside a run there is no GHH_GH_BIN to short-circuit
# resolution, so the marker is the only thing standing between ghh and itself.
# The shim used here is the one ghh wrote during the run above, so no file in
# this test restates the marker ghh writes.
STANDING_BIN="$TEST_DIR/standing"
mkdir -p "$STANDING_BIN"
cp "$TEST_DIR/shimcopy" "$STANDING_BIN/gh"
chmod +x "$STANDING_BIN/gh"

standing_log="$TEST_DIR/standing.log"
standing_result="$(PATH="$STANDING_BIN:$FAKE_BIN:/usr/bin:/bin" GHH_TEST_LOG="$standing_log" \
  run_cmd "$CLI" exec --account nathanvale -- pr view 305)"
assert_equals "0" "$(sed -n '1p' <<< "$standing_result")" "a standing ghh shim on PATH does not capture ghh outside a run"
assert_equals "token-nathanvale|1|pr view 305" "$(< "$standing_log")" "resolution walks past the shim to the real gh with the requested account"

# The complement of the row above. ghh's own shim is marked, so resolution skips
# it and the same PATH shape routes exactly once per gh call instead of looping.
marked_count="$TEST_DIR/marked.count"
echo 0 > "$marked_count"
cat > "$TEST_DIR/count-child.sh" <<COUNTCHILD
#!/usr/bin/env bash
set -euo pipefail
before="\$(cat "$marked_count")"
gh api rate_limit >/dev/null
gh_path="\$(command -v gh)"
echo "\$(( before + 1 ))" > "$marked_count"
COUNTCHILD
chmod +x "$TEST_DIR/count-child.sh"

marked_log="$TEST_DIR/marked.log"
marked_status="$(PATH="$RESTRICTED_PATH" GHH_TEST_LOG="$marked_log" \
  run_cmd "$CLI" run --account nathanvale -- "$TEST_DIR/count-child.sh" | sed -n '1p')"
assert_equals "0" "$marked_status" "a marked ghh shim first on PATH does not recurse"
assert_equals "1" "$(wc -l < "$marked_log" | tr -d ' ')" "one child gh call reaches the real gh exactly once"

echo
echo "$PASSED passed, $FAILED failed"

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
