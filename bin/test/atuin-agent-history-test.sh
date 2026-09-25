#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CLI="$REPO_ROOT/bin/atuin-agent-history"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN="$TEST_ROOT/atuin"
FAKE_LOG="$TEST_ROOT/atuin.args"
trap 'rm -rf "$TEST_ROOT"' EXIT

assertion_count=0

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing [$needle])"
  pass "$label"
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (found [$needle])"
  pass "$label"
}

# The fake logs one Atuin argument per line, so a flag's value is the next line.
# Exact positions, not substrings: `--search-mode` contains `search`, and a date
# argument contains most digits.
assert_atuin_value() {
  local flag="$1" expected="$2" label="$3" actual
  actual="$(awk -v flag="$flag" 'found { print; exit } $0 == flag { found = 1 }' <<<"$atuin_args")"
  [[ "$actual" == "$expected" ]] || fail "$label (expected [$expected] after [$flag], got [$actual])"
  pass "$label"
}

run_cli() {
  local stdout_file="$TEST_ROOT/stdout" stderr_file="$TEST_ROOT/stderr"
  set +e
  ATUIN_SESSION="synthetic-session" \
    ATUIN_AGENT_HISTORY_BIN="$FAKE_BIN" ATUIN_AGENT_HISTORY_TEST_LOG="$FAKE_LOG" \
    ATUIN_AGENT_HISTORY_TEST_MODE="${ATUIN_AGENT_HISTORY_TEST_MODE:-success}" \
    "$CLI" "$@" >"$stdout_file" 2>"$stderr_file"
  cli_status=$?
  set -e
  cli_stdout="$(<"$stdout_file")"
  cli_stderr="$(<"$stderr_file")"
}

cat >"$FAKE_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"${ATUIN_AGENT_HISTORY_TEST_LOG:?}"
case "${ATUIN_AGENT_HISTORY_TEST_MODE:-success}" in
  no-match) exit 1 ;;
  fail) printf 'synthetic-secret-from-stderr\n' >&2; exit 17 ;;
esac
printf '2026-08-24 09:00:00\0370\037git status --short\0'
printf '2026-08-24 09:01:00\0371\037API_TOKEN=synthetic-env-secret curl --authorization=synthetic-bearer https://user:synthetic-password@example.com/private synthetic-positional-secret\0'
printf '2026-08-24 09:02:00\037-1\037bash synthetic-script\0'
EOF
chmod +x "$FAKE_BIN"

[[ -x "$CLI" ]] || fail 'public executable is missing or not executable'
pass 'public executable exists and is executable'

help_output="$($CLI --help)"
assert_contains "$help_output" 'Read-only.' 'help declares the read-only contract'
assert_contains "$help_output" 'Raw commands, argument values, directories, hosts, and users are never' 'help declares the output privacy boundary'
assert_contains "$help_output" 'Avoid putting secret values in the query itself.' 'help names the query privacy limitation'

run_cli search --limit 3 --after 2026-08-23 --shell zsh -- frontier runner
[[ "$cli_status" -eq 0 ]] || fail "search exits zero (got $cli_status, stderr [$cli_stderr])"
pass 'search exits zero'
[[ -z "$cli_stderr" ]] || fail "successful search keeps stderr empty (got [$cli_stderr])"
pass 'successful search keeps stderr empty'
[[ "$(printf '%s\n' "$cli_stdout" | sed '/^$/d' | wc -l | tr -d ' ')" == '3' ]] || fail 'search emits three JSONL rows'
pass 'search emits one JSON object per result'
printf '%s\n' "$cli_stdout" | jq -e -c . >/dev/null || fail 'stdout is valid JSONL'
pass 'stdout is valid JSONL'

first_row="$(printf '%s\n' "$cli_stdout" | sed -n '1p')"
second_row="$(printf '%s\n' "$cli_stdout" | sed -n '2p')"
third_row="$(printf '%s\n' "$cli_stdout" | sed -n '3p')"
[[ "$(jq -r '.schemaVersion' <<<"$first_row")" == '2' ]] || fail 'rows declare schema version 2'
pass 'rows declare schema version 2'
[[ "$(jq -r '.program' <<<"$first_row")" == 'git' ]] || fail 'first row reports the program name'
pass 'first row reports the program name'
[[ "$(jq -r '.optionNames[0]' <<<"$first_row")" == '--short' ]] || fail 'first row reports the option name'
pass 'first row reports the option name'
[[ "$(jq -r '.argumentCount' <<<"$first_row")" == '2' ]] || fail 'first row reports the argument count'
pass 'first row reports the argument count'
[[ "$(jq -r '.exit' <<<"$second_row")" == '1' ]] || fail 'second row reports the exit status'
pass 'second row reports the exit status'
[[ "$(jq -r '.outcome' <<<"$first_row")" == 'success' ]] || fail 'zero exit maps to success'
pass 'zero exit maps to success'
[[ "$(jq -r '.outcome' <<<"$second_row")" == 'failure' ]] || fail 'positive exit maps to failure'
pass 'positive exit maps to failure'
[[ "$(jq -r '.outcome' <<<"$third_row")" == 'unknown' ]] || fail 'negative exit maps to unknown'
pass 'negative exit maps to unknown'
[[ "$(jq -r '.program' <<<"$second_row")" == 'curl' ]] || fail 'environment assignments are omitted before the program name'
pass 'environment assignments are omitted before the program name'
[[ "$(jq -r '.optionNames[0]' <<<"$second_row")" == '--authorization' ]] || fail 'option values are removed from long options'
pass 'option values are removed from long options'

assert_not_contains "$cli_stdout" 'synthetic-env-secret' 'stdout omits environment values'
assert_not_contains "$cli_stdout" 'synthetic-bearer' 'stdout omits option values'
assert_not_contains "$cli_stdout" 'synthetic-password' 'stdout omits URL credentials and paths'
assert_not_contains "$cli_stdout" 'synthetic-positional-secret' 'stdout omits positional argument values'
assert_not_contains "$cli_stdout" 'frontier' 'stdout omits query terms'

atuin_args="$(<"$FAKE_LOG")"
[[ "$(sed -n 1p <<<"$atuin_args")" == 'search' ]] || fail 'the wrapper invokes only the Atuin search command'
pass 'the wrapper invokes only the Atuin search command'
assert_atuin_value '--author' '$all-user' 'the wrapper limits results to human-authored history'
assert_atuin_value '--search-mode' 'fulltext' 'the wrapper uses explicit full-text search'
assert_atuin_value '--limit' '3' 'the wrapper forwards the bounded result limit'
assert_not_contains "$atuin_args" '--delete' 'the wrapper never forwards Atuin deletion flags'

run_cli recent --limit 2
[[ "$cli_status" -eq 0 ]] || fail "recent exits zero (got $cli_status, stderr [$cli_stderr])"
pass 'recent exits zero'
[[ -z "$cli_stderr" ]] || fail "recent keeps stderr empty (got [$cli_stderr])"
pass 'recent keeps stderr empty'
printf '%s\n' "$cli_stdout" | jq -e -c . >/dev/null || fail 'recent stdout is valid JSONL'
pass 'recent stdout is valid JSONL'
atuin_args="$(<"$FAKE_LOG")"
assert_not_contains "$atuin_args" '--filter-mode' 'recent reads bounded cross-session user history by default'

run_cli recent --limit 2 --session
[[ "$cli_status" -eq 0 ]] || fail "session recent exits zero (got $cli_status, stderr [$cli_stderr])"
pass 'session recent exits zero'
[[ -z "$cli_stderr" ]] || fail "session recent keeps stderr empty (got [$cli_stderr])"
pass 'session recent keeps stderr empty'
printf '%s\n' "$cli_stdout" | jq -e -c . >/dev/null || fail 'session recent stdout is valid JSONL'
pass 'session recent stdout is valid JSONL'

atuin_args="$(<"$FAKE_LOG")"
assert_atuin_value '--filter-mode' 'session' 'session recent selects the inherited Atuin session'
assert_atuin_value '--author' '$all-user' 'session recent remains limited to human-authored history'
assert_not_contains "$atuin_args" 'synthetic-session' 'session identity stays in the environment'

run_cli search --session -- git
[[ "$cli_status" -eq 0 ]] || fail "session search exits zero (got $cli_status, stderr [$cli_stderr])"
pass 'session search exits zero'
atuin_args="$(<"$FAKE_LOG")"
assert_atuin_value '--filter-mode' 'session' 'session search selects the inherited Atuin session'

set +e
env -u ATUIN_SESSION \
  ATUIN_AGENT_HISTORY_BIN="$FAKE_BIN" ATUIN_AGENT_HISTORY_TEST_LOG="$FAKE_LOG" \
  "$CLI" recent --session >"$TEST_ROOT/no-session.stdout" 2>"$TEST_ROOT/no-session.stderr"
no_session_status=$?
set -e
[[ "$no_session_status" -eq 64 ]] || fail "missing Atuin session exits 64 (got $no_session_status)"
pass 'missing Atuin session exits 64'
no_session_stderr="$(<"$TEST_ROOT/no-session.stderr")"
assert_contains "$no_session_stderr" 'ATUIN_SESSION is unavailable' 'missing session names the repair path'
[[ ! -s "$TEST_ROOT/no-session.stdout" ]] || fail 'missing session keeps stdout empty'
pass 'missing session keeps stdout empty'

ATUIN_AGENT_HISTORY_TEST_MODE=no-match run_cli search -- absent-synthetic-query
[[ "$cli_status" -eq 0 ]] || fail "Atuin no-match exits zero (got $cli_status)"
pass 'Atuin no-match exits zero'
[[ -z "$cli_stdout" && -z "$cli_stderr" ]] || fail 'Atuin no-match keeps both streams empty'
pass 'Atuin no-match keeps both streams empty'

run_cli search --delete -- frontier
[[ "$cli_status" -eq 64 ]] || fail "unknown arguments exit 64 (got $cli_status)"
pass 'unknown arguments exit 64'
assert_contains "$cli_stderr" 'unknown argument: --delete' 'mutation-shaped arguments name their rejection'
[[ -z "$cli_stdout" ]] || fail 'argument errors keep stdout empty'
pass 'argument errors keep stdout empty'

run_cli search --limit 51 -- frontier
[[ "$cli_status" -eq 64 ]] || fail "an excessive limit exits 64 (got $cli_status)"
pass 'an excessive limit exits 64'
assert_contains "$cli_stderr" 'integer from 1 to 50' 'the limit failure names the bounded repair'

set +e
ATUIN_AGENT_HISTORY_BIN="$FAKE_BIN" ATUIN_AGENT_HISTORY_TEST_LOG="$FAKE_LOG" ATUIN_AGENT_HISTORY_TEST_MODE=fail \
  "$CLI" search -- frontier >"$TEST_ROOT/fail.stdout" 2>"$TEST_ROOT/fail.stderr"
failure_status=$?
set -e
[[ "$failure_status" -eq 17 ]] || fail "Atuin failure preserves exit status (got $failure_status)"
pass 'Atuin failure preserves its exit status'
failure_stderr="$(<"$TEST_ROOT/fail.stderr")"
assert_contains "$failure_stderr" 'Atuin search failed (exit 17)' 'Atuin failure emits a bounded diagnostic'
assert_not_contains "$failure_stderr" 'synthetic-secret-from-stderr' 'Atuin stderr is not forwarded'
[[ ! -s "$TEST_ROOT/fail.stdout" ]] || fail 'Atuin failures keep stdout empty'
pass 'Atuin failures keep stdout empty'

printf '1..%d\n' "$assertion_count"
