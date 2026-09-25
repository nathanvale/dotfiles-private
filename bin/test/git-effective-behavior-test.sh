#!/usr/bin/env bash

# Effective Git CLI behavior contract.
#
# Proves what the real `git` executable actually does under this repository's
# own .gitconfig, not what that file says. Every assertion runs a real `git`
# child under `env -i`, a hermetic temporary HOME holding a copy of this
# repository's Git owners, GIT_CONFIG_NOSYSTEM=1 so system configuration is
# disabled, and a minimal PATH.
#
# `env -i` is load-bearing, not stylistic. GIT_EDITOR, EDITOR, and VISUAL
# outrank core.editor, so an inherited GIT_EDITOR would satisfy the editor
# assertions without the configuration under test doing anything at all.
#
# Two lanes, because several Git behaviors are terminal-conditional:
#   unattended  - stdout and stdin are pipes, as in an agent harness.
#   terminal    - a real PTY, as for a human. Skipped when python3 is absent.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# Counts every emitted TAP line, passes and skips alike, so the plan matches the
# stream. A skip is reported as a skip and never described as a pass.
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

# Substring tests use `case` with a quoted pattern so the needle is matched
# literally. A `[[ $h == *"$n"* ]]` form treats an unquoted bracket in the
# needle as a glob character class, which silently never matches an escape
# sequence such as ESC-[ and would report colour as absent.
contains() {
  local haystack="$1" needle="$2"
  case "$haystack" in
    *"$needle"*) return 0 ;;
    *) return 1 ;;
  esac
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  contains "$haystack" "$needle" || fail "$label (missing the expected text)"
  pass "$label"
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  ! contains "$haystack" "$needle" || fail "$label (unexpectedly present)"
  pass "$label"
}

# Negative control for the substring oracle. Without this, a matcher that
# silently never matched would make every `assert_contains` on an escape
# sequence fail and every `assert_not_contains` pass vacuously.
if contains "plain text" $'\033['; then
  fail 'substring oracle reported an escape sequence in plain text'
fi
if ! contains "colour $(printf '\033')[31mhere" $'\033['; then
  fail 'substring oracle failed to detect a real escape sequence'
fi
pass 'oracle: substring matcher detects escape sequences literally'

# Hermetic home carrying this repository's Git owners.
home="$TEST_ROOT/home"
mkdir -p "$home"
cp "$REPO_ROOT/.gitconfig" "$home/.gitconfig"
cp "$REPO_ROOT/.gitignore_global" "$home/.gitignore_global"
cp "$REPO_ROOT/.gitmessage" "$home/.gitmessage"

# Identity is supplied per-invocation rather than written into the copied
# config, so these assertions never depend on Nathan's real identity and no
# personal value is printed in a receipt.
git_env=(
  env -i
  HOME="$home"
  PATH="/usr/bin:/bin"
  TERM=xterm
  GIT_CONFIG_NOSYSTEM=1
  GIT_AUTHOR_NAME=contract
  GIT_AUTHOR_EMAIL=contract@example.invalid
  GIT_COMMITTER_NAME=contract
  GIT_COMMITTER_EMAIL=contract@example.invalid
  GIT_AUTHOR_DATE='2001-02-03T04:05:06+00:00'
  GIT_COMMITTER_DATE='2001-02-03T04:05:06+00:00'
)

# A control lane that reads no global configuration at all. Expected values for
# the machine-output assertions are derived from this run rather than copied
# from Git's documentation, so the oracle stays correct across Git versions and
# is never computed by the configuration under test.
control_env=("${git_env[@]}" GIT_CONFIG_GLOBAL=/dev/null)

work="$TEST_ROOT/repo"
mkdir -p "$work"
"${git_env[@]}" git init -q "$work"

# The pager only engages when output exceeds one screen, so the fixture carries
# enough history to overflow a default terminal.
for i in $(seq 1 40); do
  printf '%s\n' "$i" >"$work/file.txt"
  "${git_env[@]}" git -C "$work" add file.txt
  "${git_env[@]}" git -C "$work" commit -q -m "commit $i"
done
head_sha="$("${git_env[@]}" git -C "$work" rev-parse HEAD)"

# Spy programs. Each writes a receipt FILE when executed, so the observable is
# that Git actually spawned the process. A receipt survives a swallowed or
# paged stream, which a stderr marker does not.
editor_receipt="$TEST_ROOT/editor-ran"
pager_receipt="$TEST_ROOT/pager-ran"

cat >"$TEST_ROOT/editor-spy" <<EOF
#!/bin/sh
echo ran >"$editor_receipt"
echo "EDITED_BY_SPY" >"\$1"
EOF

cat >"$TEST_ROOT/pager-spy" <<EOF
#!/bin/sh
echo ran >"$pager_receipt"
exec cat
EOF

chmod +x "$TEST_ROOT/editor-spy" "$TEST_ROOT/pager-spy"

# --------------------------------------------------------------------------
# Autocorrect: a misspelled subcommand must fail without executing or asking.
# --------------------------------------------------------------------------

# Feeding a line that would confirm a prompt. If Git ever consumes it, the
# canary below reports the read; a correction that executed would exit zero.
set +e
autocorrect_out="$(printf 'y\n' | "${git_env[@]}" git -C "$work" statu 2>&1)"
autocorrect_status=$?
set -e

[[ "$autocorrect_status" -ne 0 ]] ||
  fail 'unattended: misspelled subcommand must exit nonzero'
pass 'unattended: misspelled subcommand exits nonzero'

assert_not_contains "$autocorrect_out" 'On branch' \
  'unattended: misspelled subcommand does not execute the correction'
assert_not_contains "$autocorrect_out" 'nothing to commit' \
  'unattended: misspelled subcommand produces no corrected command output'

# help.autocorrect must be a non-executing, non-prompting value. Negative and
# `prompt` values are the ones that run or ask; 0 only ever suggests.
autocorrect_value="$("${git_env[@]}" git -C "$work" config --get help.autocorrect || true)"
assert_equals "$autocorrect_value" '0' \
  'configuration: help.autocorrect is the non-executing, non-prompting value'

# The suggestion itself is a human affordance and is expected to remain.
assert_contains "$autocorrect_out" 'is not a git command' \
  'unattended: misspelled subcommand still explains itself'

# --------------------------------------------------------------------------
# Machine output: an explicit format request must not be rewritten.
# --------------------------------------------------------------------------

explicit_oneline="$("${git_env[@]}" git -C "$work" log -1 --pretty=oneline)"
control_oneline="$("${control_env[@]}" git -C "$work" log -1 --pretty=oneline)"

assert_equals "$explicit_oneline" "$control_oneline" \
  'machine: --pretty=oneline matches Git default output'
assert_contains "$explicit_oneline" "$head_sha" \
  'machine: --pretty=oneline emits the full unabbreviated commit id'
assert_not_contains "$explicit_oneline" 'HEAD ->' \
  'machine: --pretty=oneline carries no ref decoration'

explicit_format="$("${git_env[@]}" git -C "$work" log -1 --pretty=format:'%H')"
assert_equals "$explicit_format" "$head_sha" \
  'machine: explicit --pretty=format is honored exactly'

# A [log].date default rewrites the *rendering* of an explicit %ad request
# rather than the placeholder itself, so a format that is honored verbatim can
# still emit "24 years ago" where the caller asked for a date. The expected
# value is the control lane's own output, so this row tracks whatever absolute
# format the installed Git defaults to instead of hard-coding one.
explicit_date="$("${git_env[@]}" git -C "$work" log -1 --pretty=format:'%ad')"
control_date="$("${control_env[@]}" git -C "$work" log -1 --pretty=format:'%ad')"
assert_equals "$explicit_date" "$control_date" \
  'machine: explicit %ad matches Git default absolute date, not a [log].date rewrite'
assert_not_contains "$explicit_date" 'ago' \
  'machine: explicit %ad emits no relative time'

# --porcelain is the documented stable status contract.
printf 'untracked\n' >"$work/untracked.txt"
status_out="$("${git_env[@]}" git -C "$work" status --porcelain)"
control_status="$("${control_env[@]}" git -C "$work" status --porcelain)"
assert_equals "$status_out" "$control_status" \
  'machine: status --porcelain matches Git default output'
rm -f "$work/untracked.txt"

# Colour must not be forced into a captured (non-terminal) stream.
assert_not_contains "$explicit_oneline" $'\033[' \
  'machine: captured output carries no colour escape'
assert_not_contains "$status_out" $'\033[' \
  'machine: captured status carries no colour escape'

# --------------------------------------------------------------------------
# Unattended: no editor may be spawned, and no stdin consumed.
# --------------------------------------------------------------------------

# This exercises the *configured* editor. Passing `-c core.editor=<spy>` would
# override the very setting under test and prove only that the spy ran, so the
# spy is used below solely as a negative control for the receipt mechanism.
#
# Stdin carries a live line rather than /dev/null. A launched terminal editor
# reads it and blocks; a configured editor that declines returns immediately.
subject_before="$("${git_env[@]}" git -C "$work" log -1 --pretty=format:'%s')"
set +e
editor_out="$(printf 'junk\n' | "${git_env[@]}" git -C "$work" commit --amend 2>&1)"
editor_status=$?
set -e

[[ "$editor_status" -ne 0 ]] ||
  fail 'unattended: commit --amend without a message must not succeed silently'
pass 'unattended: commit --amend without a message exits nonzero'

assert_contains "$editor_out" 'Please supply the message using either -m or -F' \
  'unattended: Git reports the missing message instead of opening an editor'

# A launched full-screen editor floods the captured stream with terminal
# control sequences. Their absence is direct evidence none was drawn.
assert_not_contains "$editor_out" $'\033[' \
  'unattended: no editor painted terminal control sequences into output'

subject_after="$("${git_env[@]}" git -C "$work" log -1 --pretty=format:'%s')"
assert_equals "$subject_after" "$subject_before" \
  'unattended: the commit message is unchanged'

# Negative control for the editor receipt used above: prove the mechanism does
# fire when an editor really is launched, so its absence is meaningful.
rm -f "$editor_receipt"
set +e
"${git_env[@]}" git -C "$work" -c core.editor="$TEST_ROOT/editor-spy" \
  commit --amend --edit >/dev/null 2>&1
set -e
[[ -f "$editor_receipt" ]] ||
  fail 'control: an explicitly forced editor should have been observed running'
pass 'control: the editor observation mechanism detects a launched editor'

# Undo the control commit so later assertions read the original history.
"${git_env[@]}" git -C "$work" commit -q --amend -m "$subject_before"

# Stdin canary. A command that neither prompts nor corrects must leave the
# supplied line unread, so the following reader still sees it.
stdin_leftover="$(
  {
    printf 'CANARY_LINE\n'
  } | {
    "${git_env[@]}" git -C "$work" statu >/dev/null 2>&1 || true
    cat
  }
)"
assert_equals "$stdin_leftover" 'CANARY_LINE' \
  'unattended: misspelled subcommand consumes no stdin'

# --------------------------------------------------------------------------
# Portable global ignore.
# --------------------------------------------------------------------------

excludes_value="$(
  "${git_env[@]}" git -C "$work" config --get core.excludesfile || true
)"
assert_not_contains "$excludes_value" '/Users/' \
  'portability: core.excludesfile names no machine-specific absolute path'

# The path must resolve for real under this hermetic HOME, which a hard-coded
# home directory from another machine could not do.
mkdir -p "$work/.claude"
printf '{}\n' >"$work/.claude/settings.local.json"
printf 'local\n' >"$work/CLAUDE.local.md"
printf 'junk\n' >"$work/debug.log"
# A nested copy is what the leading `**/` is for. A bare
# `.claude/settings.local.json` rule anchors to the repository root and would
# leave this one tracked, so the root-level fixture above cannot tell the two
# spellings apart on its own.
mkdir -p "$work/nested/deep/.claude"
printf '{}\n' >"$work/nested/deep/.claude/settings.local.json"
# `--untracked-files=all` is required, not cosmetic. Default `--porcelain`
# collapses a wholly untracked directory to a single `?? nested/` line, which
# names neither the file nor its parents, so a nested leak would hide behind
# the collapsed entry and this row would pass on the anchored rule too.
ignore_status="$("${git_env[@]}" git -C "$work" status --porcelain --untracked-files=all)"
assert_not_contains "$ignore_status" 'settings.local.json' \
  'portability: global ignore resolves and ignores Claude local settings'
assert_not_contains "$ignore_status" 'nested/' \
  'portability: the **/ prefix ignores Claude local settings at any depth'
assert_not_contains "$ignore_status" 'CLAUDE.local.md' \
  'portability: global ignore resolves and ignores CLAUDE.local.md'
assert_not_contains "$ignore_status" 'debug.log' \
  'portability: global ignore resolves and ignores log files'
rm -rf "$work/.claude" "$work/CLAUDE.local.md" "$work/debug.log" "$work/nested"

# --------------------------------------------------------------------------
# Human presentation survives as an explicit alias.
# --------------------------------------------------------------------------

# The presentation removed from [format].pretty and [log] defaults must still be
# reachable by name, so agent safety cost the human nothing.
#
# Subject and relative time alone are a weak oracle: `git log -1 HEAD` with the
# alias's --pretty stripped still prints both, so those two rows pass on an
# alias that lost the format it explicitly asked for. The abbreviated id and
# the ref decoration come from the `%h` and `%d` placeholders in that format
# (`--abbrev-commit --decorate` only select the decoration *style*), so these
# rows are what notice the format going missing. The short id is derived from
# Git under the control lane rather than sliced to a fixed width, so
# core.abbrev and Git's own length growth cannot make this row lie.
short_head="$("${control_env[@]}" git -C "$work" rev-parse --short HEAD)"
alias_out="$("${git_env[@]}" git -C "$work" last 2>&1)"
assert_contains "$alias_out" 'commit 40' \
  'human: the log alias still renders the latest subject'
assert_contains "$alias_out" 'ago' \
  'human: the log alias still renders relative time'
assert_contains "$alias_out" "$short_head" \
  'human: the log alias still renders the abbreviated commit id'
assert_not_contains "$alias_out" "$head_sha" \
  'human: the log alias abbreviates rather than printing the full commit id'
assert_contains "$alias_out" 'HEAD ->' \
  'human: the log alias still renders its requested ref decoration'

# --------------------------------------------------------------------------
# Terminal lane. Human presentation must survive the agent-safety changes.
# --------------------------------------------------------------------------

if command -v python3 >/dev/null 2>&1; then
  # Named ptyrun.py, never pty.py: a module named pty.py shadows the stdlib
  # module it imports and the helper fails with a circular-import error.
  ptyrun="$TEST_ROOT/ptyrun.py"
  cat >"$ptyrun" <<'PY'
import os, pty, select, sys

argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

captured = b""
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 30)
    except OSError:
        break
    if not ready:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    captured += chunk

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
sys.stdout.buffer.flush()
sys.exit(os.waitstatus_to_exitcode(status))
PY

  run_on_tty() {
    "${git_env[@]}" "$@" python3 "$ptyrun" git -C "$work" "${tty_args[@]}"
  }

  # Sanity: the helper really does hand the child a terminal. Without this,
  # every terminal-lane assertion below could pass vacuously on a pipe.
  tty_check="$(python3 "$ptyrun" sh -c 'test -t 1 && echo TTY' 2>/dev/null || true)"
  assert_contains "$tty_check" 'TTY' \
    'terminal lane: helper supplies a real terminal'

  # Human paging remains available automatically.
  rm -f "$pager_receipt"
  tty_args=(log)
  run_on_tty GIT_PAGER="$TEST_ROOT/pager-spy" >/dev/null 2>&1 || true
  [[ -f "$pager_receipt" ]] ||
    fail 'terminal: git log must still page automatically for a human'
  pass 'terminal: git log still pages automatically for a human'

  # Human colour remains available automatically. The worktree must be dirty:
  # a clean `git status` has nothing to colourise and would pass vacuously.
  printf 'colour fixture\n' >"$work/colour-probe.txt"
  tty_args=(status)
  status_colour="$(run_on_tty GIT_PAGER=cat 2>/dev/null || true)"
  assert_contains "$status_colour" 'colour-probe.txt' \
    'terminal: human status reports the dirty worktree it must colourise'
  assert_contains "$status_colour" $'\033[' \
    'terminal: human status output keeps colour'
  rm -f "$work/colour-probe.txt"

  # Autocorrect must not prompt or execute even with a terminal attached, which
  # is the lane where `help.autocorrect = prompt` would read stdin and run.
  tty_args=(statu)
  set +e
  tty_autocorrect="$(run_on_tty GIT_PAGER=cat 2>&1)"
  tty_autocorrect_status=$?
  set -e
  [[ "$tty_autocorrect_status" -ne 0 ]] ||
    fail 'terminal: misspelled subcommand must exit nonzero'
  pass 'terminal: misspelled subcommand exits nonzero'
  assert_not_contains "$tty_autocorrect" 'On branch' \
    'terminal: misspelled subcommand does not execute the correction'
  assert_not_contains "$tty_autocorrect" 'Continue' \
    'terminal: misspelled subcommand issues no prompt'
else
  skip 'terminal lane: python3 is unavailable, so no terminal could be attached'
fi

# Receipts name behavior only. No identity, credential, or environment value is
# printed.
printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
