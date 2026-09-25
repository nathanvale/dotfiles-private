#!/usr/bin/env bash

# Startup silence and capability-safety contract.
#
# Proves that every supported zsh startup mode succeeds silently on a machine
# where the optional integrations are unavailable, and that repeated
# clean-environment calls receive the same baseline.
#
# The production consumer is an agent harness that starts a zsh child and
# captures both streams. It must receive the command's own output and nothing
# else, so a startup diagnostic is a defect even when the shell still exits zero.
#
# Every assertion reads a real /bin/zsh child under `env -i` with a hermetic
# HOME and ZDOTDIR holding copies of this repository's startup owners. Nothing
# here inspects startup file text.

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

# ---------------------------------------------------------------------------
# Genuine absence of the optional integrations.
# ---------------------------------------------------------------------------
#
# A minimal inbound PATH is NOT enough to make optional tools absent, and
# relying on it would make every silence row below pass vacuously on this
# machine. `.zshrc` prepends the Homebrew prefix to PATH unconditionally, so
# `atuin`, `direnv`, and `pyenv` are all still found however small the inbound
# PATH was.
#
# So absence is produced structurally: the startup owners are copied with the
# Homebrew prefix rewritten to an empty directory that exists but contains
# nothing. Every optional executable and every optional integration file then
# genuinely does not exist, which is the fresh-machine condition this contract
# is about. The rewrite is confined to the copies; the repository is untouched.
#
# This shape is macOS/Homebrew-specific. A startup path that hardcoded some
# other absolute prefix would not be covered, and that is stated as a remaining
# unproved boundary rather than implied to be safe.
fresh_prefix="$TEST_ROOT/empty-prefix"
mkdir -p "$fresh_prefix/bin"

fresh_home="$TEST_ROOT/fresh-home"
mkdir -p "$fresh_home"
for owner in .zshenv .zprofile .zshrc; do
  sed "s#/opt/homebrew#${fresh_prefix}#g" "$REPO_ROOT/$owner" >"$fresh_home/$owner" ||
    fail "could not stage hermetic copy of $owner"
done

# The rewrite is load-bearing, so prove it actually removed the tools rather
# than assuming it did. If any optional executable is still resolvable inside
# the child, the silence rows below would be testing a fully configured machine.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
absence_probe='
  for tool in atuin direnv pyenv; do
    if command -v -- "$tool" >/dev/null 2>&1; then
      print -r -- "present=$tool"
    fi
  done
  print -r -- "absence_probe_done"
'

# ---------------------------------------------------------------------------
# Mode runner.
# ---------------------------------------------------------------------------
#
# Sets probe_out, probe_status, and probe_err_bytes. Startup noise is captured to
# its own receipt file so an empty-stderr claim stays meaningful: stdout carries
# the probe's machine-readable channel, stderr carries startup diagnostics, and
# the two are never merged.
#
# Only the size of the stderr receipt is exposed, never its text, so asserting
# on startup noise can never reprint a value the receipts are meant to withhold.
#
# Set `probe_home` before calling to run against a different hermetic home.
run_mode() {
  local mode="$1" probe="$2"
  local -a flags
  case "$mode" in
    noninteractive-nonlogin) flags=(-c) ;;
    noninteractive-login)    flags=(-l -c) ;;
    interactive-nonlogin)    flags=(-i -c) ;;
    interactive-login)       flags=(-i -l -c) ;;
    *) fail "unknown startup mode: $mode" ;;
  esac

  # Create the receipt before launching the child. If redirection or child setup
  # fails, the file still exists and reads as empty, so the run continues to an
  # ordinary assertion failure instead of aborting the harness under `set -e`
  # with no TAP line emitted.
  local err_file="$TEST_ROOT/stderr.$mode"
  : >"$err_file" || fail "$mode: could not create stderr receipt"

  set +e
  probe_out="$(
    env -i \
      HOME="${probe_home:-$fresh_home}" \
      ZDOTDIR="${probe_home:-$fresh_home}" \
      PATH=/usr/bin:/bin \
      TERM=dumb \
      /bin/zsh "${flags[@]}" "$probe" 2>"$err_file"
  )"
  probe_status=$?
  set -e
  # Only the size is captured, never the text. A startup diagnostic can carry a
  # HOME path or an environment value, so the receipts stay a byte count.
  probe_err_bytes="$(wc -c <"$err_file" | tr -d ' ')"
}

all_modes=(noninteractive-nonlogin noninteractive-login interactive-nonlogin interactive-login)

# ---------------------------------------------------------------------------
# Negative control for the empty-stderr oracle.
# ---------------------------------------------------------------------------
#
# Without this, an oracle that never observed stderr at all would report every
# mode silent and every silence row would be vacuous. A probe that deliberately
# writes one byte to stderr must be seen as non-empty in the same harness, using
# the same receipt plumbing as the real rows.
run_mode noninteractive-nonlogin 'print -r -- noise >&2; print -r -- ok'
if [[ "$probe_err_bytes" -gt 0 ]]; then
  pass 'stderr oracle observes a deliberately noisy probe'
else
  fail 'stderr oracle reported a noisy probe as silent'
fi

# ---------------------------------------------------------------------------
# Absence precondition.
# ---------------------------------------------------------------------------
run_mode interactive-login "$absence_probe"
assert_equals "$(grep -c '^present=' <<<"$probe_out" || true)" '0' \
  'optional integrations are genuinely absent in the hermetic child'

# ---------------------------------------------------------------------------
# Criterion: all four startup modes succeed silently.
# ---------------------------------------------------------------------------
#
# Both halves are asserted per mode and named separately, so a regression
# reports whether the shell failed or merely became noisy.
#
# The stderr row reports a byte count, never the captured text. A startup
# diagnostic can carry a HOME path or an environment value, and reprinting it to
# prove it existed would recreate the disclosure that issue 48's contract
# refuses. The count is enough to fail the row and name the cause.
for mode in "${all_modes[@]}"; do
  run_mode "$mode" 'print -r -- startup_ok'
  assert_equals "$probe_status" '0' "$mode: startup exits zero with optional integrations absent"
  assert_equals "$(grep -c '^startup_ok$' <<<"$probe_out" || true)" '1' \
    "$mode: startup runs the requested command"
  assert_equals "$probe_err_bytes" '0' \
    "$mode: startup stderr is empty with optional integrations absent"

  # Startup must not contribute a status of its own.
  #
  # The row above cannot see this, because its probe ends with a successful
  # `print` that resets `$?`. Here the probe runs nothing of its own, so the
  # status is whatever startup left behind.
  #
  # zsh resets `$?` before running the `-c` command, so a startup file ending in
  # a false `guard && action` line does not currently leak. That is a property
  # of the shell rather than of this configuration, and every optional
  # integration here is exactly such a line, so the row is kept as a canary: it
  # catches a future startup addition that sets a status some other way, such as
  # a trap or an explicit non-zero return.
  run_mode "$mode" 'exit 0'
  assert_equals "$probe_status" '0' \
    "$mode: startup contributes no exit status of its own"

  # The complement: a real failure must still be reported. A startup that forced
  # success, for example with an exit trap, would pass the row above while
  # making every failed agent command look successful, which is a worse defect
  # than the one that row guards against.
  run_mode "$mode" 'exit 7'
  assert_equals "$probe_status" '7' \
    "$mode: the command's own failing status still reaches the caller"
done

# ---------------------------------------------------------------------------
# Criterion: prompt, completion, terminal control, and notices stay gated.
# ---------------------------------------------------------------------------
#
# The observable is what the started process did, not which lines exist. A
# harness-started interactive shell has no controlling terminal, so the terminal
# machinery must not have been installed and no terminal control byte may reach
# the captured stream.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
gating_probe='
  print -r -- "tty=$([[ -t 1 ]] && print yes || print no)"
  print -r -- "compdump=$(print -rl -- $HOME/.zcompdump*(N) | grep -c . )"
  print -r -- "pastewidget=${widgets[bracketed-paste]:-none}"
  print -r -- "sudowidget=${widgets[sudo-command-line]:-none}"
'

for mode in interactive-nonlogin interactive-login; do
  run_mode "$mode" "$gating_probe"
  assert_equals "$probe_status" '0' "$mode: gating probe exits zero"

  # Guards the rows below: if the harness ever gained a tty, "no widget" would
  # stop meaning "correctly gated" and start meaning "the feature is broken".
  assert_equals "$(grep '^tty=' <<<"$probe_out")" 'tty=no' \
    "$mode: harness-started interactive shell has no terminal"

  # Completion. compinit writes a dump file as a side effect, so its absence is
  # an independent filesystem observable rather than a re-reading of the config.
  assert_equals "$(grep '^compdump=' <<<"$probe_out")" 'compdump=0' \
    "$mode: completion is not initialized without a terminal"

  # Terminal control. `bracketed-paste` is a zsh built-in widget, so its mere
  # existence proves nothing; the observable is whether startup *replaced* it.
  # Unmodified it reports `builtin`, and startup's registration would make it
  # report `user:bracketed-paste-magic`.
  assert_equals "$(grep '^pastewidget=' <<<"$probe_out")" 'pastewidget=builtin' \
    "$mode: bracketed-paste widget is not replaced without a terminal"
  assert_equals "$(grep '^sudowidget=' <<<"$probe_out")" 'sudowidget=none' \
    "$mode: sudo-toggle widget is not registered without a terminal"

  # Notices and prompt escapes. The captured stdout must be exactly the probe's
  # own bytes, so anything startup itself emitted would show up here.
  run_mode "$mode" 'print -r -- only_this'
  assert_equals "$probe_out" 'only_this' \
    "$mode: startup writes no terminal control or notice bytes to stdout"

  # The prompt hook is invoked directly rather than waited for.
  #
  # `precmd` runs before each prompt, and a `-c` shell never draws one, so the
  # row above cannot reach it: leaving the terminal title ungated keeps that row
  # green. Calling the hook makes its output observable in the same captured
  # stream, so the title sequence and the colour-coded timing line are actually
  # under test. `timer` is seeded to a value far enough in the past to satisfy
  # the "took longer than a second" branch, so the timing line is reachable too.
  # The nested zsh evaluates these expressions.
  # shellcheck disable=SC2016
  run_mode "$mode" '
    if (( ${+functions[precmd]} )); then
      print -r -- "hook=present"
      timer=1
      precmd
    else
      print -r -- "hook=absent"
    fi
    print -r -- "hook_done"
  '
  assert_equals "$probe_status" '0' "$mode: prompt hook probe exits zero"

  # Guards the row below: if precmd were never defined, "emitted nothing" would
  # be true for the wrong reason.
  assert_equals "$(grep '^hook=' <<<"$probe_out")" 'hook=present' \
    "$mode: the prompt hook is defined and reachable"

  # The hook must contribute no bytes of its own to either stream.
  assert_equals "$probe_out" "$(printf 'hook=present\nhook_done')" \
    "$mode: the prompt hook emits no terminal control or timing bytes"
  assert_equals "$probe_err_bytes" '0' \
    "$mode: the prompt hook writes nothing to stderr"
done

# ---------------------------------------------------------------------------
# Criterion: repeated clean-environment calls receive the same baseline.
# ---------------------------------------------------------------------------
#
# Two claims, and they are different. The first is that repeating the identical
# clean call reproduces the same baseline. The second is stronger and is the one
# an agent depends on: feeding a call's own exported PATH back into the next
# call must still produce that same baseline, because a harness replays captured
# state rather than starting from nothing. A startup that appended unconditionally
# would drift here while passing the first claim.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
baseline_probe='print -r -- "PATHVALUE=$PATH"'

for mode in "${all_modes[@]}"; do
  run_mode "$mode" "$baseline_probe"
  assert_equals "$probe_status" '0' "$mode: baseline probe exits zero"
  first_path="$(grep '^PATHVALUE=' <<<"$probe_out" | sed 's/^PATHVALUE=//')"

  run_mode "$mode" "$baseline_probe"
  repeat_path="$(grep '^PATHVALUE=' <<<"$probe_out" | sed 's/^PATHVALUE=//')"
  assert_equals "$repeat_path" "$first_path" \
    "$mode: repeating a clean call reproduces the same baseline"

  # Feed the first call's own output back in, twice, so a per-generation append
  # has room to show up.
  generation_path="$first_path"
  for _generation in 1 2; do
    set +e
    generation_out="$(
      env -i HOME="$fresh_home" ZDOTDIR="$fresh_home" \
        PATH="$generation_path" TERM=dumb \
        /bin/zsh -c "$baseline_probe" 2>/dev/null
    )"
    set -e
    generation_path="$(grep '^PATHVALUE=' <<<"$generation_out" | sed 's/^PATHVALUE=//')"
  done
  assert_equals "$generation_path" "$first_path" \
    "$mode: replaying a call's own exported state reproduces the same baseline"
done

# Cache containment when ZDOTDIR is a source checkout.
#
# Every other lane in this file sets HOME and ZDOTDIR to the same hermetic
# directory, which is realistic for a normal login but hides an entire class of
# defect: with the two equal, a file written "next to the startup files" and a
# file written "into the user's home" are indistinguishable.
#
# They are not the same when an agent lane is bound with a process-scoped
# ZDOTDIR pointing at a source checkout, which is how the issue-54 lanes prove a
# worktree. `compinit` with no `-d` dumps to $ZDOTDIR/.zcompdump, so a bound
# lane deposited a 64KB cache directly into the repository. Startup must put its
# caches in writable private state and leave the checkout alone.
#
# The oracle is a full before/after listing of the ZDOTDIR, so any deposit is
# caught rather than only the one filename already observed.
zdot_dir="$TEST_ROOT/cache-zdotdir"
cache_home="$TEST_ROOT/cache-home"
mkdir -p "$zdot_dir" "$cache_home"
for owner in .zshenv .zprofile .zshrc; do
  cp "$REPO_ROOT/$owner" "$zdot_dir/$owner" ||
    fail "could not stage cache-containment copy of $owner"
done

zdot_before="$(find "$zdot_dir" -mindepth 1 | sort)"

# The probe runs ordinary startup and nothing else.
#
# An earlier version called `compinit -C` in the probe body. That was the probe
# writing its own dump with compinit's default path, so the row failed against a
# correct startup and would have passed against a broken one that never ran
# completion at all. The claim is about what STARTUP does, so the probe must add
# no completion call of its own.
cache_err="$TEST_ROOT/stderr.cache"
: >"$cache_err"
set +e
env -i \
  HOME="$cache_home" \
  ZDOTDIR="$zdot_dir" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  TERM=dumb \
  /bin/zsh -i -c 'print -r -- done' \
  >/dev/null 2>"$cache_err"
cache_status=$?
set -e

assert_equals "$cache_status" '0' 'cache containment: interactive startup exits zero'

zdot_after="$(find "$zdot_dir" -mindepth 1 | sort)"
if [[ "$zdot_after" != "$zdot_before" ]]; then
  # Report the fact and the count, never the hermetic paths themselves.
  fail "cache containment: startup deposited $(($(grep -c . <<<"$zdot_after") - $(grep -c . <<<"$zdot_before"))) file(s) into ZDOTDIR"
fi
pass 'cache containment: startup writes no file into ZDOTDIR'

# The complement. The row above is satisfied by a startup that abandoned
# completion entirely, so the configured location must also be shown to work.
#
# Completion is gated on a real terminal (`-t 1`), which this harness has no way
# to provide, so the rows below assert the CONFIGURATION startup publishes and
# then exercise it directly. That split is deliberate: the containment row above
# is the behavioural claim about startup, and these rows prove the value it
# would hand compinit is a private path that actually works.
#
# The child runs under `env -i`, so XDG_CACHE_HOME is unset and the documented
# fallback applies.
compdump_path="$(
  env -i \
    HOME="$cache_home" \
    ZDOTDIR="$zdot_dir" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    TERM=dumb \
    /bin/zsh -i -c 'print -r -- "${ZSH_COMPDUMP:-<unset>}"' 2>/dev/null | tail -1
)"

[[ "$compdump_path" != '<unset>' && -n "$compdump_path" ]] ||
  fail 'cache containment: startup publishes no completion dump path'
pass 'cache containment: startup publishes a completion dump path'

case "$compdump_path" in
  "$zdot_dir"/*) fail 'cache containment: the configured dump path is inside ZDOTDIR' ;;
  "$cache_home"/.cache/zsh/*) pass 'cache containment: the dump path is in the private cache directory' ;;
  *) fail 'cache containment: the dump path is neither the private cache nor a recognised location' ;;
esac

# Writable in practice, not merely well-named: the parent must already exist,
# because compinit does not create it and a missing directory would silently
# lose the cache on a fresh machine.
[[ -d "$(dirname "$compdump_path")" ]] ||
  fail 'cache containment: the dump directory was not created by startup'
pass 'cache containment: the dump directory exists and is ready for compinit'

# The override must be honoured, or a machine that sets XDG_CACHE_HOME would
# still write to the fallback and the contract above would describe a path the
# implementation only reaches by accident.
xdg_cache="$TEST_ROOT/xdg-cache"
mkdir -p "$xdg_cache"
xdg_compdump_path="$(
  env -i \
    HOME="$cache_home" \
    ZDOTDIR="$zdot_dir" \
    XDG_CACHE_HOME="$xdg_cache" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    TERM=dumb \
    /bin/zsh -i -c 'print -r -- "${ZSH_COMPDUMP:-<unset>}"' 2>/dev/null | tail -1
)"
case "$xdg_compdump_path" in
  "$xdg_cache"/zsh/*) pass 'cache containment: XDG_CACHE_HOME is honoured for the dump path' ;;
  *) fail 'cache containment: XDG_CACHE_HOME was not honoured for the dump path' ;;
esac

# compinit must actually accept the published path. Asserting the string alone
# would not catch a path that is unwritable or malformed.
set +e
env -i \
  HOME="$cache_home" \
  ZDOTDIR="$zdot_dir" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  TERM=dumb \
  /bin/zsh -i -c 'autoload -U compinit && compinit -d "$ZSH_COMPDUMP"' >/dev/null 2>&1
compinit_status=$?
set -e
assert_equals "$compinit_status" '0' 'cache containment: compinit accepts the published dump path'

written="$(find "$cache_home/.cache/zsh" -name 'zcompdump*' 2>/dev/null | grep -c . || true)"
[[ "$written" -ge 1 ]] ||
  fail 'cache containment: compinit wrote no dump at the published path'
pass 'cache containment: compinit writes its dump at the published path'

# And doing so still left the checkout alone.
zdot_final="$(find "$zdot_dir" -mindepth 1 | sort)"
assert_equals "$zdot_final" "$zdot_before" \
  'cache containment: a real compinit run deposits nothing into ZDOTDIR'

# ---------------------------------------------------------------------------
# refresh-completions refuses to run without a dump path.
# ---------------------------------------------------------------------------
#
# The function clears the stale dumps with a trailing glob, `"$ZSH_COMPDUMP"*`.
# That expression is only safe while the variable holds a path. Empty or unset,
# it collapses to a bare `*`, and the deletion lands on every file in whatever
# directory the caller happened to be standing in. A refresh of a cache must
# never be able to erase a working tree, so the function has to fail closed
# instead of guessing.
#
# The oracle is the surviving directory listing, not the exit status alone: a
# guard that returns nonzero after already deleting would still pass a
# status-only check.
# Contract: .zshrc refresh-completions
guard_dir="$TEST_ROOT/refresh-guard"
guard_home="$TEST_ROOT/refresh-guard-home"
mkdir -p "$guard_dir" "$guard_home"

# Sentinels stand in for a checkout. The dotfile is included because `rm -f *`
# spares it under default globbing, so a listing of only visible files could
# report a false survival.
for sentinel in keep-one.txt keep-two.txt .keep-hidden; do
  : >"$guard_dir/$sentinel"
done
guard_before="$(find "$guard_dir" -mindepth 1 | sort)"

# Empty and unset are separate failure modes: `${ZSH_COMPDUMP}` set to '' and
# never assigned reach the glob by different routes, and a guard written with
# the wrong test catches only one of them.
for guard_case in empty unset; do
  case "$guard_case" in
    empty) guard_setup="ZSH_COMPDUMP=''" ;;
    unset) guard_setup='unset ZSH_COMPDUMP' ;;
  esac

  # The directory is passed through the child's argv rather than spliced into
  # the script text, so no quoting of the hermetic path is required.
  set +e
  env -i \
    HOME="$guard_home" \
    ZDOTDIR="$zdot_dir" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    TERM=dumb \
    /bin/zsh -i -c "cd -- \"\$1\" && ${guard_setup} && refresh-completions" \
    guard-probe "$guard_dir" \
    >/dev/null 2>&1
  guard_status=$?
  set -e

  [[ "$guard_status" -ne 0 ]] ||
    fail "refresh guard: refresh-completions returned 0 with a $guard_case dump path"
  pass "refresh guard: refresh-completions refuses a $guard_case dump path"

  guard_after="$(find "$guard_dir" -mindepth 1 | sort)"
  if [[ "$guard_after" != "$guard_before" ]]; then
    # Name the loss, never the hermetic paths.
    fail "refresh guard: a $guard_case dump path destroyed $(($(grep -c . <<<"$guard_before") - $(grep -c . <<<"$guard_after"))) file(s) in the working directory"
  fi
  pass "refresh guard: a $guard_case dump path leaves the working directory intact"
done

# The complement. Every row above is satisfied by a function that refuses
# unconditionally, so the working path must still be shown to refresh a dump.
guard_ok_home="$TEST_ROOT/refresh-ok-home"
mkdir -p "$guard_ok_home"
set +e
guard_ok_output="$(
  env -i \
    HOME="$guard_ok_home" \
    ZDOTDIR="$zdot_dir" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    TERM=dumb \
    /bin/zsh -i -c 'refresh-completions' 2>&1
)"
guard_ok_status=$?
set -e
assert_equals "$guard_ok_status" '0' \
  'refresh guard: refresh-completions still succeeds with a configured dump path'

# Silence is part of the same contract the startup rows above assert: the agent
# harness captures both streams and a diagnostic is a defect even at exit zero.
[[ -z "$guard_ok_output" ]] ||
  fail 'refresh guard: refresh-completions wrote to a stream on the successful path'
pass 'refresh guard: refresh-completions is silent on the successful path'

guard_ok_written="$(find "$guard_ok_home/.cache/zsh" -name 'zcompdump*' 2>/dev/null | grep -c . || true)"
[[ "$guard_ok_written" -ge 1 ]] ||
  fail 'refresh guard: the successful path wrote no dump'
pass 'refresh guard: the successful path writes its dump at the configured location'

# Receipts name behavior only. No captured stream body, environment value, or
# hermetic HOME path is printed.
printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
