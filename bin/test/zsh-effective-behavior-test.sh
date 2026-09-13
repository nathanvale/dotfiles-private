#!/usr/bin/env bash

# Effective zsh behavior contract.
#
# Proves what a zsh process actually does after startup, not what a startup file
# says. Every assertion reads a real /bin/zsh child launched under a hermetic
# temporary HOME and ZDOTDIR holding copies of this repository's own startup
# owners, with a minimal PATH so optional integrations are genuinely absent.
#
# Optional snapshot replay lane:
#   ZSH_CONTRACT_SNAPSHOT=/path/to/snapshot-zsh-*.sh bin/test/zsh-effective-behavior-test.sh
# The path is supplied at run time. A mutable snapshot path is never committed.

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
  # A failure ends the stream early, so tell the TAP consumer the run stopped
  # deliberately rather than truncating; the diagnostic above stays on stderr.
  printf 'Bail out! %s\n' "$1"
  exit 1
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

# Startup may legitimately print a diagnostic for a missing optional tool; that
# noise is another slice's concern. What this contract refuses is disclosure:
# no fixture sentinel, no snapshot body, and no HOME path may reach either stream.
#
# SNAPSHOT_CONTENT_MARKER carries the snapshot-body half of that claim. It stays
# empty outside the replay lane, so the four-mode matrix reads exactly as before.
#
# The detector is a silent predicate so it can be exercised by its own negative
# control below. It returns non-zero on disclosure and prints nothing either way,
# so proving it rejects a marker never reproduces the marker.
# Returns 0 when the text is clean, 1 when it carries a protected value.
stream_is_clean() {
  local stream="$1"
  local marker
  for marker in "$DISCLOSURE_SENTINEL" "$home" "${ZSH_CONTRACT_SNAPSHOT:-}" \
    "${SNAPSHOT_CONTENT_MARKER:-}"; do
    [[ -n "$marker" ]] || continue
    [[ "$stream" != *"$marker"* ]] || return 1
  done
  return 0
}

# Both streams carry the claim. stdout is the probe's machine-readable channel
# and stderr is the startup diagnostic channel; a protected value reaching
# either one is a disclosure, so each is asserted separately and named.
assert_no_disclosure() {
  local out_stream="$1" err_stream="$2" label="$3"
  # Report the fact of disclosure, never the disclosed text.
  stream_is_clean "$out_stream" || fail "$label (stdout disclosed a protected value)"
  stream_is_clean "$err_stream" || fail "$label (stderr disclosed a protected value)"
  pass "$label"
}

# A value that must never appear in any captured stream.
DISCLOSURE_SENTINEL='zsh-contract-secret-sentinel-do-not-print'

# Stands for the body of a replayed snapshot. Empty until the replay lane plants
# it inside the snapshot it replays, so the detector gains a snapshot-content
# marker only on the run that actually has a snapshot to protect.
SNAPSHOT_CONTENT_MARKER=''

# Hermetic home carrying this repository's startup owners.
home="$TEST_ROOT/home"
mkdir -p "$home"
cp "$REPO_ROOT/.zshenv" "$home/.zshenv"
cp "$REPO_ROOT/.zprofile" "$home/.zprofile"
cp "$REPO_ROOT/.zshrc" "$home/.zshrc"

# User-command lookup fixture. The two locations have different owners: the
# repository's managed command tree is reachable through HOME/bin, while native
# installers publish commands under HOME/.local/bin. Both must be available
# before any startup mode reaches a command lookup.
managed_home_command="$home/bin/managed-home-command"
managed_local_command="$home/.local/bin/managed-local-command"
mkdir -p "${managed_home_command%/*}" "${managed_local_command%/*}"
printf '#!/bin/sh\nexit 0\n' >"$managed_home_command"
printf '#!/bin/sh\nexit 0\n' >"$managed_local_command"
printf 'print -r -- sourced > "$HOME/.local/bin/contract-local-env-sourced"\n' \
  >"$home/.local/bin/env"
chmod 755 "$managed_home_command" "$managed_local_command"

# Priority fixture. All three owners publish the same command name so a lookup
# assertion observes ordering rather than only availability. The managed
# HOME/bin copy is the independent expected winner for interactive startup;
# the local and Bun copies are harmless lower-priority fallbacks.
priority_home_command="$home/bin/priority-probe"
priority_local_command="$home/.local/bin/priority-probe"
priority_bun_command="$home/.bun/bin/priority-probe"
mkdir -p "${priority_bun_command%/*}"
printf '#!/bin/sh\nprintf managed-home\\n\n' >"$priority_home_command"
printf '#!/bin/sh\nprintf managed-local\\n\n' >"$priority_local_command"
printf '#!/bin/sh\nprintf bun-fallback\\n\n' >"$priority_bun_command"
chmod 755 "$priority_home_command" "$priority_local_command" "$priority_bun_command"

# Account-switch ownership fixture. The non-secret env file is the only startup
# input allowed to set this value. A separate secret-file marker proves the
# startup owners do not read the retired secret route while preserving the
# sourced value through the complete shell process.
account_switch_dir="$home/.config/lll-account-switch"
account_switch_env="$account_switch_dir/env"
account_switch_secret="$account_switch_dir/secrets.env"
mkdir -p "$account_switch_dir"
printf 'export LLL_ACCOUNT_SWITCH_KNOWN_REPOS="/synthetic/repo-one:/synthetic/repo-two"\n' \
  >"$account_switch_env"
printf 'print -r -- sourced > "$HOME/.config/lll-account-switch/secret-read-marker"\n' \
  >"$account_switch_secret"

# Negative control for the disclosure detector.
#
# Without this, a detector that silently matched nothing would report every
# stream clean and the disclosure assertions would be vacuous. Each case feeds
# the predicate a stream that must be rejected, and reads only its exit status,
# so a protected value is never printed to prove that it is caught.
assert_detector_rejects() {
  local stream="$1" label="$2"
  if stream_is_clean "$stream"; then
    fail "$label (detector accepted a stream carrying a protected value)"
  fi
  pass "$label"
}

assert_detector_rejects \
  "startup noise ${DISCLOSURE_SENTINEL} more noise" \
  'disclosure detector rejects the fixture sentinel'

assert_detector_rejects \
  "cannot read ${home}/.config/example" \
  'disclosure detector rejects the hermetic HOME path'

if stream_is_clean 'ordinary diagnostic: optional tool not found'; then
  pass 'disclosure detector accepts a clean stream'
else
  fail 'disclosure detector rejected a clean stream'
fi

# Glob fixture: exactly one visible entry and one hidden entry.
work="$TEST_ROOT/work"
mkdir -p "$work"
: >"$work/visible.txt"
: >"$work/.hidden"

# Navigation fixture: a CDPATH trap.
#
# `trap_parent/target` exists, and the probe runs `cd target` from a *different*
# directory that has no `target` child. Conventionally that must fail. It can
# only succeed if some ambient directory search path carries trap_parent, so the
# oracle is a filesystem fact rather than a re-reading of the startup files.
#
# The probe also creates a `target` under its own cwd in a second case, proving
# the relative form still resolves normally when the child genuinely exists.
nav_trap_parent="$TEST_ROOT/nav/trap_parent"
nav_elsewhere="$TEST_ROOT/nav/elsewhere"
mkdir -p "$nav_trap_parent/target"
mkdir -p "$nav_elsewhere/present"

# Writable temporary root the probe's PATH is seeded with. Pinned explicitly so
# the assertion is about a genuine temp component and never about the hermetic
# HOME, which mktemp also places under a temporary root on macOS.
tmp_root="$TEST_ROOT/tmpdir"
mkdir -p "$tmp_root/evil"

# PATH seeded with exactly the components an agent must not trust: an empty
# entry, a bare current-directory entry, a `./`-prefixed current-directory
# entry, another relative entry, a duplicate, and two writable temporary
# directories. Startup must drop all of them and keep order.
#
# `.` and `./bin` are listed alongside `relative/bin` deliberately. A filter that
# only rejected non-absolute entries would catch all three, so the current
# directory would be excluded only as a side effect of a broader rule. Keeping
# all three seeded means the current-directory rows stay meaningful if that
# broader rule is ever narrowed.
hazard_path=":/usr/bin:.:./bin:relative/bin:/bin:/usr/bin:$tmp_root/evil:/tmp/contract-evil"

# Run one probe in a real zsh child for a named startup mode.
# Startup noise is captured separately so an empty-stderr claim stays meaningful.
# Usage: run_mode <mode> <probe>; sets probe_out, probe_err, probe_status.
#
# The child's inbound PATH defaults to a minimal pair so optional integrations
# are genuinely absent. Set `seed_path` before calling to hand startup a PATH
# carrying deliberate hazards instead; the PATH rows use that lane.
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
      HOME="$home" \
      ZDOTDIR="$home" \
      PATH="${seed_path:-/usr/bin:/bin}" \
      TMPDIR="$tmp_root" \
      TERM=dumb \
      CONTRACT_WORK="$work" \
      CONTRACT_NAV_TRAP_PARENT="$nav_trap_parent" \
      CONTRACT_NAV_ELSEWHERE="$nav_elsewhere" \
      CONTRACT_TMP_ROOT="$tmp_root" \
      CONTRACT_SNAPSHOT="${ZSH_CONTRACT_SNAPSHOT:-}" \
      CONTRACT_REPLAY_SNAPSHOT="${replay_snapshot:-}" \
      CONTRACT_SECRET="$DISCLOSURE_SENTINEL" \
      /bin/zsh "${flags[@]}" "$probe" 2>"$err_file"
  )"
  probe_status=$?
  set -e
  probe_err="$(<"$err_file")"
}

# Probe emitting effective option state. Reads the running process, never a file.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
options_probe='
  print -r -- "extendedglob=$options[extendedglob]"
  print -r -- "nullglob=$options[nullglob]"
  print -r -- "globdots=$options[globdots]"
  print -r -- "nomatch=$options[nomatch]"
'

# Probe emitting effective argument and glob behavior.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
behavior_probe='
  args=(HEAD^)
  print -r -- "headcaret_argc=${#args[@]}"
  print -r -- "headcaret_first=${args[1]}"
  cd -- "$CONTRACT_WORK"
  matches=(*)
  print -r -- "wildcard=${matches[*]}"
'

# An unmatched glob must fail visibly. Run it as its own command so the
# observable is the child exit status, not a swallowed empty expansion.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
unmatched_probe='
  print -r -- "before"
  : nosuchprefix-*
  print -r -- "after"
'

# Probe emitting effective navigation behavior.
#
# Reads the ambient search state directly, then exercises the behavior that
# state would change. Both relative forms run from CONTRACT_NAV_ELSEWHERE, which
# has a `present` child and no `target` child, while CONTRACT_NAV_TRAP_PARENT
# has a `target` child. Conventionally `cd target` fails there and `cd present`
# succeeds, regardless of what any search path contains.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
navigation_probe='
  print -r -- "cdpath_entries=${#cdpath[@]}"
  print -r -- "cdpath_var=${CDPATH:-}"
  builtin cd -- "$CONTRACT_NAV_ELSEWHERE"
  if cd target 2>/dev/null; then
    print -r -- "relative_absent=resolved:$PWD"
  else
    print -r -- "relative_absent=failed"
  fi
  builtin cd -- "$CONTRACT_NAV_ELSEWHERE"
  if cd present 2>/dev/null; then
    print -r -- "relative_present=resolved"
  else
    print -r -- "relative_present=failed"
  fi
'

# Probe emitting effective command identity.
#
# `whence -w` reports how the running shell would resolve each name, so an alias
# or function introduced by startup shows up here. `cd` must stay the builtin;
# the rest must resolve to an external command. The resolved path for `say` is
# emitted separately so a repository helper shadowing it is visible.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
identity_probe='
  for name in cd ls cat mv less say; do
    print -r -- "identity_${name}=${$(whence -w -- $name)##*: }"
  done
  print -r -- "saypath=$(whence -p -- say 2>/dev/null)"
'

# Probe public command lookup and the effective count of each user-owned path.
# The nested zsh evaluates these expressions. The fixture paths are independent
# from this probe and asserted below by the outer harness.
# shellcheck disable=SC2016
command_lookup_probe='
  local_bin_count=0
  home_bin_count=0
  for entry in $path; do
    [[ "$entry" == "$HOME/.local/bin" ]] && local_bin_count=$((local_bin_count + 1))
    [[ "$entry" == "$HOME/bin" ]] && home_bin_count=$((home_bin_count + 1))
  done
  print -r -- "home_command=$(command -v managed-home-command 2>/dev/null)"
  print -r -- "local_command=$(command -v managed-local-command 2>/dev/null)"
  print -r -- "priority_command=$(command -v priority-probe 2>/dev/null)"
  print -r -- "home_bin_count=$home_bin_count"
  print -r -- "local_bin_count=$local_bin_count"
  print -r -- "local_env_sourced=$([[ -e "$HOME/.local/bin/contract-local-env-sourced" ]] && print yes || print no)"
  print -r -- "known_repos=${LLL_ACCOUNT_SWITCH_KNOWN_REPOS:-}"
  print -r -- "secret_read=$([[ -e "$HOME/.config/lll-account-switch/secret-read-marker" ]] && print yes || print no)"
'

# Probe emitting the effective executable search path, one entry per line.
# The nested zsh evaluates these expressions.
# shellcheck disable=SC2016
path_probe='
  print -r -- "pathcount=${#path[@]}"
  for entry in $path; do
    print -r -- "pathentry=$entry"
  done
'

# All four effective startup modes are required by issue 48, but they carry
# different weight. .zshrc is read only by an interactive shell, so the two
# interactive modes are load-bearing for the glob repair: they are the rows that
# go RED if the removed `setopt` lines return. The two noninteractive modes are
# baseline canaries; they prove the same options stay off on a path that never
# reads .zshrc at all, so a later regression introduced in .zshenv or .zprofile
# is caught rather than attributed to the interactive file.
for mode in noninteractive-nonlogin noninteractive-login interactive-nonlogin interactive-login; do
  run_mode "$mode" "$options_probe"
  assert_equals "$probe_status" '0' "$mode: startup exits zero"
  # Scope note: general startup silence and optional-tool absence belong to a
  # separate slice. This contract only claims that startup output discloses no
  # environment value or snapshot content, which is issue 48's own criterion.
  assert_no_disclosure "$probe_out" "$probe_err" "$mode: startup output discloses no value"
  assert_equals "$(grep '^extendedglob=' <<<"$probe_out")" 'extendedglob=off' "$mode: EXTENDED_GLOB is off"
  assert_equals "$(grep '^nullglob=' <<<"$probe_out")" 'nullglob=off' "$mode: NULL_GLOB is off"
  assert_equals "$(grep '^globdots=' <<<"$probe_out")" 'globdots=off' "$mode: GLOB_DOTS is off"
  assert_equals "$(grep '^nomatch=' <<<"$probe_out")" 'nomatch=on' "$mode: default NOMATCH stays on"

  run_mode "$mode" "$behavior_probe"
  assert_equals "$probe_status" '0' "$mode: behavior probe exits zero"
  assert_equals "$(grep '^headcaret_argc=' <<<"$probe_out")" 'headcaret_argc=1' "$mode: unquoted HEAD^ stays one argument"
  assert_equals "$(grep '^headcaret_first=' <<<"$probe_out")" 'headcaret_first=HEAD^' "$mode: unquoted HEAD^ keeps its literal value"
  assert_equals "$(grep '^wildcard=' <<<"$probe_out")" 'wildcard=visible.txt' "$mode: ordinary wildcard excludes hidden files"

  run_mode "$mode" "$unmatched_probe"
  [[ "$probe_status" -ne 0 ]] || fail "$mode: unmatched glob must fail visibly"
  pass "$mode: unmatched glob fails visibly"
  assert_equals "$(grep -c '^after$' <<<"$probe_out" || true)" '0' "$mode: unmatched glob stops the command"

  # Navigation. The two relative rows are the behavioral claim; the two cdpath
  # rows name the ambient state that would produce the wrong behavior, so a
  # regression reports its cause rather than only its symptom.
  run_mode "$mode" "$navigation_probe"
  assert_equals "$probe_status" '0' "$mode: navigation probe exits zero"
  assert_equals "$(grep '^cdpath_entries=' <<<"$probe_out")" 'cdpath_entries=0' "$mode: no ambient directory search entries"
  assert_equals "$(grep '^cdpath_var=' <<<"$probe_out")" 'cdpath_var=' "$mode: CDPATH is unset or empty"
  assert_equals "$(grep '^relative_absent=' <<<"$probe_out")" 'relative_absent=failed' "$mode: relative cd does not resolve through a search path"
  assert_equals "$(grep '^relative_present=' <<<"$probe_out")" 'relative_present=resolved' "$mode: relative cd still resolves a real child"

  # Command identity. Aliases exist only in interactive shells, so the
  # interactive modes are the load-bearing rows here; the noninteractive modes
  # are canaries proving .zshenv and .zprofile introduce no replacement either.
  run_mode "$mode" "$identity_probe"
  assert_equals "$probe_status" '0' "$mode: identity probe exits zero"
  assert_equals "$(grep '^identity_cd=' <<<"$probe_out")" 'identity_cd=builtin' "$mode: cd is the shell builtin"
  for std_name in ls cat mv less; do
    assert_equals "$(grep "^identity_${std_name}=" <<<"$probe_out")" "identity_${std_name}=command" "$mode: $std_name is a standard command"
  done

  # The platform speech command is proved only where the platform provides it.
  say_identity="$(grep '^identity_say=' <<<"$probe_out")"
  say_path="$(grep '^saypath=' <<<"$probe_out" | sed 's/^saypath=//')"
  if [[ -x /usr/bin/say ]]; then
    assert_equals "$say_identity" 'identity_say=command' "$mode: say is a standard command"
    assert_equals "$say_path" '/usr/bin/say' "$mode: say resolves to the platform implementation"
  else
    skip "$mode: say identity (no /usr/bin/say on this platform)"
    skip "$mode: say resolution (no /usr/bin/say on this platform)"
  fi

  run_mode "$mode" "$command_lookup_probe"
  assert_equals "$probe_status" '0' "$mode: user-command lookup exits zero"
  assert_equals "$(grep '^home_command=' <<<"$probe_out")" "home_command=$managed_home_command" \
    "$mode: managed HOME/bin command resolves through the shell PATH"
  assert_equals "$(grep '^local_command=' <<<"$probe_out")" "local_command=$managed_local_command" \
    "$mode: native HOME/.local/bin command resolves through the shell PATH"
  assert_equals "$(grep '^priority_command=' <<<"$probe_out")" "priority_command=$priority_home_command" \
    "$mode: managed HOME/bin wins over HOME/.local/bin and Bun fallback"
  assert_equals "$(grep '^home_bin_count=' <<<"$probe_out")" 'home_bin_count=1' \
    "$mode: HOME/bin is present once"
  assert_equals "$(grep '^local_bin_count=' <<<"$probe_out")" 'local_bin_count=1' \
    "$mode: HOME/.local/bin is present once"
  assert_equals "$(grep '^local_env_sourced=' <<<"$probe_out")" 'local_env_sourced=no' \
    "$mode: absent HOME/.local/bin/env is not sourced during startup"
  case "$mode" in
    interactive-nonlogin|interactive-login)
      assert_equals "$(grep '^known_repos=' <<<"$probe_out")" 'known_repos=/synthetic/repo-one:/synthetic/repo-two' \
        "$mode: sourced non-secret account-switch repos survive startup"
      assert_equals "$(grep '^secret_read=' <<<"$probe_out")" 'secret_read=no' \
        "$mode: account-switch secret file is not read during startup"
      ;;
  esac
done

# Effective executable search path.
#
# Runs in its own lane because it is the one claim that needs a deliberately
# hostile inbound PATH: startup is handed an empty entry, a bare `.`, a relative
# entry, a duplicate, and two writable temporary directories, and must return a
# path carrying none of them. Seeding matters because a clean inbound PATH would
# let a startup that does no filtering at all pass every row.
#
# Both interactive modes are asserted. .zshrc owns the sanitizer, and pyenv
# re-prepends its shims later in that same file, so the interactive rows are
# where a missing re-application would show up.
for mode in interactive-nonlogin interactive-login; do
  seed_path="$hazard_path"
  run_mode "$mode" "$path_probe"
  unset seed_path

  assert_equals "$probe_status" '0' "$mode: path probe exits zero"

  # Read with a loop rather than `mapfile`: macOS ships bash 3.2, which has no
  # `mapfile` and no `${!array[@]}` on indexed arrays.
  path_entries=()
  while IFS= read -r path_line; do
    path_entries+=("$path_line")
  done < <(grep '^pathentry=' <<<"$probe_out" | sed 's/^pathentry=//')
  entry_count="$(grep '^pathcount=' <<<"$probe_out" | sed 's/^pathcount=//')"

  # A path that came back empty would satisfy every "contains no hazard" row
  # below without proving anything, so require a usable path first.
  [[ "$entry_count" -gt 0 ]] || fail "$mode: effective path is empty"
  pass "$mode: effective path is non-empty"

  # Under macOS bash 3.2 with nounset, expanding an empty array aborts the
  # harness with no TAP line, so the parsed entries must exist before any
  # "${path_entries[@]}" expansion. Independent of the pathcount row above:
  # that reads the probe's own counter, this reads what the harness parsed.
  [[ "${#path_entries[@]}" -gt 0 ]] || fail "$mode: no path entries were parsed from the probe"

  # The seeded hazards must be absent, each named separately so a failure
  # reports which class of unsafe entry survived.
  unsafe_empty=0 unsafe_cwd=0 unsafe_relative=0 unsafe_tmp=0
  for entry in "${path_entries[@]}"; do
    [[ -z "$entry" ]] && unsafe_empty=1
    [[ "$entry" == '.' || "$entry" == './'* ]] && unsafe_cwd=1
    [[ -n "$entry" && "$entry" != /* ]] && unsafe_relative=1
    case "$entry" in
      "$tmp_root"|"$tmp_root"/*|/tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/tmp|/var/tmp/*)
        unsafe_tmp=1 ;;
    esac
  done
  assert_equals "$unsafe_empty" '0' "$mode: effective path has no empty component"
  assert_equals "$unsafe_cwd" '0' "$mode: effective path has no current-directory component"
  assert_equals "$unsafe_relative" '0' "$mode: effective path has no relative component"
  assert_equals "$unsafe_tmp" '0' "$mode: effective path has no writable temporary component"

  # Deduplicated: the seeded PATH repeats /usr/bin, and startup prepends
  # /opt/homebrew/bin twice, so a survivor here is a real regression.
  duplicate_count="$(printf '%s\n' "${path_entries[@]}" | sort | uniq -d | grep -c . || true)"
  assert_equals "$duplicate_count" '0' "$mode: effective path is deduplicated"

  # Ordered: deduplication must keep the first occurrence of each entry rather
  # than reordering the path, because priority is what makes a path trustworthy.
  # /usr/bin was seeded before /bin, so it must still precede it.
  usr_bin_index=-1 bin_index=-1 index=0
  for entry in "${path_entries[@]}"; do
    [[ "$entry" == '/usr/bin' && "$usr_bin_index" -lt 0 ]] && usr_bin_index="$index"
    [[ "$entry" == '/bin' && "$bin_index" -lt 0 ]] && bin_index="$index"
    index=$((index + 1))
  done
  if [[ "$usr_bin_index" -ge 0 && "$bin_index" -ge 0 ]]; then
    [[ "$usr_bin_index" -lt "$bin_index" ]] || fail "$mode: effective path lost its seeded order"
    pass "$mode: effective path preserves first-occurrence order"
  else
    skip "$mode: path order (seeded reference entries absent)"
  fi
done

# Hostile incoming option state.
#
# Every row above starts a shell whose options are already at zsh's defaults, so
# they prove startup ADDS no hazard. They cannot prove startup REMOVES one, and
# those are different claims: a startup that merely stopped calling `setopt`
# passes every row above while still handing an agent a hostile shell.
#
# That gap was not hypothetical. A fresh bound Claude lane reported EXTENDED_GLOB
# on after snapshot replay, and the argument, glob, navigation, and
# command-resolution probes all failed, because the harness had the option set
# before startup ran and startup left it alone.
#
# These rows start the same shells with the three hazards already enabled, via
# `-o` at launch so the state arrives the way a harness delivers it rather than
# through a file this contract also owns. Startup must actively normalise them.
#
# The behavioural row is the one that matters: with EXTENDED_GLOB and NULL_GLOB
# on, an unquoted `HEAD^` expands to a pattern and is then deleted entirely, so
# a revision argument disappears from the command with no error.
run_hostile_mode() {
  local mode="$1" probe="$2"
  local -a flags
  case "$mode" in
    noninteractive-nonlogin) flags=(-c) ;;
    noninteractive-login)    flags=(-l -c) ;;
    interactive-nonlogin)    flags=(-i -c) ;;
    interactive-login)       flags=(-i -l -c) ;;
    *) fail "unknown startup mode: $mode" ;;
  esac

  local err_file="$TEST_ROOT/stderr.hostile.$mode"
  : >"$err_file" || fail "$mode: could not create stderr receipt"

  set +e
  probe_out="$(
    env -i \
      HOME="$home" \
      ZDOTDIR="$home" \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$tmp_root" \
      TERM=dumb \
      CONTRACT_WORK="$work" \
      CONTRACT_SECRET="$DISCLOSURE_SENTINEL" \
      /bin/zsh -o extendedglob -o nullglob -o globdots "${flags[@]}" "$probe" 2>"$err_file"
  )"
  probe_status=$?
  set -e
  probe_err="$(<"$err_file")"
}

for mode in noninteractive-nonlogin noninteractive-login interactive-nonlogin interactive-login; do
  run_hostile_mode "$mode" "$options_probe"
  assert_equals "$probe_status" '0' "$mode: startup exits zero against hostile option state"
  assert_equals "$(grep '^extendedglob=' <<<"$probe_out")" 'extendedglob=off' \
    "$mode: startup clears inherited EXTENDED_GLOB"
  assert_equals "$(grep '^nullglob=' <<<"$probe_out")" 'nullglob=off' \
    "$mode: startup clears inherited NULL_GLOB"
  assert_equals "$(grep '^globdots=' <<<"$probe_out")" 'globdots=off' \
    "$mode: startup clears inherited GLOB_DOTS"
  assert_equals "$(grep '^nomatch=' <<<"$probe_out")" 'nomatch=on' \
    "$mode: startup restores NOMATCH against hostile option state"

  # The consequence, not just the flag. NULL_GLOB deletes the unmatched pattern
  # rather than failing, so this row distinguishes "the option is off" from "the
  # argument survived", which is the property an agent actually depends on.
  run_hostile_mode "$mode" "$behavior_probe"
  assert_equals "$probe_status" '0' "$mode: behavior probe exits zero against hostile option state"
  assert_equals "$(grep '^headcaret_argc=' <<<"$probe_out")" 'headcaret_argc=1' \
    "$mode: unquoted HEAD^ survives hostile inherited option state"
  assert_equals "$(grep '^headcaret_first=' <<<"$probe_out")" 'headcaret_first=HEAD^' \
    "$mode: unquoted HEAD^ keeps its literal value against hostile option state"
  assert_equals "$(grep '^wildcard=' <<<"$probe_out")" 'wildcard=visible.txt' \
    "$mode: ordinary wildcard excludes hidden files against hostile option state"
done

# Snapshot replay lane. The path is supplied at run time; absence is reported as
# a skip so a missing input can never be mistaken for proof.
if [[ -n "${ZSH_CONTRACT_SNAPSHOT:-}" ]]; then
  [[ -r "$ZSH_CONTRACT_SNAPSHOT" ]] || fail "supplied snapshot is not readable"

  # Replay a private copy rather than the supplied file, so the marker below is
  # planted without ever writing to the user's snapshot.
  #
  # The disclosure claim needs a snapshot-content value that is certainly present
  # and certainly distinctive. Grepping the supplied snapshot for a naturally
  # occurring string would make the claim only as strong as that file's contents,
  # and a snapshot that happened to lack the chosen string would pass vacuously.
  # Planting a marker the copy is guaranteed to carry removes that dependency.
  #
  # The marker is planted as two `print` statements, one per stream, so it is not
  # inert text: replaying this copy actively pushes it at both stdout and stderr,
  # and only the redirection on the `source` line keeps it out of the receipts.
  # Remove either half of that redirection and the assertion below goes RED.
  SNAPSHOT_CONTENT_MARKER='zsh-contract-snapshot-content-marker-do-not-print'
  replay_snapshot="$TEST_ROOT/replay-snapshot.sh"
  {
    printf 'print -r -- %s\n' "$SNAPSHOT_CONTENT_MARKER"
    printf 'print -r -- %s >&2\n' "$SNAPSHOT_CONTENT_MARKER"
    cat -- "$ZSH_CONTRACT_SNAPSHOT"
  } >"$replay_snapshot" || fail 'could not stage the replay snapshot copy'

  # Negative control for the snapshot-content half of the detector.
  #
  # Proves the marker is one the oracle actually rejects, so the disclosure
  # assertion below cannot pass merely because nothing is being looked for.
  # Only the exit status is read, so the marker is never reprinted.
  assert_detector_rejects \
    "replayed startup noise ${SNAPSHOT_CONTENT_MARKER} more noise" \
    'disclosure detector rejects planted snapshot content'

  # The nested zsh evaluates these expressions.
  # shellcheck disable=SC2016
  replay_probe='
    source -- "$CONTRACT_REPLAY_SNAPSHOT" >/dev/null 2>&1
    print -r -- "extendedglob=$options[extendedglob]"
    print -r -- "nullglob=$options[nullglob]"
    print -r -- "globdots=$options[globdots]"
    print -r -- "nomatch=$options[nomatch]"
    args=(HEAD^)
    print -r -- "headcaret_argc=${#args[@]}"
    print -r -- "headcaret_first=${args[1]}"
    cd -- "$CONTRACT_WORK"
    matches=(*)
    print -r -- "wildcard=${matches[*]}"
  '

  run_mode noninteractive-nonlogin "$replay_probe"
  assert_equals "$probe_status" '0' 'snapshot replay: probe exits zero'
  # The replayed body is pushed at both streams; the receipts must still be clean.
  assert_no_disclosure "$probe_out" "$probe_err" 'snapshot replay: receipts disclose no snapshot content'
  assert_equals "$(grep '^extendedglob=' <<<"$probe_out")" 'extendedglob=off' 'snapshot replay: EXTENDED_GLOB is off'
  assert_equals "$(grep '^nullglob=' <<<"$probe_out")" 'nullglob=off' 'snapshot replay: NULL_GLOB is off'
  assert_equals "$(grep '^globdots=' <<<"$probe_out")" 'globdots=off' 'snapshot replay: GLOB_DOTS is off'
  assert_equals "$(grep '^nomatch=' <<<"$probe_out")" 'nomatch=on' 'snapshot replay: default NOMATCH stays on'
  assert_equals "$(grep '^headcaret_argc=' <<<"$probe_out")" 'headcaret_argc=1' 'snapshot replay: unquoted HEAD^ stays one argument'
  assert_equals "$(grep '^headcaret_first=' <<<"$probe_out")" 'headcaret_first=HEAD^' 'snapshot replay: unquoted HEAD^ keeps its literal value'
  assert_equals "$(grep '^wildcard=' <<<"$probe_out")" 'wildcard=visible.txt' 'snapshot replay: ordinary wildcard excludes hidden files'
else
  skip 'snapshot replay: set ZSH_CONTRACT_SNAPSHOT to a fresh harness snapshot'
fi

# Receipts name behavior only. No environment value or snapshot content is printed.
printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
