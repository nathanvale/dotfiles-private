#!/usr/bin/env bash
# Regression for the ci-reproduce runner's VM mode: TERM while the guest
# command hangs must clean up promptly. The real script runs with a real TERM
# and a real lockf lock; a fake `tart` stands in for Tart, recording each call
# and keeping `run` (the VM) and the guest `exec -i` (the command) alive.
# MATCH_MACOS_RUNNER_SCRIPT points the test at another copy, for the RED run.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${MATCH_MACOS_RUNNER_SCRIPT:-$REPO_ROOT/config/agents/plugins/personal/library/ci-reproduce/scripts/match-macos-runner.sh}"

if [[ "$(uname -s)" != Darwin ]]; then
  printf 'ok 1 # SKIP lockf and Tart exist only on macOS; this boundary is unproved here\n1..1\n'
  exit 0
fi

TEST_ROOT="$(mktemp -d)"
FAKE_BIN="$TEST_ROOT/bin"
export FAKE_TART_DIR="$TEST_ROOT/tart"
export XDG_STATE_HOME="$TEST_ROOT/state"
script_pid=""

# Stops only processes this test started, by their recorded process ids.
cleanup() {
  local pid_file pid
  if [[ -n "$script_pid" ]]; then kill -KILL "$script_pid" 2>/dev/null || true; fi
  for pid_file in "$FAKE_TART_DIR/run.pid" "$FAKE_TART_DIR/guest.pid"; do
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

assertion_count=0

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  [[ -f "$TEST_ROOT/out" ]] && sed 's/^/# /' "$TEST_ROOT/out" >&2
  exit 1
}

mkdir -p "$FAKE_BIN" "$FAKE_TART_DIR"
cat >"$FAKE_BIN/tart" <<'FAKE'
#!/bin/bash
set -u
printf '%s\n' "$*" >>"$FAKE_TART_DIR/calls"
case "$1" in
get) printf '{\n  "Memory" : 7168,\n  "CPU" : 3\n}\n' ;;
list) printf 'Source Name State\nlocal base stopped\n' ;;
run)
  echo $$ >"$FAKE_TART_DIR/run.pid"
  exec sleep 600
  ;;
stop) kill "$(cat "$FAKE_TART_DIR/run.pid")" 2>/dev/null || true ;;
exec)
  if [[ "$2" == -i ]]; then
    cat >"$FAKE_TART_DIR/guest-script"
    echo $$ >"$FAKE_TART_DIR/guest.pid"
    : >"$FAKE_TART_DIR/guest-started"
    exec sleep 600
  fi
  ;;
esac
exit 0
FAKE
chmod +x "$FAKE_BIN/tart"

PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" --vm base --repo owner/name --ref main -- 'true' \
  </dev/null >"$TEST_ROOT/out" 2>&1 &
script_pid=$!

# Event: the fake guest has started the command.
for _ in $(seq 1 300); do
  [[ -f "$FAKE_TART_DIR/guest-started" ]] && break
  kill -0 "$script_pid" 2>/dev/null || fail "the script exited before the guest command started"
  sleep 0.1
done
[[ -f "$FAKE_TART_DIR/guest-started" ]] || fail "the guest command did not start within 30 s"
pass "the guest command is running in the VM"

kill -TERM "$script_pid"
for _ in $(seq 1 200); do
  kill -0 "$script_pid" 2>/dev/null || break
  sleep 0.1
done
kill -0 "$script_pid" 2>/dev/null && fail "the script is still running 20 s after TERM"
status=0
wait "$script_pid" || status=$?
script_pid=""
[[ "$status" == 143 ]] || fail "the script exits 143 after TERM (got $status)"
pass "the script exits 143 within 20 s of TERM"

calls="$(cat "$FAKE_TART_DIR/calls")"
clone="$(awk '$1 == "clone" && $2 == "base" { print $3 }' <<<"$calls")"
[[ -n "$clone" && "$clone" != base ]] || fail "the script cloned the base before running"
grep -Eq "^stop( .*)? $clone\$" <<<"$calls" || fail "the clone $clone was stopped"
pass "the clone was stopped"
grep -qx "delete $clone" <<<"$calls" || fail "the clone $clone was deleted"
pass "the clone was deleted"
grep -qx "delete base" <<<"$calls" && fail "the base VM was kept"
pass "the base VM was kept"

lockf -k -s -t 0 "$XDG_STATE_HOME/ci-reproduce/.vm.lock" true ||
  fail "the VM lock is free after the script exits"
pass "the VM lock is free"

for name in run guest; do
  pid="$(cat "$FAKE_TART_DIR/$name.pid")"
  kill -0 "$pid" 2>/dev/null && fail "the fake $name process $pid is gone"
done
pass "no VM or guest process is left behind"

printf '1..%d\n' "$assertion_count"
