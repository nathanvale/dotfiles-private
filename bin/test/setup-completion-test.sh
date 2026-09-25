#!/usr/bin/env bash

# Setup completion and input-validation contract.
#
# The production consumer is a fresh-machine operator invoking the complete
# setup.sh process. Each row copies the unchanged public executable into a
# disposable HOME fixture outside Git, supplies harmless Phase 6 collaborators
# and a fake verifier, then observes exit status, streams, durable state, and
# independently recorded collaborator calls. No phase function is extracted or
# reimplemented here.
# shellcheck disable=SC2016

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

assert_file_not_contains() {
  local file="$1" text="$2" label="$3"
  if grep -Fq "$text" "$file"; then
    fail "$label (unexpected [$text])"
  fi
  pass "$label"
}

assert_file_matches() {
  local file="$1" pattern="$2" label="$3"
  grep -Eq "$pattern" "$file" || fail "$label (pattern [$pattern] did not match)"
  pass "$label"
}

assert_file_absent() {
  local file="$1" label="$2"
  [[ ! -e "$file" ]] || fail "$label (found $file)"
  pass "$label"
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

assert_checkpoint_equals() {
  local expected="$1" label="$2"
  local checkpoint_path="$FIXTURE_HOME/.dotfiles_state/checkpoint"
  local checkpoint_exists=no checkpoint_value='<absent>'

  if [[ -e "$checkpoint_path" ]]; then
    checkpoint_exists=yes
    if ! checkpoint_value="$(cat -- "$checkpoint_path" 2>/dev/null)"; then
      checkpoint_value='<unreadable>'
    fi
  fi

  if [[ "$checkpoint_value" != "$expected" ]]; then
    printf 'not ok - %s (expected [%s], got [%s])\n' \
      "$label" "$expected" "$checkpoint_value" >&2
    printf '  setup_exit=%s\n' "$RUN_EXIT" >&2
    printf '  checkpoint_path=%s\n' "$checkpoint_path" >&2
    printf '  checkpoint_exists=%s\n' "$checkpoint_exists" >&2
    printf '  setup_stdout:\n' >&2
    cat -- "$RUN_STDOUT" >&2
    printf '  setup_stderr:\n' >&2
    cat -- "$RUN_STDERR" >&2
    exit 1
  fi

  pass "$label"
}

prepare_fixture() {
  FIXTURE_HOME="$TEST_ROOT/home"
  FIXTURE_DOTFILES="$FIXTURE_HOME/code/dotfiles"
  RECORD_DIR="$TEST_ROOT/records"
  mkdir -p "$FIXTURE_DOTFILES/bin/dotfiles" "$FIXTURE_DOTFILES/config/macos" \
    "$RECORD_DIR"
  cp "$REPO_ROOT/setup.sh" "$FIXTURE_DOTFILES/setup.sh"
  chmod +x "$FIXTURE_DOTFILES/setup.sh"

  mkdir -p "$FIXTURE_DOTFILES/bin/dotfiles/symlinks"
  printf '%s\n' '#!/bin/bash' \
    'printf "symlinks-called\\n" >>"$RECORD_DIR/calls"' \
    >"$FIXTURE_DOTFILES/bin/dotfiles/symlinks/symlinks_manage.sh"
  chmod +x "$FIXTURE_DOTFILES/bin/dotfiles/symlinks/symlinks_manage.sh"

  printf '%s\n' '#!/bin/bash' \
    'printf "prefs-called:%s\\n" "${1:-}" >>"$RECORD_DIR/calls"' \
    >"$FIXTURE_DOTFILES/config/macos/defaults.common.sh"
  chmod +x "$FIXTURE_DOTFILES/config/macos/defaults.common.sh"
}

write_verifier() {
  local mode="$1"
  printf '%s\n' '#!/bin/bash' \
    'printf "verifier-called\\n" >>"$RECORD_DIR/calls"' \
    "case \"$mode\" in" \
    '  pass)' \
    '    printf "Verification Summary: all checks passed\\n"' \
    '    printf "DOTFILES_VERIFY_SUMMARY version=1 status=verified passed=4 failed=0 warnings=0\\n"' \
    '    exit 0' \
    '    ;;' \
  '  warn)' \
    '    printf "\\033[0;36m=== Verification Summary ===\\033[0m\\n"' \
    '    printf "  \\033[0;33mWarnings:\\033[0m 1\\n"' \
    '    printf "  \\033[0;33m⚠ Discord\\033[0m\\n"' \
    '    printf "DOTFILES_VERIFY_SUMMARY version=1 status=qualified passed=4 failed=0 warnings=1\\n"' \
    '    exit 0' \
    '    ;;' \
  '  fail)' \
    '    printf "Verification Summary: one required check failed\\n"' \
    '    printf "DOTFILES_VERIFY_SUMMARY version=1 status=failed passed=3 failed=1 warnings=0\\n"' \
    '    exit 1' \
    '    ;;' \
  '  no-summary)' \
    '    printf "Verification Summary: no machine summary\\n"' \
    '    exit 0' \
    '    ;;' \
  '  malformed)' \
    '    printf "DOTFILES_VERIFY_SUMMARY version=1 status=qualified passed=4 failed=0\\n"' \
    '    exit 0' \
    '    ;;' \
  '  mismatch)' \
    '    printf "DOTFILES_VERIFY_SUMMARY version=1 status=qualified passed=4 failed=0 warnings=1\\n"' \
    '    exit 1' \
    '    ;;' \
    'esac' \
    >"$FIXTURE_DOTFILES/verify_install.sh"
  chmod +x "$FIXTURE_DOTFILES/verify_install.sh"
}

reset_fixture() {
  rm -rf "$FIXTURE_HOME/.dotfiles_state" "$RECORD_DIR" \
    "$FIXTURE_DOTFILES/verify_install.sh"
  mkdir -p "$RECORD_DIR"
}

run_setup() {
  local extra_profile="$1" verify_mode="$2"
  shift 2
  local -a setup_args=("$@")
  RUN_STDOUT="$TEST_ROOT/stdout"
  RUN_STDERR="$TEST_ROOT/stderr"

  set +e
  if [[ "$extra_profile" == __EMPTY__ ]]; then
    env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" \
      RECORD_DIR="$RECORD_DIR" DOTFILES_PROFILE='' \
      VERIFY_MODE="$verify_mode" "$FIXTURE_DOTFILES/setup.sh" "${setup_args[@]}" \
      >"$RUN_STDOUT" 2>"$RUN_STDERR"
  elif [[ -n "$extra_profile" ]]; then
    env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" \
      RECORD_DIR="$RECORD_DIR" DOTFILES_PROFILE="$extra_profile" \
      VERIFY_MODE="$verify_mode" "$FIXTURE_DOTFILES/setup.sh" "${setup_args[@]}" \
      >"$RUN_STDOUT" 2>"$RUN_STDERR"
  else
    env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" \
      RECORD_DIR="$RECORD_DIR" VERIFY_MODE="$verify_mode" \
      "$FIXTURE_DOTFILES/setup.sh" "${setup_args[@]}" \
      >"$RUN_STDOUT" 2>"$RUN_STDERR"
  fi
  RUN_EXIT=$?
  set -e
}

run_setup_relative() {
  local verify_mode="$1"
  shift
  RUN_STDOUT="$TEST_ROOT/stdout"
  RUN_STDERR="$TEST_ROOT/stderr"

  set +e
  (
    cd "$FIXTURE_DOTFILES"
    env -i HOME="$FIXTURE_HOME" PATH="/usr/bin:/bin" \
      RECORD_DIR="$RECORD_DIR" VERIFY_MODE="$verify_mode" \
      ./setup.sh "$@"
  ) >"$RUN_STDOUT" 2>"$RUN_STDERR"
  RUN_EXIT=$?
  set -e
}

prepare_fixture

# ---------------------------------------------------------------------------
# Input validation must happen before state creation or phase selection.
# ---------------------------------------------------------------------------
run_setup '' pass --desktop --start-phase 99
[[ "$RUN_EXIT" -ne 0 ]] || fail 'out-of-range phase exits nonzero'
pass 'out-of-range phase exits nonzero'
assert_file_contains "$RUN_STDERR" '0 through 6' \
  'out-of-range phase reports the valid range'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state" \
  'out-of-range phase creates no setup state'

run_setup '' pass --desktop --start-phase
[[ "$RUN_EXIT" -ne 0 ]] || fail 'missing phase argument exits nonzero'
pass 'missing phase argument exits nonzero'
assert_file_contains "$RUN_STDERR" 'requires a phase number' \
  'missing phase argument reports its arity'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state" \
  'missing phase argument creates no setup state'

run_setup '' pass --desktop --start-phase nope
[[ "$RUN_EXIT" -ne 0 ]] || fail 'nonnumeric phase exits nonzero'
pass 'nonnumeric phase exits nonzero'
assert_file_contains "$RUN_STDERR" '0 through 6' \
  'nonnumeric phase reports the valid range'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state" \
  'nonnumeric phase creates no setup state'

run_setup invalid pass --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'invalid environment profile exits nonzero'
pass 'invalid environment profile exits nonzero'
assert_file_contains "$RUN_STDERR" 'Invalid DOTFILES_PROFILE profile' \
  'invalid environment profile names its source'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state" \
  'invalid environment profile creates no setup state'

run_setup __EMPTY__ pass --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'empty environment profile exits nonzero'
pass 'empty environment profile exits nonzero'
assert_file_contains "$RUN_STDERR" 'Invalid DOTFILES_PROFILE profile' \
  'empty environment profile is validated as supplied input'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state" \
  'empty environment profile creates no setup state'

mkdir -p "$FIXTURE_HOME/.dotfiles_state"
printf '%s\n' invalid >"$FIXTURE_HOME/.dotfiles_state/profile"
run_setup '' pass --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'invalid stored profile exits nonzero'
pass 'invalid stored profile exits nonzero'
assert_file_contains "$RUN_STDERR" 'Invalid stored profile' \
  'invalid stored profile names its source'
assert_equals "$(< "$FIXTURE_HOME/.dotfiles_state/profile")" invalid \
  'invalid stored profile is not overwritten before validation'

# The documented relative invocation is the installed setup process. It must
# not enter the noninteractive curl-bootstrap branch and pull remote state.
reset_fixture
write_verifier pass
run_setup_relative pass --desktop --start-phase 6
[[ "$RUN_EXIT" -eq 0 ]] || fail 'relative setup invocation exits zero'
pass 'relative setup invocation exits zero'
if grep -Fq 'Pulling latest changes' "$RUN_STDOUT"; then
  fail 'relative setup invocation does not pull remote state'
fi
pass 'relative setup invocation does not pull remote state'

# ---------------------------------------------------------------------------
# A valid suffix executes, verifies, records its receipt, and clears the
# checkpoint only after verification has passed.
# ---------------------------------------------------------------------------
reset_fixture
write_verifier pass
run_setup '' pass --desktop --start-phase 6
[[ "$RUN_EXIT" -eq 0 ]] || fail 'valid phase suffix exits zero after verification'
pass 'valid phase suffix exits zero after verification'
assert_file_contains "$RUN_STDOUT" 'Executing phase suffix: 6' \
  'valid phase suffix is documented in process output'
assert_file_contains "$RECORD_DIR/calls" 'symlinks-called' \
  'valid suffix executes the configuration phase'
assert_file_contains "$RECORD_DIR/calls" 'prefs-called:--set' \
  'valid suffix executes the preference step'
assert_file_contains "$RECORD_DIR/calls" 'verifier-called' \
  'successful suffix runs the final verifier'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/checkpoint" \
  'successful verification clears the checkpoint'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" 'status=verified' \
  'successful verification writes a verified result'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'verification_summary=DOTFILES_VERIFY_SUMMARY version=1 status=verified' \
  'successful verification records the machine summary'
assert_file_contains "$RUN_STDOUT" 'SETUP VERIFIED' \
  'successful verification reports verified completion'

# Server setup retains symlink and verification work, but never applies
# interactive desktop preference writes.
reset_fixture
write_verifier pass
run_setup '' pass --server --start-phase 6
[[ "$RUN_EXIT" -eq 0 ]] || fail 'server configuration suffix exits zero after verification'
pass 'server configuration suffix exits zero after verification'
assert_file_contains "$RECORD_DIR/calls" 'symlinks-called' \
  'server configuration suffix executes symlinks'
assert_file_not_contains "$RECORD_DIR/calls" 'prefs-called:--set' \
  'server configuration suffix skips desktop preferences'
assert_file_contains "$RECORD_DIR/calls" 'verifier-called' \
  'server configuration suffix runs the final verifier'

# ---------------------------------------------------------------------------
# A mandatory verifier failure retains the checkpoint and gives a repair path.
# ---------------------------------------------------------------------------
reset_fixture
write_verifier fail
run_setup '' fail --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'mandatory verifier failure exits nonzero'
pass 'mandatory verifier failure exits nonzero'
assert_checkpoint_equals 7 \
  'mandatory verifier failure retains the completed-phase checkpoint'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" 'status=failed' \
  'mandatory verifier failure writes a failed result'
assert_file_contains "$RUN_STDOUT" 'run ./setup.sh --resume' \
  'mandatory verifier failure names the resume repair route'
if grep -Fq 'SETUP VERIFIED' "$RUN_STDOUT"; then
  fail 'mandatory verifier failure never reports verified completion'
fi
pass 'mandatory verifier failure never reports verified completion'

write_verifier pass
run_setup '' pass --resume
[[ "$RUN_EXIT" -eq 0 ]] || fail 'resume repair route exits zero after verifier repair'
pass 'resume repair route exits zero after verifier repair'
assert_file_contains "$RUN_STDOUT" 'none (verification only)' \
  'resume repair route documents verification-only execution'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/checkpoint" \
  'resume repair route clears the retained checkpoint after verification'

# ---------------------------------------------------------------------------
# A missing or malformed machine summary is mandatory and remains recoverable.
# ---------------------------------------------------------------------------
reset_fixture
write_verifier no-summary
run_setup '' no-summary --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'missing machine summary exits nonzero'
pass 'missing machine summary exits nonzero'
assert_checkpoint_equals 7 \
  'missing machine summary retains the completed-phase checkpoint'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'verification=summary-missing-or-malformed' \
  'missing machine summary writes a failed result'
assert_file_contains "$RUN_STDOUT" 'machine-readable summary' \
  'missing machine summary names the repair boundary'

reset_fixture
write_verifier malformed
run_setup '' malformed --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'malformed machine summary exits nonzero'
pass 'malformed machine summary exits nonzero'
assert_checkpoint_equals 7 \
  'malformed machine summary retains the completed-phase checkpoint'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'verification=summary-missing-or-malformed' \
  'malformed machine summary writes a failed result'

reset_fixture
write_verifier mismatch
run_setup '' mismatch --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'contradictory machine summary exits nonzero'
pass 'contradictory machine summary exits nonzero'
assert_checkpoint_equals 7 \
  'contradictory machine summary retains the completed-phase checkpoint'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'verification=summary-exit-mismatch:1' \
  'contradictory machine summary writes a failed result'

# ---------------------------------------------------------------------------
# A missing verifier is also mandatory and remains recoverable.
# ---------------------------------------------------------------------------
reset_fixture
run_setup '' pass --desktop --start-phase 6
[[ "$RUN_EXIT" -ne 0 ]] || fail 'missing verifier exits nonzero'
pass 'missing verifier exits nonzero'
assert_checkpoint_equals 7 \
  'missing verifier retains the completed-phase checkpoint'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" 'verification=missing' \
  'missing verifier writes an unavailable result'
assert_file_contains "$RUN_STDOUT" 'verify_install.sh' \
  'missing verifier names the repair owner'
assert_file_contains "$RUN_STDOUT" 'run ./setup.sh --resume' \
  'missing verifier names the resume repair route'

# ---------------------------------------------------------------------------
# Exit-zero verifier warnings are accepted only as a durable qualified result.
# ---------------------------------------------------------------------------
reset_fixture
write_verifier warn
run_setup '' warn --desktop --start-phase 6
[[ "$RUN_EXIT" -eq 0 ]] || fail 'qualified warning result exits zero'
pass 'qualified warning result exits zero'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" 'status=qualified' \
  'warning result is durably marked qualified'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'verification_summary=DOTFILES_VERIFY_SUMMARY version=1 status=qualified' \
  'warning result records the machine summary'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/setup-result" \
  'warnings=see verification_output' \
  'warning result points to the durable raw warning report'
assert_file_contains "$FIXTURE_HOME/.dotfiles_state/verification.log" '⚠ Discord' \
  'warning result retains the verifier warning row'
assert_file_absent "$FIXTURE_HOME/.dotfiles_state/checkpoint" \
  'accepted warning result clears the checkpoint'
assert_file_contains "$RUN_STDOUT" 'qualified, not verified' \
  'accepted warning result does not claim verified completion'

# Verification refuses a pre-existing log symlink before any child can follow
# it, preserving both foreign bytes and the recoverable checkpoint.
reset_fixture
mkdir -p "$FIXTURE_HOME/.dotfiles_state/foreign"
printf '%s\n' preserve-me >"$FIXTURE_HOME/.dotfiles_state/foreign/target"
ln -s "$FIXTURE_HOME/.dotfiles_state/foreign/target" \
  "$FIXTURE_HOME/.dotfiles_state/verification.log"
write_verifier pass
run_setup '' pass --desktop --start-phase 6
assert_equals "$RUN_EXIT" 1 \
  'verification log symlink rejects an otherwise valid verification'
assert_equals "$(<"$FIXTURE_HOME/.dotfiles_state/foreign/target")" preserve-me \
  'verification log symlink preserves its foreign target bytes'
[[ -L "$FIXTURE_HOME/.dotfiles_state/verification.log" ]] ||
  fail 'verification log symlink was not replaced or followed'
pass 'verification log symlink remains untouched'
assert_checkpoint_equals 7 \
  'verification log symlink retains the completed-phase checkpoint'
assert_file_contains "$RUN_STDOUT" 'verification log' \
  'verification log symlink reports the unsafe state path'

# ---------------------------------------------------------------------------
# The real public verifier emits the stable summary through a disposable HOME.
# It is expected to fail here because the fixture has no installed tools; the
# contract line must still be present and machine-readable.
# ---------------------------------------------------------------------------
actual_verifier_home="$TEST_ROOT/actual-verifier-home"
actual_verifier_dotfiles="$TEST_ROOT/actual-verifier-dotfiles"
mkdir -p "$actual_verifier_dotfiles"
cp "$REPO_ROOT/verify_install.sh" "$actual_verifier_dotfiles/verify_install.sh"
chmod +x "$actual_verifier_dotfiles/verify_install.sh"
set +e
env -i HOME="$actual_verifier_home" PATH="/usr/bin:/bin" \
  DOTFILES_PROFILE=desktop "$actual_verifier_dotfiles/verify_install.sh" --machine-summary \
  >"$TEST_ROOT/actual-verifier-stdout" 2>"$TEST_ROOT/actual-verifier-stderr"
actual_verifier_exit=$?
set -e
[[ "$actual_verifier_exit" -ne 0 ]] || fail 'real verifier fixture reports unavailable installation'
pass 'real verifier fixture reports unavailable installation'
assert_file_matches "$TEST_ROOT/actual-verifier-stdout" \
  '^DOTFILES_VERIFY_SUMMARY version=1 status=(verified|qualified|failed) passed=[0-9]+ failed=[0-9]+ warnings=[0-9]+$' \
  'real verifier emits one stable machine summary'
actual_summary_count="$(grep -Ec '^DOTFILES_VERIFY_SUMMARY ' "$TEST_ROOT/actual-verifier-stdout")"
assert_equals "$actual_summary_count" 1 \
  'real verifier emits exactly one machine summary'

# ---------------------------------------------------------------------------
# The source-checkout activation boundary remains enforced by the public
# process. This is intentionally a separate real-checkout canary from the
# disposable fixture used for setup behaviour.
# ---------------------------------------------------------------------------
boundary_home="$TEST_ROOT/boundary-home"
boundary_source="$TEST_ROOT/boundary-source"
boundary_worktree="$TEST_ROOT/boundary-worktree"
mkdir -p "$boundary_home" "$boundary_source"
cp "$REPO_ROOT/setup.sh" "$boundary_source/setup.sh"
git -c init.defaultBranch=main init -q "$boundary_source"
git -C "$boundary_source" add setup.sh
git -C "$boundary_source" -c core.hooksPath=/dev/null \
  -c user.name='Setup test fixture' -c user.email='setup-fixture@example.invalid' \
  commit -q -m 'Create isolated activation fixture' -- setup.sh
git -C "$boundary_source" worktree add -q --detach "$boundary_worktree" HEAD
set +e
env -i HOME="$boundary_home" PATH="/usr/bin:/bin" \
  "$boundary_worktree/setup.sh" --desktop --start-phase 6 \
  >"$TEST_ROOT/boundary-stdout" 2>"$TEST_ROOT/boundary-stderr"
boundary_exit=$?
set -e
[[ "$boundary_exit" -ne 0 ]] || fail 'linked-worktree activation exits nonzero'
pass 'linked-worktree activation exits nonzero'
assert_file_contains "$TEST_ROOT/boundary-stdout" 'linked worktree is blocked' \
  'linked-worktree activation reports the canonical checkout boundary'

expected_assertions=73
[[ "$assertion_count" -eq "$expected_assertions" ]] ||
  fail "expected $expected_assertions assertions, observed $assertion_count"
printf '1..%d\n' "$assertion_count"
