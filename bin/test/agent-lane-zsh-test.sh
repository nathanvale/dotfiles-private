#!/usr/bin/env bash
#
# Agent lane zsh wrapper contract.
#
# `bin/agent-lane-zsh` sits in CLAUDE_CODE_SHELL and corrects one hardcoded
# reference in Claude's snapshot-creation invocation. It is trusted with every
# command Claude runs through a shell, so its contract is narrow and its
# failures must be loud:
#
#   rewrite        the exact canonical $HOME/.zshrc reference becomes
#                  $ZDOTDIR/.zshrc, and nothing else in argv moves
#   pass-through   any other invocation reaches the real zsh argv-for-argv
#   fail closed    a snapshot-creation shape whose assumptions do not hold
#                  exits non-zero rather than yielding a canonical snapshot
#                  that would be reported as a bound one
#   silence        neither stream carries the generated script
#
# Every row runs the wrapper against the REAL /bin/zsh. There is no override
# hook: an escape hatch that existed only for tests would be a production path
# nobody exercises, and the rows would prove the hatch rather than the shell the
# wrapper actually execs.
#
# The oracle is therefore what a real zsh DID, observed through fixture scripts
# that report which config they read or echo their positional parameters. The
# expected values are literals written here, never a recomputation of the
# wrapper's own substitution.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$REPO_ROOT/bin/agent-lane-zsh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assertion_count=0
skip_count=0

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

skip() {
  assertion_count=$((assertion_count + 1))
  skip_count=$((skip_count + 1))
  printf 'ok %d - # SKIP %s\n' "$assertion_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

[[ -x "$WRAPPER" ]] || fail 'bin/agent-lane-zsh is not executable'
pass 'the wrapper is executable'

# A distinctive value planted in every generated script. The wrapper must never
# echo it, so proving silence never reproduces it.
SCRIPT_BODY_MARKER='agent-lane-zsh-script-body-marker-do-not-print'

stream_is_clean() {
  [[ "$1" != *"$SCRIPT_BODY_MARKER"* ]]
}

# Negative control: without this, a silence row would pass against a predicate
# that matched nothing.
if stream_is_clean "noise ${SCRIPT_BODY_MARKER} noise"; then
  fail 'disclosure detector accepted a stream carrying the script body'
fi
pass 'disclosure detector rejects a planted script body'
if stream_is_clean 'ordinary diagnostic'; then
  pass 'disclosure detector accepts a clean stream'
else
  fail 'disclosure detector rejected a clean stream'
fi

# --- Fixture homes ----------------------------------------------------------
#
# Each config prints a distinct token when sourced. Which token comes back is
# the oracle: it names the file a real zsh actually read, rather than asserting
# something about the text the wrapper produced.
make_home_pair() {
  local home_dir="$1" bound_dir="$2"
  mkdir -p "$home_dir" "$bound_dir"
  printf 'print -r -- CONFIG=canonical\n' >"$home_dir/.zshrc"
  printf 'print -r -- CONFIG=bound\n' >"$bound_dir/.zshrc"
}

fake_home="$TEST_ROOT/home"
bound_dir="$TEST_ROOT/bound"
make_home_pair "$fake_home" "$bound_dir"

# Run the wrapper through the real zsh.
# Sets wrap_out, wrap_err, wrap_status.
run_wrapper() {
  local err_file="$TEST_ROOT/stderr"
  : >"$err_file"
  set +e
  wrap_out="$(
    env -i \
      HOME="$home_under_test" \
      ZDOTDIR="${bind:-}" \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TERM=dumb \
      "$WRAPPER" "$@" 2>"$err_file"
  )"
  wrap_status=$?
  set -e
  wrap_err="$(<"$err_file")"
}

# The snapshot-shaped script. It sources the canonical config the way Claude's
# generated script does, so after rewriting a real zsh must read the bound one.
snapshot_script_for() {
  printf 'source %s\nprint -r -- MARKER=%s\n' "$1/.zshrc" "$SCRIPT_BODY_MARKER"
}

# --- Rewrite ----------------------------------------------------------------
home_under_test="$fake_home"
bind="$bound_dir"
run_wrapper -c "$(snapshot_script_for "$fake_home")"

assert_equals "$wrap_status" '0' 'rewrite: the wrapper exits zero'
# The config token is the whole claim: a real zsh read the bound file.
assert_equals "$(grep '^CONFIG=' <<<"$wrap_out")" 'CONFIG=bound' \
  'rewrite: the real shell reads the bound config'
if grep -q '^CONFIG=canonical$' <<<"$wrap_out"; then
  fail 'rewrite: the real shell also read the canonical config'
fi
pass 'rewrite: the real shell does not read the canonical config'

# --- Silence ----------------------------------------------------------------
#
# The script body marker is echoed BY the script, so stdout legitimately carries
# it. What must stay clean is the wrapper's own diagnostic channel.
stream_is_clean "$wrap_err" || fail 'rewrite: stderr carried the script body'
pass 'rewrite: stderr carries no script body'

# --- Pass-through -----------------------------------------------------------
#
# Every invocation that is not snapshot creation must arrive unchanged. These
# rows are what make the wrapper safe in front of every Claude command.
run_wrapper -c 'print -r -- MARKER=ordinary'
assert_equals "$wrap_status" '0' 'pass-through: an ordinary -c script exits zero'
assert_equals "$(grep '^MARKER=' <<<"$wrap_out")" 'MARKER=ordinary' \
  'pass-through: an ordinary -c script runs unchanged'

# Positional parameters must survive: zsh assigns them from the arguments after
# the script, and dropping them would change what the script sees.
run_wrapper -c 'print -r -- "ARGS=$1,$2"' script_name alpha beta
assert_equals "$wrap_status" '0' 'pass-through: trailing arguments exit zero'
assert_equals "$(grep '^ARGS=' <<<"$wrap_out")" 'ARGS=alpha,beta' \
  'pass-through: positional parameters reach the script'

# An argument containing whitespace must stay ONE argument. A quoting defect
# shows up here as a split value rather than as a visible error.
run_wrapper -c 'print -r -- "ARGS=$1"' script_name 'value with spaces'
assert_equals "$(grep '^ARGS=' <<<"$wrap_out")" 'ARGS=value with spaces' \
  'pass-through: a spaced argument stays one argument'

# Multiline command text must survive the rewrite path intact.
home_under_test="$fake_home"
bind="$bound_dir"
run_wrapper -c "$(printf 'source %s\nprint -r -- LINE=one\nprint -r -- LINE=two\n' "$fake_home/.zshrc")"
assert_equals "$wrap_status" '0' 'rewrite: a multiline script exits zero'
assert_equals "$(grep -c '^LINE=' <<<"$wrap_out")" '2' \
  'rewrite: a multiline script keeps every line'

# --- The live argv shape: -c -l SCRIPT --------------------------------------
#
# This is the shape the installed Claude runtime actually execs, and it is the
# one that defeated the first wrapper. zsh keeps parsing options after `-c`, so
# the script is the first NON-OPTION argument; a wrapper that took the argument
# immediately following `-c` selected `-l`, found no canonical reference, and
# passed the invocation through. The lane then captured the canonical profile
# while still reporting profile_binding=worktree.
#
# The oracle is the config a real zsh read, so this row fails against
# next-argument selection rather than merely describing the argv.
home_under_test="$fake_home"
bind="$bound_dir"
run_wrapper -c -l "$(snapshot_script_for "$fake_home")"
assert_equals "$wrap_status" '0' 'live shape: -c -l SCRIPT exits zero'
assert_equals "$(grep '^CONFIG=' <<<"$wrap_out")" 'CONFIG=bound' \
  'live shape: -c -l SCRIPT reads the bound config'
if grep -q '^CONFIG=canonical$' <<<"$wrap_out"; then
  fail 'live shape: -c -l SCRIPT also read the canonical config'
fi
pass 'live shape: -c -l SCRIPT does not read the canonical config'

# The login flag must still reach the shell. Dropping it would change startup
# behaviour while the rewrite row above still passed.
run_wrapper -c -l 'print -r -- "LOGIN=$options[login]"'
assert_equals "$(grep '^LOGIN=' <<<"$wrap_out")" 'LOGIN=on' \
  'live shape: the login flag survives to the real shell'

# Options bundled with c, as in `-lc`, name the same shape.
run_wrapper -lc "$(snapshot_script_for "$fake_home")"
assert_equals "$wrap_status" '0' 'live shape: a bundled -lc exits zero'
assert_equals "$(grep '^CONFIG=' <<<"$wrap_out")" 'CONFIG=bound' \
  'live shape: a bundled -lc reads the bound config'

# Positional parameters after the script must still arrive.
run_wrapper -c -l 'print -r -- "ARGS=$1"' script_name alpha
assert_equals "$(grep '^ARGS=' <<<"$wrap_out")" 'ARGS=alpha' \
  'live shape: positional parameters survive -c -l'

# An operand without -c is not a script, so it must not be rewritten. Without
# this, a wrapper that treated the first operand as a script regardless would
# corrupt an ordinary file argument.
script_file="$TEST_ROOT/ordinary-script.zsh"
printf 'print -r -- FILE=ran\n' >"$script_file"
run_wrapper -l "$script_file"
assert_equals "$wrap_status" '0' 'live shape: a file argument without -c exits zero'
assert_equals "$(grep '^FILE=' <<<"$wrap_out")" 'FILE=ran' \
  'live shape: a file argument without -c runs unmodified'

# --- Pattern characters in paths --------------------------------------------
#
# The substitution must be an exact-literal replacement. A glob-based one would
# treat `[`, `]`, `*`, or `?` in HOME as pattern syntax and either match the
# wrong text or fail to match at all, so the wrapper would pass the canonical
# reference through while reporting success.
pattern_home="$TEST_ROOT/ho[me]*x"
pattern_bound="$TEST_ROOT/bo[un]*d"
if mkdir -p "$pattern_home" "$pattern_bound" 2>/dev/null; then
  make_home_pair "$pattern_home" "$pattern_bound"
  home_under_test="$pattern_home"
  bind="$pattern_bound"
  run_wrapper -c "$(snapshot_script_for "$pattern_home")"
  assert_equals "$wrap_status" '0' 'pattern paths: the wrapper exits zero'
  assert_equals "$(grep '^CONFIG=' <<<"$wrap_out")" 'CONFIG=bound' \
    'pattern paths: a path with glob characters still rewrites exactly'
else
  skip 'pattern paths: the wrapper exits zero (filesystem refused the name)'
  skip 'pattern paths: a path with glob characters still rewrites exactly'
fi

# --- Fail closed ------------------------------------------------------------
#
# Each row below is a case where the wrapper's assumptions do not hold. The
# requirement is refusal, because the alternative is a canonical snapshot
# reported as a bound one, and that is a false pass rather than a visible gap.
home_under_test="$fake_home"

# Snapshot creation with no binding at all.
bind=''
run_wrapper -c "$(snapshot_script_for "$fake_home")"
[[ "$wrap_status" -ne 0 ]] || fail 'fail-closed: a missing ZDOTDIR must be refused'
pass 'fail-closed: a missing ZDOTDIR is refused'
# The refusal must be this wrapper's own deliberate diagnostic naming the
# absent binding, not merely any diagnostic that happens to mention ZDOTDIR.
# The bound-but-empty guard below dies with a different message ("holds no
# .zshrc to substitute") that also carries the prefix and the word ZDOTDIR, so
# matching that substring alone would pass even with this guard deleted.
# Requiring the exact "no ZDOTDIR binding" wording is what makes this row
# discriminate this guard from the guard after it.
case "$wrap_err" in
  'agent-lane-zsh: '*'no ZDOTDIR binding'*)
    pass 'fail-closed: the refusal is the wrapper own diagnostic naming the binding' ;;
  *) fail 'fail-closed: the refusal is not the wrapper own diagnostic' ;;
esac
stream_is_clean "$wrap_err" || fail 'fail-closed: the refusal leaked the script body'
pass 'fail-closed: the refusal leaks no script body'

# The refusal must happen before the shell runs, or the wrong snapshot already
# exists by the time the wrapper objects.
if grep -q '^CONFIG=' <<<"$wrap_out"; then
  fail 'fail-closed: a config was read despite the refusal'
fi
pass 'fail-closed: no config is read for a refused invocation'

# Snapshot creation bound to a directory holding no .zshrc to substitute.
bind="$TEST_ROOT/empty-bind"
mkdir -p "$bind"
run_wrapper -c "$(snapshot_script_for "$fake_home")"
[[ "$wrap_status" -ne 0 ]] || fail 'fail-closed: a binding with no .zshrc must be refused'
pass 'fail-closed: a binding with no .zshrc is refused'

# ZDOTDIR entirely ABSENT from the environment, not merely empty.
#
# The two cases are distinct and each needs its own row. An empty ZDOTDIR is
# caught downstream by the missing-.zshrc check, so the rows above pass with or
# without the emptiness guard. Only a genuinely unset variable reaches the guard
# first, and under `set -u` an unguarded read would abort with a raw bash error
# instead of a handled refusal. This row is what holds that guard in place.
absent_err="$TEST_ROOT/stderr.absent"
: >"$absent_err"
set +e
env -i \
  HOME="$fake_home" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  TERM=dumb \
  "$WRAPPER" -c "$(snapshot_script_for "$fake_home")" >/dev/null 2>"$absent_err"
absent_status=$?
set -e
[[ "$absent_status" -ne 0 ]] || fail 'fail-closed: an absent ZDOTDIR must be refused'
pass 'fail-closed: an absent ZDOTDIR is refused'

absent_message="$(<"$absent_err")"
case "$absent_message" in
  'agent-lane-zsh: '*ZDOTDIR*)
    pass 'fail-closed: an absent ZDOTDIR gets a handled refusal, not a shell error' ;;
  *) fail 'fail-closed: an absent ZDOTDIR did not produce the wrapper own diagnostic' ;;
esac

printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
