#!/usr/bin/env bash
# Contract tests for the desktop-profile Herdr Projects report forward.
#
# Port detection runs the real lsof against a real test-owned loopback
# listener. SSH is a recording stub: the test proves which connection the
# forward would open and that it opens none while the port is held, not that
# the Mini accepts it.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd -P)"
SUBJECT="$REPO_ROOT/bin/system/herdr_report_forward.sh"
TEST_ROOT="$(mktemp -d)"
PASSED=0
LISTENER_PID=''
SUBJECT_PID=''

cleanup() {
  [[ -n "$SUBJECT_PID" ]] && kill "$SUBJECT_PID" 2>/dev/null || true
  [[ -n "$LISTENER_PID" ]] && kill "$LISTENER_PID" 2>/dev/null || true
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

# Wait up to five seconds for a file to contain a fixed string.
wait_for() {
  local file="$1" expected="$2"
  for _ in $(seq 1 50); do
    grep -Fq -- "$expected" "$file" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}

# Bind a free loopback port in a real process; its port lands in listener.port.
start_listener() {
  /usr/bin/python3 -I -c '
import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen()
print(s.getsockname()[1], flush=True)
time.sleep(60)
' >"$TEST_ROOT/listener.port" &
  LISTENER_PID=$!
  for _ in $(seq 1 50); do
    [[ -s "$TEST_ROOT/listener.port" ]] && break
    sleep 0.1
  done
  [[ -s "$TEST_ROOT/listener.port" ]] || fail 'test listener starts' 'no port reported'
}

# Unused loopback port: bind, read, release.
free_port() {
  /usr/bin/python3 -I -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
'
}

cat >"$TEST_ROOT/ssh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$FORWARD_FIXTURE_SSH_ARGS"
STUB
chmod 700 "$TEST_ROOT/ssh"

run_subject() {
  local remote_port="$1" port="$2" log="$3" args="$4"
  env \
    HERDR_REPORT_FORWARD_PORT="$remote_port" \
    HERDR_REPORT_FORWARD_LOCAL_PORT="$port" \
    HERDR_REPORT_FORWARD_POLL_SECONDS=0.2 \
    HERDR_REPORT_FORWARD_SSH_BIN="$TEST_ROOT/ssh" \
    FORWARD_FIXTURE_SSH_ARGS="$args" \
    "$SUBJECT" >"$log" 2>&1
}

# Discovery returning no port refuses rather than guessing a page server.
set +e
env -u HERDR_REPORT_FORWARD_PORT HERDR_REPORT_FORWARD_SSH_BIN="$TEST_ROOT/ssh" \
  FORWARD_FIXTURE_SSH_ARGS="$TEST_ROOT/unset.args" "$SUBJECT" >"$TEST_ROOT/unset.log" 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] && grep -Fq 'names no page server port' "$TEST_ROOT/unset.log" ||
  fail 'missing port is refused' "status $status: $(<"$TEST_ROOT/unset.log")"
pass 'empty discovery is refused with the source to inspect'
[[ "$(<"$TEST_ROOT/unset.args")" != *'-L '* ]] || fail 'empty discovery opens no forward' 'unexpected forwarding argument'
pass 'empty discovery opens no forwarding connection'

# Free local port: the forward opens one dedicated SSH connection to the
# configured Mini page server port.
port="$(free_port)"
run_subject 51012 "$port" "$TEST_ROOT/free.log" "$TEST_ROOT/free.args"
# Independent oracle: the exact mux-bypassing, loopback-only forward.
expected="-S none -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -L 127.0.0.1:${port}:127.0.0.1:51012 mac-mini"
[[ "$(<"$TEST_ROOT/free.args")" == "$expected" ]] ||
  fail 'free port opens the dedicated loopback forward' "got [$(<"$TEST_ROOT/free.args")]"
pass 'free port opens the dedicated loopback forward to mac-mini'
grep -Fq "status=forwarding port=${port} remote_port=51012 host=mac-mini" "$TEST_ROOT/free.log" ||
  fail 'free port logs forwarding' "$(<"$TEST_ROOT/free.log")"
pass 'free port logs the forwarding state'

# Held port: no SSH connection while another process listens, then the
# forward starts once that listener exits.
start_listener
port="$(<"$TEST_ROOT/listener.port")"
run_subject 52079 "$port" "$TEST_ROOT/held.log" "$TEST_ROOT/held.args" &
SUBJECT_PID=$!
wait_for "$TEST_ROOT/held.log" "status=deferred port=${port} listeners=${LISTENER_PID}" ||
  fail 'held port defers to the existing listener' "$(cat "$TEST_ROOT/held.log")"
pass 'held port defers and names the existing listener'
sleep 1
[[ ! -e "$TEST_ROOT/held.args" ]] ||
  fail 'held port opens no SSH connection' "ssh ran with [$(<"$TEST_ROOT/held.args")]"
pass 'held port opens no SSH connection across several polls'
[[ "$(grep -c 'status=deferred' "$TEST_ROOT/held.log")" -eq 1 ]] ||
  fail 'held port logs deferral once' "$(cat "$TEST_ROOT/held.log")"
pass 'held port logs one deferral line for an unchanged listener'
kill "$LISTENER_PID"
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=''
wait "$SUBJECT_PID" ||
  fail 'released port hands over to the forward' "$(cat "$TEST_ROOT/held.log")"
SUBJECT_PID=''
[[ "$(<"$TEST_ROOT/held.args")" == *"-L 127.0.0.1:${port}:127.0.0.1:52079 mac-mini" ]] ||
  fail 'released port opens the forward' "$(cat "$TEST_ROOT/held.args" 2>/dev/null)"
pass 'released port opens the forward after the listener exits'

# Launch agents: one per live report-link port (independent oracle: the two
# ports the Mini's page servers listen on), each starting at login,
# restarting after every exit and spacing retries.
for port in 51012 52079; do
  plist="$REPO_ROOT/config/launchd/com.nathanvale.herdr-report-forward-$port.plist"
  /usr/bin/plutil -lint -s "$plist" || fail "$port agent is a valid plist" "$plist"
  [[ "$(/usr/bin/plutil -extract Label raw -o - "$plist")" == "com.nathanvale.herdr-report-forward-$port" ]] ||
    fail "$port agent label" 'unexpected Label'
  [[ "$(/usr/bin/plutil -extract ProgramArguments raw -o - "$plist")" == 1 &&
    "$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$plist")" == /Users/nathanvale/code/dotfiles/bin/system/herdr_report_forward.sh ]] ||
    fail "$port agent runs the dotfiles forward script" 'unexpected ProgramArguments'
  [[ "$(/usr/bin/plutil -extract EnvironmentVariables.HERDR_REPORT_FORWARD_PORT raw -o - "$plist")" == "$port" ]] ||
    fail "$port agent pins its port" 'unexpected HERDR_REPORT_FORWARD_PORT'
  if /usr/bin/plutil -extract EnvironmentVariables.HERDR_REPORT_FORWARD_LOCAL_PORT raw -o - "$plist" >/dev/null 2>&1; then
    fail "$port agent listens on the link port itself" 'HERDR_REPORT_FORWARD_LOCAL_PORT is set'
  fi
  pass "$port agent is valid, labelled, and forwards only port $port on the same local port"
  [[ "$(/usr/bin/plutil -extract RunAtLoad raw -o - "$plist")" == true &&
    "$(/usr/bin/plutil -extract KeepAlive raw -o - "$plist")" == true ]] ||
    fail "$port agent starts at login and restarts" 'RunAtLoad or KeepAlive is not true'
  pass "$port agent starts at login and restarts after any exit"
  [[ "$(/usr/bin/plutil -extract ThrottleInterval raw -o - "$plist")" == 30 ]] ||
    fail "$port agent spaces reconnects" 'ThrottleInterval is not 30'
  [[ "$(/usr/bin/plutil -extract StandardErrorPath raw -o - "$plist")" == "/Users/nathanvale/Library/Logs/com.nathanvale.herdr-report-forward-$port.log" ]] ||
    fail "$port agent logs to its own file" 'unexpected StandardErrorPath'
  pass "$port agent spaces reconnects by 30 seconds and logs to its own file"
done

# Automatic discovery keeps the current launch agent's multi-port contract.
cat >"$TEST_ROOT/discovery-ssh" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *'plutil -extract port'* && "$*" != *'while ['* ]]; then
  printf '57534\n51012\n52079\n'
else
  printf '%s\n' "$*" >"$FORWARD_FIXTURE_SSH_ARGS"
fi
STUB
cat >"$TEST_ROOT/no-listener" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod 700 "$TEST_ROOT/discovery-ssh" "$TEST_ROOT/no-listener"
env -u HERDR_REPORT_FORWARD_PORT \
  HERDR_REPORT_FORWARD_SSH_BIN="$TEST_ROOT/discovery-ssh" \
  HERDR_REPORT_FORWARD_LSOF_BIN="$TEST_ROOT/no-listener" \
  FORWARD_FIXTURE_SSH_ARGS="$TEST_ROOT/discovery.args" \
  "$SUBJECT" >"$TEST_ROOT/discovery.log" 2>&1
args="$(<"$TEST_ROOT/discovery.args")"
for port in 57534 51012 52079; do
  [[ "$args" == *"-L 127.0.0.1:${port}:127.0.0.1:57534"* ]] ||
    fail 'discovered links use current server' "missing forward for $port"
done
[[ "$args" == *'-S none -n -o BatchMode=yes -o StrictHostKeyChecking=yes'* ]] ||
  fail 'discovery forwarding keeps SSH isolation' 'missing SSH guards'
pass 'automatic discovery forwards all report-link ports to the current server'
/usr/bin/plutil -lint -s "$REPO_ROOT/config/launchd/com.nathanvale.herdr-report-forward.plist" ||
  fail 'automatic discovery launch agent is valid' 'invalid plist'
pass 'automatic discovery launch agent remains valid'

expected=16
[[ "$PASSED" -eq "$expected" ]] || fail 'assertion count is pinned' "expected $expected, observed $PASSED"
printf '1..%d\n' "$PASSED"
