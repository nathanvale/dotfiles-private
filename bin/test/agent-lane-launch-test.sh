#!/usr/bin/env bash
#
# Agent lane launch contract.
#
# `bin/agent-lane-launch` prints the commands that start each proof lane. Those
# commands are the only thing standing between a fresh product session and a
# receipt that silently proves nothing, so the printed text is a contract:
#
#   the child really receives LANE_START   an unexported variable never reaches
#                                          the product, and the in-session
#                                          receipt would read an empty
#                                          --task-start and skip its ordering gate
#   the child really loses CDPATH          an inherited search path would be
#                                          captured into the snapshot and change
#                                          how every agent command resolves `cd`
#   the child really gains ZDOTDIR         this is what makes the lane read the
#                                          repaired startup owners at all
#   every required lane is offered         a command tool and an integrated
#                                          terminal are separate lanes
#
# The central rows do not inspect the printed text. They EXECUTE the emitted
# launch against a stub standing in for the product, and read the environment
# that stub actually received. A test that grepped for `LANE_START=` would have
# passed against the earlier broken form, where the assignment sat on its own
# line and never reached the child at all.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
LAUNCHER="$REPO_ROOT/bin/agent-lane-launch"
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

[[ -x "$LAUNCHER" ]] || fail 'bin/agent-lane-launch is not executable'
pass 'the launcher is executable'

# --- Lane inventory ---------------------------------------------------------
#
# Issue 54 names the lanes that must exist. A command tool and an integrated
# terminal are distinct lanes for the same product, and the earlier revision of
# this launcher offered no Claude terminal at all, so the omission is exactly
# the kind a named list catches.
all_output="$("$LAUNCHER")"
for lane in codex-command codex-terminal claude-bash claude-terminal claude-subagent; do
  if ! grep -q -- "---- lane: ${lane} ----" <<<"$all_output"; then
    fail "the launcher does not offer the ${lane} lane"
  fi
  pass "the launcher offers the ${lane} lane"
done

# Selecting one lane must print that lane and not another, or an operator
# following a single-lane instruction would launch the wrong lane.
one_output="$("$LAUNCHER" claude-terminal)"
grep -q -- '---- lane: claude-terminal ----' <<<"$one_output" ||
  fail 'selecting one lane did not print it'
pass 'selecting one lane prints it'
if grep -q -- '---- lane: claude-bash ----' <<<"$one_output"; then
  fail 'selecting one lane also printed another lane'
fi
pass 'selecting one lane prints only that lane'

# --- The emitted launch is executed against a stub --------------------------
#
# A stub named `claude` is placed first on PATH. Running the emitted launch line
# therefore starts the stub instead of the real product, and the stub records
# the environment it was handed. That recorded environment is the oracle: it is
# what a real product would have received.
stub_dir="$TEST_ROOT/stub"
mkdir -p "$stub_dir"
env_dump="$TEST_ROOT/child-env"

for product in claude codex; do
  cat >"$stub_dir/$product" <<STUB
#!/usr/bin/env bash
# Stands in for the product. Records the environment it was launched with.
{
  printf 'LANE_START=%s\n' "\${LANE_START-<unset>}"
  printf 'ZDOTDIR=%s\n' "\${ZDOTDIR-<unset>}"
  printf 'CDPATH=%s\n' "\${CDPATH-<unset>}"
} >"$env_dump"
exit 0
STUB
  chmod +x "$stub_dir/$product"
done

# Extract the executable launch line for a lane: the one line that is not a
# comment and not blank.
launch_line_for() {
  "$LAUNCHER" "$1" | grep -v '^#' | grep -v '^$' | head -1
}

# Run one lane's launch line with a hostile ambient environment.
#
# CDPATH is seeded deliberately. The launcher's whole reason for `-u CDPATH` is
# that a parent session can export one, so a run whose parent had none would
# prove nothing about removing it.
run_launch() {
  local lane="$1"
  local line
  line="$(launch_line_for "$lane")"
  [[ -n "$line" ]] || fail "$lane: no executable launch line was emitted"
  : >"$env_dump"
  (
    export PATH="$stub_dir:$PATH"
    export CDPATH='/tmp:/var/tmp:/usr'
    export ZDOTDIR="$TEST_ROOT/wrong-zdotdir"
    eval "$line"
  ) >/dev/null 2>&1 || fail "$lane: the emitted launch line failed to run"
  child_lane_start="$(sed -n 's/^LANE_START=//p' "$env_dump")"
  child_zdotdir="$(sed -n 's/^ZDOTDIR=//p' "$env_dump")"
  child_cdpath="$(sed -n 's/^CDPATH=//p' "$env_dump")"
}

# Every product lane that actually launches a product is proved. The subagent
# lane emits no launch line of its own: it runs inside the Claude session that
# the claude-bash line already started, so it has no environment boundary to
# assert here.
for lane in codex-command codex-terminal claude-bash claude-terminal; do
  run_launch "$lane"

  # LANE_START must be present AND numeric. Presence alone is not enough: an
  # empty or non-numeric value is refused by the receipt tool's ordering gate,
  # which would silently downgrade the lane to unproved.
  [[ "$child_lane_start" =~ ^[0-9]+$ ]] ||
    fail "$lane: child did not receive a numeric LANE_START (got [$child_lane_start])"
  pass "$lane: child receives a numeric LANE_START"

  # The stamp must be a plausible current time rather than a literal or a zero.
  # A launch that shipped a constant would satisfy the numeric row above while
  # making the ordering gate meaningless.
  now="$(date +%s)"
  if [[ "$child_lane_start" -lt $((now - 300)) || "$child_lane_start" -gt $((now + 300)) ]]; then
    fail "$lane: LANE_START is not a current timestamp"
  fi
  pass "$lane: LANE_START is a current timestamp"

  # ZDOTDIR must be the exact worktree, overriding the wrong one the parent
  # exported. Comparing against the seeded wrong value is what proves the
  # launcher set it rather than merely inheriting something.
  assert_equals "$child_zdotdir" "$REPO_ROOT" "$lane: child receives the exact worktree ZDOTDIR"

  # CDPATH must be gone entirely, not merely emptied: a present-but-empty
  # variable is still captured into a snapshot as a set variable.
  assert_equals "$child_cdpath" '<unset>' "$lane: inherited CDPATH is absent from the child"
done


# --- Claude-only wrapper wiring ---------------------------------------------
#
# The snapshot wrapper corrects one Claude-specific invocation shape. Applying
# it to Codex would put an unproved wrapper in front of a second product's
# shell, so the binding is asserted present for Claude and absent for Codex.
for lane in claude-bash claude-terminal; do
  line="$(launch_line_for "$lane")"
  case "$line" in
    *"CLAUDE_CODE_SHELL=$REPO_ROOT/bin/agent-lane-zsh"*)
      pass "$lane: the launch sets CLAUDE_CODE_SHELL to the repository wrapper" ;;
    *) fail "$lane: the launch does not set CLAUDE_CODE_SHELL to the repository wrapper" ;;
  esac
done

for lane in codex-command codex-terminal; do
  line="$(launch_line_for "$lane")"
  case "$line" in
    *CLAUDE_CODE_SHELL*) fail "$lane: a Codex launch must not set CLAUDE_CODE_SHELL" ;;
    *) pass "$lane: the launch leaves CLAUDE_CODE_SHELL unset" ;;
  esac
done

# The wrapper the launcher names must exist and be executable, or every Claude
# lane fails at exec with the binding pointing at nothing.
[[ -x "$REPO_ROOT/bin/agent-lane-zsh" ]] ||
  fail 'the wrapper named by the launcher is not executable'
pass 'the wrapper named by the launcher is executable'

# The runtime validates CLAUDE_CODE_SHELL by looking for a shell name in the
# path and rejects anything else, so a rename would silently disable every
# Claude lane. The launcher's own emitted path is checked, not just the file.
for lane in claude-bash claude-terminal; do
  shell_path="$(
    launch_line_for "$lane" | sed -n 's/.*CLAUDE_CODE_SHELL=\([^ ]*\).*/\1/p'
  )"
  case "$shell_path" in
    *zsh*|*bash*) pass "$lane: the emitted wrapper path carries a runtime-accepted shell name" ;;
    *) fail "$lane: the emitted wrapper path would be rejected by the runtime" ;;
  esac
done

# --- Literal task start -----------------------------------------------------
#
# LANE_START did not survive into Claude Bash, so the receipt read an empty
# --task-start and its ordering gate passed everything. The stamp is therefore
# embedded as a literal rather than referenced as a variable.
#
# Both commands must carry the SAME literal: the launch and the receipt describe
# one lane, and two different numbers would compare the snapshot against a
# moment the operator never asked for.
for lane in codex-command codex-terminal claude-bash claude-terminal; do
  lane_output="$("$LAUNCHER" "$lane")"

  launch_epoch="$(
    grep -v '^#' <<<"$lane_output" | grep -v '^$' | head -1 |
      sed -n 's/.*LANE_START=\([0-9][0-9]*\).*/\1/p'
  )"
  [[ "$launch_epoch" =~ ^[0-9]+$ ]] ||
    fail "$lane: the launch command carries no literal LANE_START"
  pass "$lane: the launch command carries a literal LANE_START"

  receipt_epoch="$(sed -n 's/^#[[:space:]]*--task-start \([0-9][0-9]*\).*/\1/p' <<<"$lane_output" | head -1)"
  [[ "$receipt_epoch" =~ ^[0-9]+$ ]] ||
    fail "$lane: the receipt command carries no literal task start"
  pass "$lane: the receipt command carries a literal task start"

  assert_equals "$receipt_epoch" "$launch_epoch" \
    "$lane: the launch and receipt commands agree on the task start"

  # A literal that is not a current time would make the ordering gate vacuous.
  now="$(date +%s)"
  if [[ "$launch_epoch" -lt $((now - 300)) || "$launch_epoch" -gt $((now + 300)) ]]; then
    fail "$lane: the literal task start is not a current timestamp"
  fi
  pass "$lane: the literal task start is a current timestamp"

  # The receipt must no longer depend on a variable that does not arrive.
  case "$lane_output" in
    *'--task-start "$LANE_START"'*)
      fail "$lane: the receipt still reads task start from the environment" ;;
    *) pass "$lane: the receipt does not depend on an inherited variable" ;;
  esac
done

# --- Paste safety -----------------------------------------------------------
#
# The printed receipt invocation is a line-continued command an operator pastes.
# A line ending in a doubled backslash escapes the backslash instead of the
# newline, so the command breaks at that point. This was a real defect in an
# earlier revision.
if grep -q '\\\\$' <<<"$all_output"; then
  fail 'a printed line ends with a doubled backslash and is not paste-safe'
fi
pass 'no printed line ends with a doubled backslash'

# A continuation must be followed by a real continuation line. A trailing
# backslash on the final line of a block would swallow whatever the operator
# typed next.
prev_continues=0
final_line_continues=0
while IFS= read -r line; do
  if [[ "$prev_continues" -eq 1 && -z "$line" ]]; then
    fail 'a continued command is followed by a blank line'
  fi
  if [[ "$line" == *'\' ]]; then
    prev_continues=1
    final_line_continues=1
  else
    prev_continues=0
    final_line_continues=0
  fi
done <<<"$all_output"
assert_equals "$final_line_continues" '0' 'the printed output does not end mid-continuation'

# --- Provenance -------------------------------------------------------------
#
# The receipt call must carry the binding, the ordering stamp, and the boundary.
# Dropping any one of them yields a receipt that still prints but no longer
# proves the repaired profile.
for required in '--zdotdir' '--task-start' '--boundary-epoch' '--product-version'; do
  grep -q -- "$required" <<<"$all_output" ||
    fail "the printed receipt call omits ${required}"
  pass "the printed receipt call carries ${required}"
done

# The boundary must be a resolved POSITIVE integer, not an unexpanded
# placeholder and not zero. Every real snapshot mtime is greater than zero, so
# a zero boundary satisfies a numeric check while making the receipt's
# admission gate vacuous for every possible input.
boundary="$(sed -n 's/^# Boundary: \([0-9][0-9]*\) .*/\1/p' <<<"$all_output" | head -1)"
[[ "$boundary" =~ ^[1-9][0-9]*$ ]] || fail 'the launcher did not resolve a positive repair boundary'
pass 'the launcher resolves a positive repair boundary'

# --- Fail closed without a repair boundary ----------------------------------
#
# An earlier revision substituted 0 when git produced no commit epoch, and a
# zero boundary admits every pre-repair snapshot while still reading as
# enforcement. The launcher must refuse instead: no printed command, a non-zero
# status, and a diagnostic it owns.
#
# The lane runs a COPY of the launcher from a temp directory that is not a git
# repository, which is the real way `git log` fails to produce a boundary. The
# committed launcher is never moved or edited.
no_git_dir="$TEST_ROOT/no-git/bin"
mkdir -p "$no_git_dir"
cp "$LAUNCHER" "$no_git_dir/agent-lane-launch"
chmod +x "$no_git_dir/agent-lane-launch"
no_git_err="$TEST_ROOT/no-git-stderr"
set +e
no_git_out="$("$no_git_dir/agent-lane-launch" 2>"$no_git_err")"
no_git_status=$?
set -e
[[ "$no_git_status" -ne 0 ]] ||
  fail 'without a repair boundary the launcher must exit non-zero'
pass 'without a repair boundary the launcher exits non-zero'

# Refusal means no command at all. A partial or zero-boundary command stream
# would still be pasted by an operator who did not check the exit status.
[[ -z "$no_git_out" ]] ||
  fail 'without a repair boundary the launcher still printed to stdout'
pass 'without a repair boundary no command is printed'

# The diagnostic must be the launcher's own and name the missing boundary, so
# the failure cannot be mistaken for git noise or a broken pipe.
grep -q '^agent-lane-launch: .*repair boundary' "$no_git_err" ||
  fail 'the no-boundary refusal does not carry a launcher-owned diagnostic'
pass 'the no-boundary refusal names the repair boundary in a launcher-owned diagnostic'

# The launch must not name a canonical startup file. The binding exists so that
# proving a worktree never requires editing the installed profile.
if grep -qE '(^|[^.])~/\.zshrc|\$HOME/\.zshrc' <<<"$all_output"; then
  fail 'the launcher references a canonical startup file'
fi
pass 'the launcher references no canonical startup file'

printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
