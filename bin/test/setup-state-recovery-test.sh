#!/usr/bin/env bash

# Setup state serialization and recovery contract.
#
# The production consumer is a fresh-machine operator invoking the public
# setup.sh process. Each row copies that executable into a disposable HOME,
# supplies harmless Phase 6 collaborators, and observes process status,
# streams, durable state, lock ownership, and collaborator calls.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
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

assert_file_contains() {
  local file="$1" text="$2" label="$3"
  grep -Fq "$text" "$file" || fail "$label (missing [$text])"
  pass "$label"
}

assert_file_absent() {
  local file="$1" label="$2"
  [[ ! -e "$file" && ! -L "$file" ]] || fail "$label (found $file)"
  pass "$label"
}

assert_file_exists() {
  local file="$1" label="$2"
  [[ -e "$file" && ! -L "$file" ]] || fail "$label (missing $file)"
  pass "$label"
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

assert_file_empty() {
  local file="$1" label="$2"
  [[ ! -s "$file" ]] || fail "$label (found collaborator output)"
  pass "$label"
}

assert_dir_empty() {
  local dir="$1" label="$2"
  [[ -d "$dir" && ! -L "$dir" ]] || fail "$label (missing $dir)"
  if find "$dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail "$label (found an entry in $dir)"
  fi
  pass "$label"
}

skip() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s # SKIP\n' "$assertion_count" "$1"
}

prepare_fixture() {
  FIXTURE_HOME="$TEST_ROOT/home"
  FIXTURE_DOTFILES="$FIXTURE_HOME/code/dotfiles"
  RECORD_DIR="$TEST_ROOT/records"
  mkdir -p "$FIXTURE_DOTFILES/bin/dotfiles/symlinks" "$FIXTURE_DOTFILES/config/macos" \
    "$RECORD_DIR"
  cp "$REPO_ROOT/setup.sh" "$FIXTURE_DOTFILES/setup.sh"
  chmod +x "$FIXTURE_DOTFILES/setup.sh"

  cat >"$FIXTURE_DOTFILES/bin/dotfiles/symlinks/symlinks_manage.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --status ]]; then
  printf 'status-called\n' >>"$RECORD_DIR/calls"
  exit 0
fi
printf 'entered:%s\n' "$$" >>"$RECORD_DIR/calls"
if [[ "${QUICK_PROBE:-0}" == 1 ]]; then
  printf 'quick:%s\n' "$$" >>"$RECORD_DIR/calls"
  exit 0
fi
if [[ "${PTY_PROBE:-0}" == 1 ]]; then
  if [[ -t 0 ]]; then
    printf 'yes\n' >"$RECORD_DIR/pty-tty"
  else
    printf 'no\n' >"$RECORD_DIR/pty-tty"
  fi
  IFS= read -r line
  printf '%s\n' "$line" >"$RECORD_DIR/pty-input"
  exit 0
fi
if [[ "${PTY_GRANDCHILD_PROBE:-0}" == 1 ]]; then
  (
    trap ':' TERM INT
    printf 'live\n' >"$RECORD_DIR/grandchild-live"
    while [[ ! -e "$RECORD_DIR/grandchild-release" ]]; do
      sleep 0.02
    done
    printf 'grandchild-late:%s\n' "$$" >>"$RECORD_DIR/calls"
  ) &
  printf '%s\n' "$!" >"$RECORD_DIR/grandchild-pid"
  while [[ ! -e "$RECORD_DIR/stop-child" ]]; do
    kill -0 "$PPID" 2>/dev/null || exit 99
    sleep 0.02
  done
  exit 0
fi
if [[ "${GRANDCHILD_PROBE:-0}" == 1 ]]; then
  (
    while [[ ! -e "$RECORD_DIR/grandchild-release" ]]; do
      sleep 0.02
    done
    printf 'grandchild-late:%s\n' "$$" >>"$RECORD_DIR/calls"
  ) &
  printf '%s\n' "$!" >"$RECORD_DIR/grandchild-pid"
  while [[ ! -e "$RECORD_DIR/release" ]]; do
    kill -0 "$PPID" 2>/dev/null || exit 99
    sleep 0.02
  done
  printf 'released:%s\n' "$$" >>"$RECORD_DIR/calls"
  exit 0
fi
if [[ "${BLOCK_PHASE6:-0}" == 1 ]]; then
  while [[ ! -e "$RECORD_DIR/release" ]]; do
    kill -0 "$PPID" 2>/dev/null || exit 99
    sleep 0.02
  done
  printf 'released:%s\n' "$$" >>"$RECORD_DIR/calls"
fi
EOF
  chmod +x "$FIXTURE_DOTFILES/bin/dotfiles/symlinks/symlinks_manage.sh"

  cat >"$FIXTURE_DOTFILES/config/macos/defaults.common.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'prefs:%s\n' "$$" >>"$RECORD_DIR/calls"
EOF
  chmod +x "$FIXTURE_DOTFILES/config/macos/defaults.common.sh"

  cat >"$FIXTURE_DOTFILES/verify_install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'verifier:%s\n' "$$" >>"$RECORD_DIR/calls"
case "${VERIFY_MODE:-pass}" in
  pass)
    printf 'DOTFILES_VERIFY_SUMMARY version=1 status=verified passed=4 failed=0 warnings=0\n'
    ;;
  qualified)
    printf 'DOTFILES_VERIFY_SUMMARY version=1 status=qualified passed=4 failed=0 warnings=1\n'
    ;;
  fail)
    printf 'DOTFILES_VERIFY_SUMMARY version=1 status=failed passed=3 failed=1 warnings=0\n'
    exit 1
    ;;
  *)
    printf 'DOTFILES_VERIFY_SUMMARY version=1 status=failed passed=0 failed=1 warnings=0\n'
    exit 1
    ;;
esac
EOF
  chmod +x "$FIXTURE_DOTFILES/verify_install.sh"
}

reset_fixture() {
  rm -rf "$FIXTURE_HOME/.dotfiles_state" "$RECORD_DIR/calls" \
    "$RECORD_DIR/release" "$RECORD_DIR/second-started" \
    "$RECORD_DIR/grandchild-release" "$RECORD_DIR/grandchild-pid" \
    "$RECORD_DIR/grandchild-live" "$RECORD_DIR/stop-child" \
    "$RECORD_DIR/pty-tty" "$RECORD_DIR/pty-input" \
    "$RECORD_DIR/mkdir-barrier" "$RECORD_DIR/rm-barrier" \
    "$RECORD_DIR/rm-crash-barrier" \
    "$RECORD_DIR/A-holding" \
    "$RECORD_DIR/B-done" "$RECORD_DIR/race" \
    "$FIXTURE_HOME/code/private-dotfiles" \
    "$FIXTURE_DOTFILES/verify_install.sh.disabled"
  mkdir -p "$RECORD_DIR"
  : >"$RECORD_DIR/calls"
}

test_process_start_identity() {
  local pid="$1" identity=""

  if [[ -r "/proc/$pid/stat" ]]; then
    identity="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"
  fi
  if [[ -z "$identity" ]]; then
    identity="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' || true)"
  fi
  [[ -n "$identity" ]] || return 1
  printf '%s\n' "$identity"
}

write_lock_owner() {
  local pid="$1" token="$2" profile="${3:-desktop}" started="${4:-$(date +%s)}" identity="${5:-}"

  if [[ -z "$identity" ]]; then
    identity="$(test_process_start_identity "$pid" 2>/dev/null || printf 'fixture-dead-%s' "$pid")"
  fi
  printf '%s\n' "$pid|$token|$profile|$started|$identity"
}

run_setup() {
  RUN_STDOUT="$TEST_ROOT/run.stdout"
  RUN_STDERR="$TEST_ROOT/run.stderr"
  local -a setup_env=(
    "HOME=$FIXTURE_HOME"
    "PATH=${SETUP_TEST_PATH:-/usr/bin:/bin}"
    "RECORD_DIR=$RECORD_DIR"
    "QUICK_PROBE=${QUICK_PROBE:-0}"
    "VERIFY_MODE=${VERIFY_MODE:-pass}"
  )
  [[ -n "${SETUP_TEST_LC_ALL:-}" ]] && setup_env+=("LC_ALL=$SETUP_TEST_LC_ALL")
  [[ -n "${SETUP_TEST_TZ:-}" ]] && setup_env+=("TZ=$SETUP_TEST_TZ")
  set +e
  env -i "${setup_env[@]}" \
    "$FIXTURE_DOTFILES/setup.sh" "$@" \
    >"$RUN_STDOUT" 2>"$RUN_STDERR"
  RUN_EXIT=$?
  set -e
}

write_mkdir_signal_barrier() {
  local target_kind="$1" signal="${2:-TERM}"
  local barrier_bin="$TEST_ROOT/barrier-bin"
  mkdir -p "$barrier_bin"
  cat >"$barrier_bin/mkdir" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${@: -1}"
/bin/mkdir "$@"
mkdir_status=$?
if [[ "$mkdir_status" -eq 0 ]] && {
  [[ "${BARRIER_TARGET:-0}" == 1 && "$target" == */setup.lock ]] ||
  [[ "${BARRIER_TARGET:-0}" == 2 && "$target" == */.setup-lock-recovery ]]
}; then
  printf '%s|%s\n' "$target" "$PPID" >>"$RECORD_DIR/mkdir-barrier"
  kill -"${BARRIER_SIGNAL:-TERM}" "$PPID"
  sleep 0.2
fi
exit "$mkdir_status"
EOF
  chmod +x "$barrier_bin/mkdir"
  BARRIER_TARGET="$target_kind"
  BARRIER_SIGNAL="$signal"
  BARRIER_PATH="$barrier_bin:/usr/bin:/bin"
}

write_recovery_rm_race_barrier() {
  local barrier_bin="$TEST_ROOT/rm-race-bin"
  mkdir -p "$barrier_bin"
  cat >"$barrier_bin/rm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${@: -1}"
if [[ "${ROLE:-}" == B && "$target" == "${RECOVERY_OWNER_PATH:-}" ]]; then
  printf '%s\n' "$target" >>"$RECORD_DIR/rm-barrier"
  while [[ ! -e "$RECORD_DIR/A-holding" ]]; do
    sleep 0.02
  done
fi
if [[ "${ROLE:-}" == A && "$target" == "$STATE_DIR"/.setup-lock-stale-*/owner ]]; then
  while [[ ! -e "$RECORD_DIR/B-done" ]]; do
    sleep 0.02
  done
fi
exec /bin/rm "$@"
EOF
  chmod +x "$barrier_bin/rm"
  RM_RACE_PATH="$barrier_bin:/usr/bin:/bin"
}

write_recovery_reclaim_crash_barrier() {
  local barrier_bin="$TEST_ROOT/rm-crash-bin"
  mkdir -p "$barrier_bin"
  cat >"$barrier_bin/rm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${@: -1}"
if [[ "$target" == "${KILL_TARGET:-}" ]]; then
  printf '%s\n' "$target" >>"$RECORD_DIR/rm-crash-barrier"
  /bin/rm "$@"
  kill -KILL "$PPID"
  sleep 0.2
  exit 137
fi
exec /bin/rm "$@"
EOF
  chmod +x "$barrier_bin/rm"
  RM_CRASH_PATH="$barrier_bin:/usr/bin:/bin"
}

assert_output_precedes() {
  local file="$1" first="$2" second="$3" label="$4"
  local first_line second_line
  first_line="$(grep -nF "$first" "$file" | head -n 1 | cut -d: -f1 || true)"
  second_line="$(grep -nF "$second" "$file" | head -n 1 | cut -d: -f1 || true)"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] ||
    fail "$label (expected [$first] before [$second])"
  pass "$label"
}

run_setup_pty() {
  RUN_PTY_STDOUT="$TEST_ROOT/pty.stdout"
  RUN_PTY_STDERR="$TEST_ROOT/pty.stderr"
  set +e
  python3 - "$FIXTURE_DOTFILES/setup.sh" "$FIXTURE_HOME" "$RECORD_DIR" \
    >"$RUN_PTY_STDOUT" 2>"$RUN_PTY_STDERR" <<'PY'
import os
import pty
import select
import signal
import sys
import time

setup, home, record = sys.argv[1:]
env = {
    "HOME": home,
    "PATH": "/usr/bin:/bin",
    "RECORD_DIR": record,
    "PTY_PROBE": "1",
}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.path.dirname(setup))
    os.execve(setup, [setup, "symlinks"], env)

deadline = time.time() + 4
sent = False
while time.time() < deadline:
    if not sent and os.path.exists(os.path.join(record, "pty-tty")):
        os.write(fd, b"pty-sentinel\n")
        sent = True
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            os.read(fd, 4096)
        except OSError:
            pass
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        print(os.waitstatus_to_exitcode(status))
        sys.exit(0)

try:
    os.killpg(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
print(70)
PY
  RUN_PTY_EXIT=$?
  set -e
  RUN_PTY_STATUS="$(tail -n 1 "$RUN_PTY_STDOUT" 2>/dev/null || true)"
}

run_setup_pty_grandchild() {
  RUN_PTY_TREE_STDOUT="$TEST_ROOT/pty-grandchild.stdout"
  RUN_PTY_TREE_STDERR="$TEST_ROOT/pty-grandchild.stderr"
  set +e
  python3 - "$FIXTURE_DOTFILES/setup.sh" "$FIXTURE_HOME" "$RECORD_DIR" \
    >"$RUN_PTY_TREE_STDOUT" 2>"$RUN_PTY_TREE_STDERR" <<'PY'
import os
import pty
import select
import signal
import sys
import time

setup, home, record = sys.argv[1:]
env = {
    "HOME": home,
    "PATH": "/usr/bin:/bin",
    "RECORD_DIR": record,
    "PTY_GRANDCHILD_PROBE": "1",
}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.path.dirname(setup))
    os.execve(setup, [setup, "symlinks"], env)

deadline = time.time() + 4
while time.time() < deadline:
    if os.path.exists(os.path.join(record, "grandchild-pid")):
        os.kill(pid, signal.SIGTERM)
        break
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            os.read(fd, 4096)
        except OSError:
            pass

while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            os.read(fd, 4096)
        except OSError:
            pass
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        print(os.waitstatus_to_exitcode(status))
        sys.exit(0)

try:
    os.killpg(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
print(70)
PY
  RUN_PTY_TREE_EXIT=$?
  set -e
  RUN_PTY_TREE_STATUS="$(tail -n 1 "$RUN_PTY_TREE_STDOUT" 2>/dev/null || true)"
}

prepare_fixture

# Help and status remain read-only even when state is unsafe or a mutating
# process owns the state lock.
reset_fixture
mkdir -p "$TEST_ROOT/status-target"
ln -s "$TEST_ROOT/status-target" "$FIXTURE_HOME/.dotfiles_state"
run_setup --help
[[ "$RUN_EXIT" -eq 0 ]] || fail 'help remains available with an unsafe state root'
pass 'help remains available with an unsafe state root'
assert_file_contains "$RUN_STDOUT" 'Usage: ' \
  'help reports usage without touching unsafe state'
run_setup status
[[ "$RUN_EXIT" -eq 0 ]] || fail 'status remains available with an unsafe state root'
pass 'status remains available with an unsafe state root'
assert_file_contains "$RECORD_DIR/calls" 'status-called' \
  'status reaches its read-only collaborator'
assert_file_absent "$TEST_ROOT/status-target/setup.lock" \
  'status does not create a setup lock'

reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" "$FIXTURE_HOME/.dotfiles_state/setup.lock"
write_lock_owner "$$" status-owner >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
run_setup status
assert_equals "$RUN_EXIT" 0 'status remains usable while a live lock exists'
assert_file_contains "$RECORD_DIR/calls" 'status-called' \
  'status bypasses the live mutation lock'
[[ -d "$FIXTURE_HOME/.dotfiles_state/setup.lock" ]] ||
  fail 'status leaves the live mutation lock untouched'
pass 'status leaves the live mutation lock untouched'

# A real terminal-backed public subcommand preserves tty classification and
# forwards the caller's input through the child wrapper.
reset_fixture
if command -v python3 >/dev/null 2>&1; then
  run_setup_pty
  assert_equals "$RUN_PTY_EXIT" 0 'pty-backed symlink subcommand exits successfully'
  assert_equals "$RUN_PTY_STATUS" 0 'pty probe reports the public process status'
  assert_equals "$(<"$RECORD_DIR/pty-tty")" yes \
    'pty-backed collaborator retains terminal classification'
  assert_equals "$(<"$RECORD_DIR/pty-input")" pty-sentinel \
    'pty-backed collaborator receives caller stdin'
else
  skip 'pty-backed stdin and tty classification (python3 unavailable)'
fi

reset_fixture

# A deterministic observer that reports no child row exercises the race where
# a quick public collaborator exits before ps can report its process group.
# The child must still return its real success status instead of a synthetic
# process-group failure.
quick_ps_dir="$TEST_ROOT/quick-ps"
mkdir -p "$quick_ps_dir"
cat >"$quick_ps_dir/ps" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -o && "${2:-}" == pgid= ]]; then
  exit 0
fi
exec /bin/ps "$@"
EOF
chmod +x "$quick_ps_dir/ps"
SETUP_TEST_PATH="$quick_ps_dir:/usr/bin:/bin" QUICK_PROBE=1 run_setup symlinks
assert_equals "$RUN_EXIT" 0 'quick public collaborator preserves its success status'
assert_file_contains "$RECORD_DIR/calls" 'quick:' \
  'quick public collaborator actually ran'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'quick public collaborator leaves no setup lock'

reset_fixture

# A signal immediately after this process creates its lock directory must be
# deferred until owner publication, then remove only the lock this process owns.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
write_mkdir_signal_barrier 1
env -i HOME="$FIXTURE_HOME" PATH="$BARRIER_PATH" RECORD_DIR="$RECORD_DIR" \
  BARRIER_TARGET="$BARRIER_TARGET" BARRIER_SIGNAL="$BARRIER_SIGNAL" VERIFY_MODE=pass \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --resume \
  >"$TEST_ROOT/lock-barrier.stdout" 2>"$TEST_ROOT/lock-barrier.stderr" &
lock_barrier_pid=$!
for _ in $(seq 1 100); do
  [[ -e "$RECORD_DIR/mkdir-barrier" ]] && break
  sleep 0.02
done
assert_file_exists "$RECORD_DIR/mkdir-barrier" \
  'lock transition barrier reaches the public mkdir seam'
lock_barrier_status=0
wait "$lock_barrier_pid" || lock_barrier_status=$?
assert_equals "$lock_barrier_status" 143 \
  'signal during lock-directory creation preserves TERM status'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'signal during lock-directory creation leaves no orphan lock'
SETUP_TEST_PATH=/usr/bin:/bin VERIFY_MODE=pass run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 \
  'next setup proceeds after interrupted lock-directory creation'

# The same ownership transition applies while quarantining a validated stale
# lock. The recovery serializer must not strand its private sentinel.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock"
stale_barrier_pid=0
(exit 0) &
stale_barrier_pid=$!
wait "$stale_barrier_pid"
write_lock_owner "$stale_barrier_pid" stale-barrier desktop 1 stale-barrier-identity \
  >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
write_mkdir_signal_barrier 2
env -i HOME="$FIXTURE_HOME" PATH="$BARRIER_PATH" RECORD_DIR="$RECORD_DIR" \
  BARRIER_TARGET="$BARRIER_TARGET" BARRIER_SIGNAL="$BARRIER_SIGNAL" VERIFY_MODE=pass \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --resume \
  >"$TEST_ROOT/recovery-barrier.stdout" 2>"$TEST_ROOT/recovery-barrier.stderr" &
recovery_barrier_pid=$!
for _ in $(seq 1 100); do
  [[ -e "$RECORD_DIR/mkdir-barrier" ]] && break
  sleep 0.02
done
assert_file_exists "$RECORD_DIR/mkdir-barrier" \
  'recovery transition barrier reaches the public mkdir seam'
recovery_barrier_status=0
wait "$recovery_barrier_pid" || recovery_barrier_status=$?
assert_equals "$recovery_barrier_status" 143 \
  'signal during stale recovery preserves TERM status'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'signal during stale recovery leaves no successor lock'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'signal during stale recovery leaves no recovery sentinel'
SETUP_TEST_PATH=/usr/bin:/bin VERIFY_MODE=pass run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 \
  'next setup proceeds after interrupted stale recovery'

# A crash after the recovery directory is created but before its owner is
# published must leave a recoverable empty claim, not a permanent busy state.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock"
stale_crash_pid=0
(exit 0) &
stale_crash_pid=$!
wait "$stale_crash_pid"
write_lock_owner "$stale_crash_pid" stale-crash desktop 1 stale-crash-identity \
  >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
write_mkdir_signal_barrier 2 KILL
env -i HOME="$FIXTURE_HOME" PATH="$BARRIER_PATH" RECORD_DIR="$RECORD_DIR" \
  BARRIER_TARGET="$BARRIER_TARGET" BARRIER_SIGNAL="$BARRIER_SIGNAL" VERIFY_MODE=pass \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --resume \
  >"$TEST_ROOT/recovery-crash.stdout" 2>"$TEST_ROOT/recovery-crash.stderr" &
recovery_crash_pid=$!
for _ in $(seq 1 100); do
  [[ -e "$RECORD_DIR/mkdir-barrier" ]] && break
  sleep 0.02
done
assert_file_exists "$RECORD_DIR/mkdir-barrier" \
  'recovery crash barrier reaches the public mkdir seam'
assert_file_contains "$RECORD_DIR/mkdir-barrier" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery|$recovery_crash_pid" \
  'recovery crash barrier belongs to the new public process'
recovery_crash_status=0
wait "$recovery_crash_pid" || recovery_crash_status=$?
assert_equals "$recovery_crash_status" 137 \
  'recovery crash fixture terminates the public process'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'recovery crash leaves the interrupted recovery claim'
assert_dir_empty "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'recovery crash leaves no marker before publication'
SETUP_TEST_PATH=/usr/bin:/bin VERIFY_MODE=pass run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 \
  'resume reclaims a recovery claim interrupted before owner publication'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'reclaimed recovery claim is released after setup'

# Unsafe roots are rejected before a mutating process can follow them.
reset_fixture
mkdir -p "$TEST_ROOT/unsafe-target"
ln -s "$TEST_ROOT/unsafe-target" "$FIXTURE_HOME/.dotfiles_state"
run_setup --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'state-root symlink rejects a mutating setup'
pass 'state-root symlink rejects a mutating setup'
assert_file_contains "$RUN_STDERR" 'symbolic link' \
  'state-root symlink gives a specific safety diagnostic'
assert_file_absent "$TEST_ROOT/unsafe-target/profile" \
  'state-root symlink is not populated'

reset_fixture
printf '%s\n' 'state-file' >"$FIXTURE_HOME/.dotfiles_state"
run_setup --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'non-directory state root rejects a mutating setup'
pass 'non-directory state root rejects a mutating setup'
assert_file_contains "$RUN_STDERR" 'not a directory' \
  'non-directory state root gives a specific safety diagnostic'

# A stored checkpoint is validated before any phase or verifier can run.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
chmod 700 "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' server >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' corrupt >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
printf '%s\n' before-log >"$FIXTURE_HOME/.dotfiles_state/setup.log"
printf '%s\n' before-history >"$FIXTURE_HOME/.dotfiles_state/history"
mkdir -p "$FIXTURE_HOME/code/private-dotfiles"
printf '%s\n' '# private fixture' >"$FIXTURE_HOME/code/private-dotfiles/profile.zsh"
run_setup --desktop --resume
[[ "$RUN_EXIT" -ne 0 ]] || fail 'corrupt resume checkpoint exits nonzero'
pass 'corrupt resume checkpoint exits nonzero'
assert_file_contains "$RUN_STDERR" 'checkpoint' \
  'corrupt resume checkpoint names the recovery input'
assert_file_empty "$RECORD_DIR/calls" \
  'corrupt resume checkpoint runs no collaborator'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/profile")" server \
  'malformed resume leaves the stored profile bytes unchanged'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/setup.log")" before-log \
  'malformed resume leaves the setup log bytes unchanged'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/history")" before-history \
  'malformed resume leaves setup history bytes unchanged'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/work-profile" \
  'malformed resume does not migrate work-profile state'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/checkpoint")" corrupt \
  'malformed resume leaves the invalid checkpoint for repair'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'malformed resume creates no mutation lock'

reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
chmod 700 "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' server >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' corrupt >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'corrupt checkpoint rejects an explicit start phase'
pass 'corrupt checkpoint rejects an explicit start phase'
assert_file_contains "$RUN_STDERR" 'checkpoint' \
  'explicit start phase reports the corrupt checkpoint'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/profile")" server \
  'explicit start phase leaves the stored profile unchanged on checkpoint failure'
assert_file_empty "$RECORD_DIR/calls" \
  'explicit start phase runs no collaborator after checkpoint failure'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'explicit start phase creates no lock after checkpoint failure'

# A live owner blocks a second complete public process with an observable
# owner identity and no second Phase 6 entry.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" "$FIXTURE_HOME/.dotfiles_state/setup.lock"
write_lock_owner "$$" live-owner >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 75 'live setup lock exits with the busy status'
assert_file_contains "$RUN_STDERR" 'live-owner' \
  'live setup lock reports its owner token'
assert_file_contains "$RUN_STDERR" "PID $$" \
  'live setup lock reports its owner PID'
assert_file_contains "$RUN_STDERR" 'already running' \
  'live setup lock reports the already-running diagnostic'
if grep -q '^entered:' "$RECORD_DIR/calls"; then
  fail 'live setup lock prevents phase execution'
fi
pass 'live setup lock prevents phase execution'

# A live owner remains busy when its process-start identity is read under a
# different locale and timezone by the second public setup process.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
chmod 700 "$FIXTURE_HOME/.dotfiles_state"
env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" RECORD_DIR="$RECORD_DIR" \
  BLOCK_PHASE6=1 VERIFY_MODE=pass LC_ALL=C TZ=UTC \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --start-phase 6 \
  >"$TEST_ROOT/locale-owner.stdout" 2>"$TEST_ROOT/locale-owner.stderr" &
locale_owner_pid=$!
for _ in $(seq 1 100); do
  [[ "$(grep -c '^entered:' "$RECORD_DIR/calls" 2>/dev/null || true)" -ge 1 ]] && break
  sleep 0.02
done
assert_file_contains "$RECORD_DIR/calls" 'entered:' \
  'locale owner reaches the public Phase 6 collaborator'
SETUP_TEST_LC_ALL=en_AU.UTF-8 SETUP_TEST_TZ=Australia/Melbourne \
  run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 75 \
  'locale-shifted concurrent setup exits with busy status'
assert_file_contains "$RUN_STDERR" 'already running' \
  'locale-shifted concurrent setup reports a truthful busy diagnostic'
entered_count="$(grep -c '^entered:' "$RECORD_DIR/calls" || true)"
assert_equals "$entered_count" 1 \
  'locale-shifted concurrent setup does not enter Phase 6'
: >"$RECORD_DIR/release"
locale_owner_status=0
wait "$locale_owner_pid" || locale_owner_status=$?
assert_equals "$locale_owner_status" 0 \
  'locale owner completes after its peer is refused'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'locale owner releases its setup lock'

# A reused PID with a different recorded process-start identity is stale even
# though kill -0 succeeds; explicit recovery may reclaim it safely.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" "$FIXTURE_HOME/.dotfiles_state/setup.lock"
write_lock_owner "$$" pid-reused desktop "$(date +%s)" deliberately-different-start \
  >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 75 'reused PID refuses recovery without explicit resume'
assert_file_contains "$RUN_STDERR" 'rerun with --resume' \
  'reused PID refusal names the explicit recovery command'
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 'reused PID recovery succeeds with explicit resume'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'reused PID recovery releases the replacement lock'

# A validated dead owner is reclaimed explicitly and the lock is released
# after the successful run.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" "$FIXTURE_HOME/.dotfiles_state/setup.lock"
(exit 0) &
stale_pid=$!
wait "$stale_pid"
write_lock_owner "$stale_pid" dead-owner desktop 1 dead-owner-identity \
  >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 75 'plain setup refuses a stale lock without explicit recovery'
assert_file_contains "$RUN_STDERR" 'is stale' \
  'plain stale refusal reports the stale diagnostic'
assert_file_contains "$RUN_STDERR" 'rerun with --resume' \
  'plain stale refusal names the explicit recovery command'
[[ -d "$FIXTURE_HOME/.dotfiles_state/setup.lock" ]] ||
  fail 'plain stale refusal preserves lock evidence'
pass 'plain stale refusal preserves lock evidence'
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 'stale setup lock can be recovered safely'
assert_file_contains "$RUN_STDOUT" 'Recovered stale setup lock' \
  'stale recovery is explicit in process output'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'successful stale recovery releases the new owner lock'
assert_file_contains "$RECORD_DIR/calls" 'verifier:' \
  'stale recovery reaches final verification'

# A dead recovery owner is reclaimed before the stale setup lock is recovered.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1"
(exit 0) &
dead_recovery_setup_pid=$!
wait "$dead_recovery_setup_pid"
(exit 0) &
dead_recovery_owner_pid=$!
wait "$dead_recovery_owner_pid"
write_lock_owner "$dead_recovery_setup_pid" stale-recovery-setup desktop 1 \
  stale-recovery-setup >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$dead_recovery_owner_pid" recovery-101-1-1-1 desktop 1 \
  recovery-101-1-1-1 >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 \
  'dead recovery owner is reclaimed during explicit stale recovery'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'dead recovery owner is released after recovery'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'dead recovery owner recovery releases the setup lock'
assert_file_contains "$RECORD_DIR/calls" 'verifier:' \
  'dead recovery owner recovery reaches final verification'

# An empty directory with an unissued marker name is foreign state. It must
# fail closed before recovery can delete it or enter a phase.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/notes"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/notes"
(exit 0) &
notes_setup_pid=$!
wait "$notes_setup_pid"
write_lock_owner "$notes_setup_pid" stale-notes desktop 1 \
  stale-notes >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 73 \
  'unknown empty recovery marker exits with unsafe-state status'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/notes" \
  'unknown empty recovery marker remains durable for repair'
assert_dir_empty "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/notes" \
  'unknown empty recovery marker preserves its contents'
assert_file_empty "$RECORD_DIR/calls" \
  'unknown empty recovery marker prevents phase execution'

# Two public recovery claimants exercise the keyed rm seam. B pauses while
# removing a dead marker; A publishes its own marker and holds it through the
# stale-lock transition. B must observe A as live and return busy without
# moving, removing, or replacing A's marker.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1"
(exit 0) &
race_stale_setup_pid=$!
wait "$race_stale_setup_pid"
(exit 0) &
race_stale_recovery_pid=$!
wait "$race_stale_recovery_pid"
write_lock_owner "$race_stale_setup_pid" race-stale-lock desktop 1 \
  race-stale-lock >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$race_stale_recovery_pid" recovery-101-1-1-1 desktop 1 \
  recovery-101-1-1-1 >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
write_recovery_rm_race_barrier
race_recovery_owner_path="$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-101-1-1-1/owner"
env -i HOME="$FIXTURE_HOME" PATH="$RM_RACE_PATH" RECORD_DIR="$RECORD_DIR" \
  ROLE=B STATE_DIR="$FIXTURE_HOME/.dotfiles_state" \
  RECOVERY_OWNER_PATH="$race_recovery_owner_path" VERIFY_MODE=pass \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --resume \
  >"$TEST_ROOT/race-B.stdout" 2>"$TEST_ROOT/race-B.stderr" &
race_b_pid=$!
for _ in $(seq 1 200); do
  [[ -e "$RECORD_DIR/rm-barrier" ]] && break
  sleep 0.02
done
assert_file_exists "$RECORD_DIR/rm-barrier" \
  'recovery race reaches the keyed rm barrier'
env -i HOME="$FIXTURE_HOME" PATH="$RM_RACE_PATH" RECORD_DIR="$RECORD_DIR" \
  ROLE=A STATE_DIR="$FIXTURE_HOME/.dotfiles_state" VERIFY_MODE=pass \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --resume \
  >"$TEST_ROOT/race-A.stdout" 2>"$TEST_ROOT/race-A.stderr" &
race_a_pid=$!
race_a_marker_owner=""
for _ in $(seq 1 200); do
  for candidate in "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery"/*/owner; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || continue
    if grep -q "^$race_a_pid|" "$candidate"; then
      race_a_marker_owner="$candidate"
      break
    fi
  done
  [[ -n "$race_a_marker_owner" ]] && break
  sleep 0.02
done
if [[ -z "$race_a_marker_owner" ]]; then
  kill "$race_a_pid" "$race_b_pid" 2>/dev/null || true
  wait "$race_a_pid" 2>/dev/null || true
  wait "$race_b_pid" 2>/dev/null || true
  fail 'recovery race publishes A marker before B resumes'
fi
: >"$RECORD_DIR/A-holding"
pass 'recovery race publishes A marker before B resumes'
race_b_status=0
wait "$race_b_pid" || race_b_status=$?
assert_equals "$race_b_status" 75 \
  'recovery race B exits busy after A publishes a live marker'
assert_file_contains "$TEST_ROOT/race-B.stderr" 'already running' \
  'recovery race B reports the live-owner diagnostic'
assert_file_exists "$race_a_marker_owner" \
  'recovery race preserves A keyed marker after B withdraws'
: >"$RECORD_DIR/B-done"
race_a_status=0
wait "$race_a_pid" || race_a_status=$?
assert_equals "$race_a_status" 0 'recovery race A completes after B withdraws'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'recovery race leaves no successor setup lock'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'recovery race leaves no recovery marker leak'
entered_count="$(grep -c '^entered:' "$RECORD_DIR/calls" || true)"
assert_equals "$entered_count" 1 \
  'recovery race enters Phase 6 only for A'

# A crash after removing a stale keyed owner but before its token directory is
# removed leaves an empty valid marker. The next public process reclaims that
# marker idempotently and continues.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1"
(exit 0) &
crash_stale_setup_pid=$!
wait "$crash_stale_setup_pid"
(exit 0) &
crash_stale_recovery_pid=$!
wait "$crash_stale_recovery_pid"
write_lock_owner "$crash_stale_setup_pid" crash-stale-lock desktop 1 \
  crash-stale-lock >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$crash_stale_recovery_pid" recovery-105-1-1-1 desktop 1 \
  recovery-105-1-1-1 >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
write_recovery_reclaim_crash_barrier
crash_recovery_owner_path="$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1/owner"
env -i HOME="$FIXTURE_HOME" PATH="$RM_CRASH_PATH" RECORD_DIR="$RECORD_DIR" \
  KILL_TARGET="$crash_recovery_owner_path" VERIFY_MODE=pass \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --resume \
  >"$TEST_ROOT/reclaim-crash.stdout" 2>"$TEST_ROOT/reclaim-crash.stderr" &
reclaim_crash_pid=$!
for _ in $(seq 1 200); do
  [[ -e "$RECORD_DIR/rm-crash-barrier" ]] && break
  sleep 0.02
done
assert_file_exists "$RECORD_DIR/rm-crash-barrier" \
  'stale recovery reclaim crash reaches the keyed rm seam'
reclaim_crash_status=0
wait "$reclaim_crash_pid" || reclaim_crash_status=$?
assert_equals "$reclaim_crash_status" 137 \
  'stale recovery reclaim crash terminates the public process'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1" \
  'stale recovery reclaim crash leaves its keyed marker directory'
assert_dir_empty "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-105-1-1-1" \
  'stale recovery reclaim crash leaves an empty marker for retry'
SETUP_TEST_PATH=/usr/bin:/bin VERIFY_MODE=pass run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 \
  'resume reclaims an empty marker after interrupted stale recovery'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'empty marker recovery leaves no marker root'

# Several dead keyed markers are all reclaimable; one dead marker must not
# make the recovery serializer permanent or require a fixed quarantine path.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-106-1-1-1" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-107-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-106-1-1-1" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-107-1-1-1"
(exit 0) &
two_dead_setup_pid=$!
wait "$two_dead_setup_pid"
(exit 0) &
two_dead_owner_one_pid=$!
wait "$two_dead_owner_one_pid"
(exit 0) &
two_dead_owner_two_pid=$!
wait "$two_dead_owner_two_pid"
write_lock_owner "$two_dead_setup_pid" two-dead-stale desktop 1 \
  two-dead-stale >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$two_dead_owner_one_pid" recovery-106-1-1-1 desktop 1 \
  recovery-106-1-1-1 >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-106-1-1-1/owner"
write_lock_owner "$two_dead_owner_two_pid" recovery-107-1-1-1 desktop 1 \
  recovery-107-1-1-1 >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-107-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-106-1-1-1/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-107-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 0 \
  'two dead recovery markers are reclaimed in one explicit recovery'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  'two dead recovery markers leave no recovery root'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'two dead recovery markers release the setup lock'

# A live recovery owner refuses a second explicit recovery without entering a
# phase or removing the recovery owner.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-102-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-102-1-1-1"
(exit 0) &
live_recovery_setup_pid=$!
wait "$live_recovery_setup_pid"
write_lock_owner "$live_recovery_setup_pid" stale-recovery-live desktop 1 \
  stale-recovery-live >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$$" recovery-102-1-1-1 > \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-102-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-102-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 75 'live recovery owner exits with the busy status'
assert_file_contains "$RUN_STDERR" 'already running' \
  'live recovery owner reports the already-running diagnostic'
assert_file_contains "$RUN_STDERR" 'recovery-102-1-1-1' \
  'live recovery owner reports its owner token'
assert_file_empty "$RECORD_DIR/calls" \
  'live recovery owner prevents phase execution'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-102-1-1-1/owner" \
  'live recovery owner remains durable after refusal'

# An invalid recovery owner is rejected fail-closed before phase execution.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-103-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-103-1-1-1"
(exit 0) &
invalid_recovery_setup_pid=$!
wait "$invalid_recovery_setup_pid"
write_lock_owner "$invalid_recovery_setup_pid" stale-recovery-invalid desktop 1 \
  stale-recovery-invalid >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' invalid-recovery-owner \
  >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-103-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-103-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 73 'invalid recovery owner exits with unsafe-state status'
assert_file_contains "$RUN_STDERR" 'without a valid owner' \
  'invalid recovery owner reports the fail-closed diagnostic'
assert_file_empty "$RECORD_DIR/calls" \
  'invalid recovery owner prevents phase execution'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-103-1-1-1/owner" \
  'invalid recovery owner remains durable for repair'

# A syntactically valid owner whose token disagrees with its keyed directory
# name is foreign state and must fail closed before any reclaim or phase.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-104-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-104-1-1-1"
(exit 0) &
mismatch_setup_pid=$!
wait "$mismatch_setup_pid"
(exit 0) &
mismatch_owner_pid=$!
wait "$mismatch_owner_pid"
write_lock_owner "$mismatch_setup_pid" stale-mismatch desktop 1 \
  stale-mismatch >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$mismatch_owner_pid" different-token desktop 1 \
  different-token >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-104-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-104-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 73 \
  'recovery marker token mismatch exits with unsafe-state status'
assert_file_contains "$RUN_STDERR" 'marker token' \
  'recovery marker token mismatch reports the keyed-state diagnostic'
assert_file_empty "$RECORD_DIR/calls" \
  'recovery marker token mismatch prevents phase execution'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-104-1-1-1/owner" \
  'recovery marker token mismatch preserves foreign owner state'

# Validation covers every marker before reclaim starts: a dead marker must
# remain untouched when a second marker is malformed in the same root.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-108-1-1-1" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-109-1-1-1"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-108-1-1-1" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-109-1-1-1"
(exit 0) &
mixed_setup_pid=$!
wait "$mixed_setup_pid"
(exit 0) &
mixed_dead_owner_pid=$!
wait "$mixed_dead_owner_pid"
write_lock_owner "$mixed_setup_pid" stale-mixed desktop 1 \
  stale-mixed >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
write_lock_owner "$mixed_dead_owner_pid" recovery-108-1-1-1 desktop 1 \
  recovery-108-1-1-1 >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-108-1-1-1/owner"
printf '%s\n' malformed-mixed-owner \
  >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-109-1-1-1/owner"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-108-1-1-1/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-109-1-1-1/owner"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 73 \
  'mixed dead and malformed markers fail before reclaim'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-108-1-1-1/owner" \
  'mixed marker validation preserves the dead marker before reclaim'
assert_file_exists "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/recovery-109-1-1-1/owner" \
  'mixed marker validation preserves the malformed marker'
assert_file_empty "$RECORD_DIR/calls" \
  'mixed marker validation prevents phase execution'

# An ownerless recovery directory with unexpected contents is rejected before
# a new owner is published or any phase collaborator is entered.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery"
chmod 700 "$FIXTURE_HOME/.dotfiles_state" \
  "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery"
(exit 0) &
ownerless_recovery_setup_pid=$!
wait "$ownerless_recovery_setup_pid"
write_lock_owner "$ownerless_recovery_setup_pid" stale-ownerless desktop 1 \
  stale-ownerless >"$FIXTURE_HOME/.dotfiles_state/setup.lock/owner"
printf '%s\n' stray-recovery-content \
  >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/stray"
printf '%s\n' dotdot-stray-recovery-content \
  >"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/..stray"
chmod 600 "$FIXTURE_HOME/.dotfiles_state/setup.lock/owner" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/stray" \
  "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/..stray"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
assert_equals "$RUN_EXIT" 73 \
  'ownerless recovery directory with contents exits with unsafe-state status'
assert_file_contains "$RUN_STDERR" 'unexpected files' \
  'ownerless recovery directory reports its unexpected contents'
assert_file_empty "$RECORD_DIR/calls" \
  'ownerless recovery directory prevents phase execution'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/owner" \
  'ownerless recovery directory publishes no replacement owner'
assert_equals \
  "$(<"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/stray")" \
  stray-recovery-content \
  'ownerless recovery directory preserves its unexpected contents'
assert_equals \
  "$(<"$FIXTURE_HOME/.dotfiles_state/.setup-lock-recovery/..stray")" \
  dotdot-stray-recovery-content \
  'ownerless recovery directory preserves dot-prefixed unexpected contents'

reset_fixture
run_setup --server --start-phase 6
assert_equals "$RUN_EXIT" 0 'server profile setup exits successfully'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" 'profile=server' \
  'server profile is published in the setup result'
assert_file_contains "$RECORD_DIR/calls" 'prefs:' \
  'server profile reaches the shared preference collaborator'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'server profile releases its setup lock'

# A prior accepted result survives a later failed verification. Removing the
# new receipt here exercises the upgrade path that preserves an older valid
# setup-result before the failed attempt replaces it.
reset_fixture
VERIFY_MODE=pass run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 0 'verified setup creates the accepted-result baseline'
assert_file_contains "$RUN_STDOUT" 'with-one-password-token check' \
  'completion names the scoped credential custody check'
if grep -Fq '.env.example' "$RUN_STDOUT"; then
  fail 'completion does not instruct copying an env secret file'
fi
pass 'completion does not instruct copying an env secret file'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=verified' 'verified setup publishes a last accepted result'

# A valid verifier cannot produce a truthful completion when the latest
# terminal result cannot be published. The accepted snapshot is written first,
# but the checkpoint and process status remain recoverable until setup-result
# is safely published.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/setup-result"
VERIFY_MODE=pass run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 1 \
  'result directory publication failure exits nonzero after valid verification'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/checkpoint")" 7 \
  'result directory publication failure retains the completed-phase checkpoint'
[[ -d "$FIXTURE_HOME/.dotfiles_state/setup-result" ]] ||
  fail 'result directory publication failure does not replace the unsafe result path'
pass 'result directory publication failure preserves the unsafe result path'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=verified' \
  'result directory failure records the accepted snapshot before latest publication'
if grep -Fq 'SETUP VERIFIED' "$RUN_STDOUT"; then
  fail 'result directory publication failure does not claim verified completion'
fi
pass 'result directory publication failure does not claim verified completion'

reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/foreign"
printf '%s\n' before >"$FIXTURE_HOME/.dotfiles_state/foreign/result"
ln -s "$FIXTURE_HOME/.dotfiles_state/foreign/result" \
  "$FIXTURE_HOME/.dotfiles_state/setup-result"
VERIFY_MODE=pass run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 1 \
  'result symlink publication failure exits nonzero after valid verification'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/checkpoint")" 7 \
  'result symlink publication failure retains the completed-phase checkpoint'
[[ -L "$FIXTURE_HOME/.dotfiles_state/setup-result" ]] ||
  fail 'result symlink publication failure does not replace the unsafe result path'
pass 'result symlink publication failure preserves the unsafe result path'
assert_equals "$(readlink "$FIXTURE_HOME/.dotfiles_state/setup-result")" \
  "$FIXTURE_HOME/.dotfiles_state/foreign/result" \
  'result symlink publication failure preserves its target'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/foreign/result")" before \
  'result symlink publication failure preserves the foreign target bytes'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=verified' \
  'result symlink failure records the accepted snapshot before latest publication'
if grep -Fq 'SETUP VERIFIED' "$RUN_STDOUT"; then
  fail 'result symlink publication failure does not claim verified completion'
fi
pass 'result symlink publication failure does not claim verified completion'

reset_fixture
VERIFY_MODE=pass run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 0 'later-failure fixture recreates a verified baseline'
rm -f "$FIXTURE_HOME/.dotfiles_state/last-accepted-result"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
VERIFY_MODE=fail run_setup --desktop --resume
[[ "$RUN_EXIT" -ne 0 ]] || fail 'later failed verification exits nonzero'
pass 'later failed verification exits nonzero'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" 'status=failed' \
  'later failure remains the latest terminal setup result'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=verified' 'later failure preserves the prior accepted status'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'profile=desktop' 'later failure preserves the prior accepted profile'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'verification_summary=DOTFILES_VERIFY_SUMMARY version=1 status=verified' \
  'later failure preserves the prior accepted machine summary'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'verification_output=none (accepted summary only; verification.log is mutable)' \
  'accepted result does not point at the mutable verification log'
VERIFY_MODE=pass run_setup --resume
assert_equals "$RUN_EXIT" 0 'resume succeeds after the failed verification is repaired'
assert_file_contains "$RUN_STDOUT" 'Resume next phase: phase 7' \
  'resume reports the exact next phase'
assert_file_contains "$RUN_STDOUT" \
  'Last accepted verification: status=verified profile=desktop' \
  'resume reports the last accepted verified result'
assert_output_precedes "$RUN_STDOUT" \
  'Last accepted verification: status=verified profile=desktop' \
  'Running installation verification' \
  'resume reports the accepted result before its verifier collaborator'

# An interrupted phase keeps the accepted receipt available to the following
# resume, and the context is printed before the phase collaborator starts.
reset_fixture
VERIFY_MODE=pass run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 0 'interruption fixture creates an accepted baseline'
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" RECORD_DIR="$RECORD_DIR" \
  BLOCK_PHASE6=1 VERIFY_MODE=pass "$FIXTURE_DOTFILES/setup.sh" --resume \
  >"$TEST_ROOT/receipt-owner.stdout" 2>"$TEST_ROOT/receipt-owner.stderr" &
receipt_owner_pid=$!
for _ in $(seq 1 100); do
  [[ "$(grep -c '^entered:' "$RECORD_DIR/calls" 2>/dev/null || true)" -ge 1 ]] && break
  sleep 0.02
done
assert_file_contains "$RECORD_DIR/calls" 'entered:' \
  'receipt interruption reaches the public phase collaborator'
kill -TERM "$receipt_owner_pid"
: >"$RECORD_DIR/release"
receipt_owner_status=0
wait "$receipt_owner_pid" || receipt_owner_status=$?
assert_equals "$receipt_owner_status" 143 \
  'receipt interruption preserves TERM status'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=verified' 'receipt interruption preserves the accepted result'
VERIFY_MODE=pass run_setup --resume
assert_equals "$RUN_EXIT" 0 'resume succeeds after receipt interruption'
assert_file_contains "$RUN_STDOUT" 'Resume next phase: phase 6' \
  'interrupted resume reports the exact next phase'
assert_file_contains "$RUN_STDOUT" \
  'Last accepted verification: status=verified profile=desktop' \
  'interrupted resume reports the prior accepted result'
assert_output_precedes "$RUN_STDOUT" \
  'Last accepted verification: status=verified profile=desktop' \
  '=== PHASE 6:' \
  'interrupted resume reports accepted state before the phase collaborator'

# Qualified acceptance remains distinct from verified acceptance in durable
# state and in the resume context.
reset_fixture
VERIFY_MODE=qualified run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 0 'qualified verification exits zero'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=qualified' 'qualified verification records a qualified accepted result'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'verification_summary=DOTFILES_VERIFY_SUMMARY version=1 status=qualified' \
  'qualified acceptance preserves its distinct machine summary'
assert_file_contains "$RUN_STDOUT" 'qualified, not verified' \
  'qualified verification never claims verified completion'

# An unavailable later verifier also leaves the accepted summary untouched.
reset_fixture
VERIFY_MODE=pass run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 0 'unavailable-verifier fixture creates an accepted baseline'
mv "$FIXTURE_DOTFILES/verify_install.sh" "$FIXTURE_DOTFILES/verify_install.sh.disabled"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
run_setup --desktop --resume
[[ "$RUN_EXIT" -ne 0 ]] || fail 'unavailable later verification exits nonzero'
pass 'unavailable later verification exits nonzero'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'verification=missing' 'unavailable verification remains the latest terminal outcome'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" \
  'status=verified' 'unavailable verification preserves the accepted result'
mv "$FIXTURE_DOTFILES/verify_install.sh.disabled" "$FIXTURE_DOTFILES/verify_install.sh"

# A resume with no accepted receipt states that absence explicitly.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
VERIFY_MODE=fail run_setup --desktop --resume
[[ "$RUN_EXIT" -ne 0 ]] || fail 'no-receipt failed verification exits nonzero'
pass 'no-receipt failed verification exits nonzero'
assert_file_contains "$RUN_STDOUT" \
  'Last accepted verification: none (no prior accepted result available)' \
  'resume states that no accepted result exists'

# Corrupt and unsafe prior receipts never become claimed verified state.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
cat >"$FIXTURE_HOME/.dotfiles_state/last-accepted-result" <<'EOF'
status=verified
profile=desktop
verification=passed
verification_summary=not-a-machine-summary
EOF
VERIFY_MODE=fail run_setup --desktop --resume
[[ "$RUN_EXIT" -ne 0 ]] || fail 'corrupt-receipt failed verification exits nonzero'
pass 'corrupt-receipt failed verification exits nonzero'
assert_file_contains "$RUN_STDOUT" \
  'Last accepted verification: none (prior receipt invalid or unsafe)' \
  'resume refuses a corrupt accepted receipt'
if grep -Fq 'Last accepted verification: status=verified' "$RUN_STDOUT"; then
  fail 'corrupt accepted receipt is never reported as verified'
fi
pass 'corrupt accepted receipt is never reported as verified'

reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state" "$TEST_ROOT/unsafe-receipt"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
printf '%s\n' 'status=verified' >"$TEST_ROOT/unsafe-receipt/receipt"
ln -s "$TEST_ROOT/unsafe-receipt/receipt" \
  "$FIXTURE_HOME/.dotfiles_state/last-accepted-result"
VERIFY_MODE=fail run_setup --desktop --resume
[[ "$RUN_EXIT" -ne 0 ]] || fail 'unsafe-receipt failed verification exits nonzero'
pass 'unsafe-receipt failed verification exits nonzero'
assert_file_contains "$RUN_STDOUT" \
  'Last accepted verification: none (prior receipt invalid or unsafe)' \
  'resume refuses an unsafe accepted receipt'
[[ -L "$FIXTURE_HOME/.dotfiles_state/last-accepted-result" ]] ||
  fail 'unsafe accepted receipt was not replaced or followed'
pass 'unsafe accepted receipt remains untouched'

# A fresh HOME also serializes state-root creation before Phase 6.
reset_fixture
env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" RECORD_DIR="$RECORD_DIR" BLOCK_PHASE6=1 \
  "$FIXTURE_DOTFILES/setup.sh" --desktop --start-phase 6 \
  >"$TEST_ROOT/fresh-owner.stdout" 2>"$TEST_ROOT/fresh-owner.stderr" &
fresh_owner_pid=$!
for _ in $(seq 1 100); do
  [[ "$(grep -c '^entered:' "$RECORD_DIR/calls" 2>/dev/null || true)" -ge 1 ]] && break
  sleep 0.02
done
assert_file_contains "$RECORD_DIR/calls" 'entered:' \
  'fresh setup process reaches Phase 6 after creating state'
run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 75 'fresh concurrent setup process exits with busy status'
assert_file_contains "$RUN_STDERR" 'already running' \
  'fresh concurrent setup reports a truthful busy diagnostic'
: >"$RECORD_DIR/release"
fresh_owner_status=0
wait "$fresh_owner_pid" || fresh_owner_status=$?
assert_equals "$fresh_owner_status" 0 'fresh setup owner completes after its peer is refused'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'fresh setup owner releases its lock'

# A full process owns the lock while Phase 6 is active; a second process is
# refused, and an interrupt leaves the previous checkpoint intact.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
chmod 700 "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" RECORD_DIR="$RECORD_DIR" BLOCK_PHASE6=1 \
  "$FIXTURE_DOTFILES/setup.sh" --resume >"$TEST_ROOT/owner.stdout" 2>"$TEST_ROOT/owner.stderr" &
owner_pid=$!
for _ in $(seq 1 100); do
  [[ "$(grep -c '^entered:' "$RECORD_DIR/calls" 2>/dev/null || true)" -ge 1 ]] && break
  sleep 0.02
done
assert_file_contains "$RECORD_DIR/calls" 'entered:' \
  'first setup process reaches the public Phase 6 collaborator'
[[ -d "$FIXTURE_HOME/.dotfiles_state/setup.lock" ]] ||
  fail 'first setup process publishes its lock before Phase 6'
pass 'first setup process publishes its lock before Phase 6'
run_setup --desktop --start-phase 6
assert_equals "$RUN_EXIT" 75 'concurrent setup process exits with busy status'
assert_file_contains "$RUN_STDERR" 'already running' \
  'concurrent setup process reports a truthful busy diagnostic'
entered_count="$(grep -c '^entered:' "$RECORD_DIR/calls" || true)"
assert_equals "$entered_count" 1 'concurrent setup process does not enter Phase 6'
kill -TERM "$owner_pid"
: >"$RECORD_DIR/release"
owner_status=0
wait "$owner_pid" || owner_status=$?
assert_equals "$owner_status" 143 'interrupted setup preserves conventional TERM status'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/checkpoint")" 6 \
  'interrupted setup retains the previous recoverable checkpoint'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'interrupted setup releases only its own lock'

# An interrupted public process retires a phase writer's grandchild before
# releasing the lock, so no descendant can publish after recovery ownership is
# available to another setup process.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state"
chmod 700 "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' desktop >"$FIXTURE_HOME/.dotfiles_state/profile"
printf '%s\n' 6 >"$FIXTURE_HOME/.dotfiles_state/checkpoint"
env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" RECORD_DIR="$RECORD_DIR" \
  GRANDCHILD_PROBE=1 "$FIXTURE_DOTFILES/setup.sh" --resume \
  >"$TEST_ROOT/grandchild-owner.stdout" 2>"$TEST_ROOT/grandchild-owner.stderr" &
grandchild_owner_pid=$!
for _ in $(seq 1 100); do
  [[ -e "$RECORD_DIR/grandchild-pid" ]] && break
  sleep 0.02
done
assert_file_contains "$RECORD_DIR/calls" 'entered:' \
  'grandchild fixture reaches the public Phase 6 collaborator'
assert_file_exists "$RECORD_DIR/grandchild-pid" \
  'grandchild fixture records its descendant PID'
kill -TERM "$grandchild_owner_pid"
: >"$RECORD_DIR/release"
grandchild_owner_status=0
wait "$grandchild_owner_pid" || grandchild_owner_status=$?
assert_equals "$grandchild_owner_status" 143 \
  'interrupted setup with a grandchild preserves TERM status'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
  'grandchild interruption releases the lock after child retirement'
grandchild_pid="$(<"$RECORD_DIR/grandchild-pid")"
if kill -0 "$grandchild_pid" 2>/dev/null; then
  fail 'grandchild remains live after the setup lock is released'
fi
pass 'grandchild is no longer live when the setup lock is released'
: >"$RECORD_DIR/grandchild-release"
sleep 0.1
if grep -q '^grandchild-late:' "$RECORD_DIR/calls"; then
  fail 'grandchild writes after setup lock release'
fi
pass 'grandchild cannot write after setup lock release'

# A PTY collaborator can trap TERM in a descendant. Escalation must signal
# every captured descendant, then prove the writer is gone before lock release.
reset_fixture
if command -v python3 >/dev/null 2>&1; then
  run_setup_pty_grandchild
  assert_equals "$RUN_PTY_TREE_EXIT" 0 \
    'pty grandchild interruption harness exits successfully'
  assert_equals "$RUN_PTY_TREE_STATUS" 143 \
    'pty grandchild interruption preserves TERM status'
  assert_file_exists "$RECORD_DIR/grandchild-live" \
    'pty descendant creates its writer sentinel before interruption'
  assert_file_absent "$FIXTURE_HOME/.dotfiles_state/setup.lock" \
    'pty descendant lock releases after escalation'
  pty_grandchild_pid="$(<"$RECORD_DIR/grandchild-pid")"
  if kill -0 "$pty_grandchild_pid" 2>/dev/null; then
    fail 'TERM-trapping pty descendant remains live after lock release'
  fi
  pass 'TERM-trapping pty descendant is gone before lock release'
  : >"$RECORD_DIR/grandchild-release"
  sleep 0.1
  if grep -q '^grandchild-late:' "$RECORD_DIR/calls"; then
    fail 'TERM-trapping pty descendant writes after lock release'
  fi
  pass 'TERM-trapping pty descendant cannot write after lock release'
else
  skip 'pty descendant escalation (python3 unavailable)'
fi

printf '1..%d\n' "$assertion_count"
