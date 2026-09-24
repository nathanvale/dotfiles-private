#!/usr/bin/env bash

# Work-profile selection and credential boundary contract (issue 51).
#
# Proves that a real zsh child started against this repository's startup owners
# loads a private work profile only through one validated non-secret scalar in
# the existing machine-state owner, that a malformed or hostile selector loads
# nothing, that the selector's text is never executed as shell code, that the
# generic adapter is the only public-to-private bridge, and that private profile
# startup stays silent.
#
# The production consumer is Nathan's shell and any agent harness that starts a
# zsh child and captures both streams. A selector that could name a path, expand
# a command, or reach outside the intended location would let anything able to
# write one small state file choose which file every future shell executes.
#
# Every behavioural assertion reads a real /bin/zsh child under a hermetic HOME.
# The oracle is a sentinel exported by a FIXTURE profile, so an assertion cannot
# be satisfied by the code under test agreeing with itself. Nothing here holds a
# real credential, and no assertion prints a file's contents or an environment
# value.

# Single quotes are load-bearing throughout this file and must not be "fixed"
# into double quotes. Two distinct reasons:
#
#   - Probe bodies passed to a nested `zsh -c` are evaluated by that CHILD, so
#     `${WORK_PROFILE_MARKER}` must survive this shell unexpanded to read the
#     child's environment rather than this one's.
#   - Hostile selector fixtures such as `$(id)` are the INPUT under test. If
#     this shell expanded them, the contract would feed the adapter the result
#     of an injection instead of the injection itself, and the rows proving the
#     selector is never executed would test nothing.
#
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

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

# ---------------------------------------------------------------------------
# The adapter under test.
# ---------------------------------------------------------------------------
#
# The block is extracted from .zshrc rather than re-implemented, so this file
# cannot drift into testing its own copy of the logic. Extraction is asserted to
# have found something: an empty extraction would make every row below pass
# vacuously against an empty file.
adapter="$TEST_ROOT/work-profile-adapter.zsh"
sed -n '/^# Work profile config/,/^dotfiles-work-profile-load$/p' "$REPO_ROOT/.zshrc" >"$adapter"
[[ -s "$adapter" ]] || fail 'could not extract the work-profile adapter from .zshrc'
grep -q '^dotfiles-work-profile-load$' "$adapter" ||
  fail 'extracted adapter does not end at its load call'
pass 'the work-profile adapter is extracted from .zshrc'

# ---------------------------------------------------------------------------
# Hermetic home.
# ---------------------------------------------------------------------------
#
# Two profiles are planted. The INTENDED one sits where a valid slug resolves.
# The OUT-OF-TREE one sits outside $HOME/code and exports a different sentinel,
# so "did not escape" is measured by that sentinel's absence rather than merely
# asserted. Both are fixtures holding a marker, never a secret.
new_home() {
  local home="$TEST_ROOT/$1"
  rm -rf "$home"
  mkdir -p "$home/code/acme-dotfiles" "$home/.dotfiles_state" "$home/outside/evil-dotfiles"
  printf 'export WORK_PROFILE_MARKER=intended\n' >"$home/code/acme-dotfiles/profile.zsh"
  printf 'export WORK_PROFILE_ESCAPED=yes\n' >"$home/outside/evil-dotfiles/profile.zsh"
  printf '%s\n' "$home"
}

home="$(new_home home)"

# Sets probe_out and probe_err_bytes. The selector is written as raw bytes so a
# hostile value reaches the adapter exactly as an attacker would leave it.
#
# Startup noise goes to its own receipt and only its SIZE is read. A diagnostic
# can carry a HOME path or an environment value, so proving one existed by
# reprinting it would recreate the disclosure this contract exists to prevent.
run_selector() {
  local selector="$1"
  if [[ "$selector" == '<unset>' ]]; then
    rm -f "$home/.dotfiles_state/work-profile"
  else
    printf '%s\n' "$selector" >"$home/.dotfiles_state/work-profile"
  fi

  local err_file="$TEST_ROOT/stderr.probe"
  : >"$err_file" || fail 'could not create stderr receipt'

  set +e
  probe_out="$(
    env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb \
      /bin/zsh -c '
        source "$1" >/dev/null
        print -r -- "marker=${WORK_PROFILE_MARKER:-none}"
        print -r -- "escaped=${WORK_PROFILE_ESCAPED:-none}"
        print -r -- "sideeffect=$([[ -e $HOME/PWNED ]] && print yes || print no)"
      ' _ "$adapter" 2>"$err_file"
  )"
  probe_status=$?
  set -e
  probe_err_bytes="$(wc -c <"$err_file" | tr -d ' ')"
}

marker_of() { grep '^marker=' <<<"$probe_out"; }
escaped_of() { grep '^escaped=' <<<"$probe_out"; }

# ---------------------------------------------------------------------------
# Positive control.
# ---------------------------------------------------------------------------
#
# Without this, every refusal row below would be satisfied by an adapter that
# loads nothing at all, and the contract would pass while the work profile was
# silently dead. That is exactly the regression issue 47 names as user story 4.
run_selector 'acme'
assert_equals "$probe_status" '0' 'a valid selector leaves startup exiting zero'
assert_equals "$(marker_of)" 'marker=intended' \
  'a valid selector loads the intended private profile'

# Private profile startup is silent. An agent harness captures stderr, so a
# banner from the private side lands in every captured command.
assert_equals "$probe_err_bytes" '0' \
  'loading the private profile writes nothing to stderr'

# ---------------------------------------------------------------------------
# Criterion: the machine-state file is the only source of the selector.
# ---------------------------------------------------------------------------
#
# The retired shape read an ambient $WORK_PROFILE straight out of the
# environment and interpolated it into a path. Anything able to set an
# environment variable then chose which file every shell executed, and an agent
# harness that captured and replayed exported variables carried that choice into
# later sessions.
#
# The oracle is a child whose state file is ABSENT while the environment offers
# a well-formed selector naming a profile that really exists. If the ambient
# value is honoured the intended sentinel appears, so this row fails the moment
# environment input is reinstated as a source.
rm -f "$home/.dotfiles_state/work-profile"
ambient_probe="$(
  env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb \
    WORK_PROFILE=acme DOTFILES_WORK_PROFILE=acme \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      print -r -- "marker=${WORK_PROFILE_MARKER:-none}"
    ' _ "$adapter" 2>/dev/null
)"
assert_equals "$ambient_probe" 'marker=none' \
  'an ambient environment selector does not load a profile'

# The complement, so the row above cannot pass merely because loading is broken:
# the same slug in the machine-state file must load the same fixture.
printf 'acme\n' >"$home/.dotfiles_state/work-profile"
state_probe="$(
  env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb \
    WORK_PROFILE=nosuch DOTFILES_WORK_PROFILE=nosuch \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      print -r -- "marker=${WORK_PROFILE_MARKER:-none}"
    ' _ "$adapter" 2>/dev/null
)"
assert_equals "$state_probe" 'marker=intended' \
  'the machine-state file selects the profile and outranks any ambient value'

# ---------------------------------------------------------------------------
# Criterion: the selector FILE cannot be relocated by the environment.
# ---------------------------------------------------------------------------
#
# Naming the state directory through an environment variable would move the
# defect above out one level rather than close it. An ambient value would no
# longer name the profile directly, but it would name the file that names the
# profile, so anything able to set it still chooses what every shell executes.
#
# The oracle is a planted state file that WOULD select a loadable profile if the
# override were honoured. The real owner under this HOME is removed first, so if
# the adapter reads the planted file at all the intended sentinel appears and
# this row fails. A row that merely asserted "no profile loaded" could pass
# because the planted slug named nothing, so the planted file names `acme`,
# which does resolve under this HOME.
rm -f "$home/.dotfiles_state/work-profile"
mkdir -p "$home/planted-state"
printf 'acme\n' >"$home/planted-state/work-profile"
override_probe="$(
  env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb \
    DOTFILES_STATE_DIR="$home/planted-state" \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      print -r -- "marker=${WORK_PROFILE_MARKER:-none}"
    ' _ "$adapter" 2>/dev/null
)"
assert_equals "$override_probe" 'marker=none' \
  'an environment state-directory override cannot select a profile'

# The complement, so the row above cannot pass merely because the planted file
# was unreadable or the slug was wrong: the SAME bytes at the real owner load.
mv "$home/planted-state/work-profile" "$home/.dotfiles_state/work-profile"
owner_probe="$(
  env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb \
    DOTFILES_STATE_DIR="$home/planted-state" \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      print -r -- "marker=${WORK_PROFILE_MARKER:-none}"
    ' _ "$adapter" 2>/dev/null
)"
assert_equals "$owner_probe" 'marker=intended' \
  'the same selector bytes at the fixed owner path do select the profile'

# ---------------------------------------------------------------------------
# Criterion: the selector cannot escape the intended private-profile location.
# ---------------------------------------------------------------------------
#
# Each row asserts BOTH that the intended profile did not load and that the
# out-of-tree sentinel did not load. The second half is the escape claim; the
# first half stops a row from passing merely because loading broke entirely.
for hostile in '../outside/evil' '../../outside/evil' '/etc/passwd' 'a/../../outside/evil'; do
  run_selector "$hostile"
  assert_equals "$(escaped_of)" 'escaped=none' \
    "a path-bearing selector loads nothing outside the intended location: $hostile"
  assert_equals "$(marker_of)" 'marker=none' \
    "a path-bearing selector is refused rather than resolved: $hostile"
  assert_equals "$probe_status" '0' \
    "a path-bearing selector does not break startup: $hostile"
  assert_equals "$probe_err_bytes" '0' \
    "a path-bearing selector is refused silently: $hostile"
done

# ---------------------------------------------------------------------------
# Criterion: the selector is never sourced or evaluated as shell code.
# ---------------------------------------------------------------------------
#
# The oracle is a side effect, not a string comparison. Each selector below
# would create $HOME/PWNED if its text were ever expanded by the shell, so the
# `sideeffect=no` row fails the moment the adapter evaluates the value. A
# grammar check alone cannot prove this; only running it can.
# The nested zsh evaluates these expressions; single quotes are deliberate.
# shellcheck disable=SC2016
for injection in '$(touch "$HOME/PWNED")' '`touch "$HOME/PWNED"`' 'acme; touch "$HOME/PWNED"' 'acme$(touch "$HOME/PWNED")' 'a" ; touch "$HOME/PWNED'; do
  run_selector "$injection"
  assert_equals "$(grep '^sideeffect=' <<<"$probe_out")" 'sideeffect=no' \
    "a selector carrying shell syntax is not executed: ${injection:0:24}"
  assert_equals "$(marker_of)" 'marker=none' \
    "a selector carrying shell syntax is refused: ${injection:0:24}"
done

# The side-effect oracle must be able to observe a real side effect, otherwise
# every row above passes because nothing was ever watched.
touch "$home/PWNED"
run_selector 'acme'
assert_equals "$(grep '^sideeffect=' <<<"$probe_out")" 'sideeffect=yes' \
  'the side-effect oracle observes a deliberately planted marker'
rm -f "$home/PWNED"

# ---------------------------------------------------------------------------
# Criterion: a conservative slug grammar.
# ---------------------------------------------------------------------------
#
# The grammar is exercised through the adapter's own public function so the
# accepted and rejected sets are visible directly, not inferred from whether a
# fixture happened to exist.
check_slug() {
  env -i HOME="$home" PATH=/usr/bin:/bin \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      if slug="$(dotfiles-work-profile-slug 2>/dev/null)"; then
        print -r -- "accept:$slug"
      else
        print -r -- "reject"
      fi
    ' _ "$adapter" 2>/dev/null
}

# Accepted: a bare slug, a hyphenated slug, a single character, a slug carrying
# a digit, and a longer ordinary word. These are generic fixtures on purpose. A
# real employer name in a public repository is the disclosure this whole adapter
# exists to avoid, and the grammar cannot tell one word from another anyway, so
# a literal one would prove nothing the generic ones do not.
for good in 'acme' 'a-b-c' 'a' 'acme2' 'examplecorp'; do
  printf '%s\n' "$good" >"$home/.dotfiles_state/work-profile"
  assert_equals "$(check_slug)" "accept:$good" "the grammar accepts a conservative slug: $good"
done

# Rejected. Each entry names a distinct hazard rather than repeating one shape.
# The value is written WITH a trailing newline, which is the shape `echo` and a
# human editor both produce, so each row fails for the reason it names rather
# than because the file happened to end early. The no-newline shape is accepted
# and is covered as its own row below.
reject_case() {
  printf '%s\n' "$2" >"$home/.dotfiles_state/work-profile"
  assert_equals "$(check_slug)" 'reject' "the grammar refuses $1"
}
reject_case 'a traversal segment'        '../evil'
reject_case 'an absolute path'           '/etc/passwd'
reject_case 'an interior slash'          'a/b'
reject_case 'a dot'                      'a.b'
reject_case 'uppercase'                  'Acme'
reject_case 'an interior space'          'ac me'
reject_case 'a leading hyphen'           '-acme'
reject_case 'a trailing hyphen'          'acme-'
reject_case 'a doubled hyphen'           'a--b'
reject_case 'a tilde'                    '~root'
reject_case 'a command substitution'     '$(id)'
reject_case 'a backtick'                 '`id`'
reject_case 'a semicolon'                'a;id'
reject_case 'a glob character'           'a*'
reject_case 'an empty value'             ''
reject_case 'an over-length value'       'abcdefghijklmnopqrstuvwxyz0123456789'

# ---------------------------------------------------------------------------
# Criterion: the file holds EXACTLY one scalar.
# ---------------------------------------------------------------------------
#
# Reading only the first line and ignoring the rest is not enough. It makes a
# file whose first line is benign and whose second line is hostile look
# well-formed, so a writer who appended a value would see the adapter accept the
# file rather than refuse it. Refusing the whole file is what makes the state on
# disk and the value in use the same thing.
#
# Both positive controls come first, because every rejection row below is
# satisfied by an adapter that refuses everything and silently disables the work
# profile.
printf '%s\n' 'acme' >"$home/.dotfiles_state/work-profile"
assert_equals "$(check_slug)" 'accept:acme' \
  'one valid slug with a trailing newline is accepted'

# A scalar stored without a trailing newline is ordinary and must still work.
# `read` returns non-zero at end of file, so without this row an adapter that
# treated that status as a rejection would look correct while refusing every
# file written with `printf %s`.
printf '%s' 'acme' >"$home/.dotfiles_state/work-profile"
assert_equals "$(check_slug)" 'accept:acme' \
  'one valid slug without a trailing newline is accepted'

# A second line cannot smuggle a value past the first, in any of the shapes a
# file can end. Each is written separately because they exercise different exits
# from the read: a complete second line, a second line with no final newline, a
# blank line from a stray `echo`, and trailing blank lines.
second_line_case() {
  printf '%b' "$2" >"$home/.dotfiles_state/work-profile"
  assert_equals "$(check_slug)" 'reject' "a second line is refused: $1"
}
second_line_case 'a hostile complete second line' 'acme\n../outside/evil\n'
second_line_case 'a second line with no final newline' 'acme\n../outside/evil'
second_line_case 'a blank second line' 'acme\n\n'
second_line_case 'trailing blank lines' 'acme\n\n\n'

# Surrounding whitespace is refused rather than trimmed. Trimming would mean the
# bytes on disk and the slug in use disagree, and a human reading the file would
# not see what the shell actually resolved.
whitespace_case() {
  printf '%b' "$2" >"$home/.dotfiles_state/work-profile"
  assert_equals "$(check_slug)" 'reject' "surrounding whitespace is refused: $1"
}
whitespace_case 'a leading space'  ' acme\n'
whitespace_case 'a trailing space' 'acme \n'
whitespace_case 'surrounding spaces' '   acme   \n'
whitespace_case 'a leading tab'    '\tacme\n'
whitespace_case 'a trailing tab'   'acme\t\n'

# Absent state is not an error: a machine with no work profile is the norm.
rm -f "$home/.dotfiles_state/work-profile"
assert_equals "$(check_slug)" 'reject' 'an absent selector selects nothing'
run_selector '<unset>'
assert_equals "$probe_status" '0' 'an absent selector leaves startup exiting zero'
assert_equals "$(marker_of)" 'marker=none' 'an absent selector loads no profile'
assert_equals "$probe_err_bytes" '0' 'an absent selector is silent'

# ---------------------------------------------------------------------------
# Criterion: the validator does not leak a global shell option.
# ---------------------------------------------------------------------------
#
# The grammar needs EXTENDED_GLOB, which issue 48 removed globally because it
# changes the meaning of ordinary agent commands. The adapter takes a local
# baseline; this row proves the baseline is given back. Without it the repair
# for issue 51 would silently reopen issue 48.
option_state="$(
  env -i HOME="$home" PATH=/usr/bin:/bin \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      printf "acme" >"$HOME/.dotfiles_state/work-profile"
      dotfiles-work-profile-slug >/dev/null 2>&1
      print -r -- "extendedglob=$([[ -o extended_glob ]] && print on || print off)"
      print -r -- "nomatch=$([[ -o nomatch ]] && print on || print off)"
      print -r -- "fd_parameter=$(( ${+fd} ))"
    ' _ "$adapter" 2>/dev/null
)"
assert_equals "$(grep '^extendedglob=' <<<"$option_state")" 'extendedglob=off' \
  'validating a selector does not leave EXTENDED_GLOB enabled'
assert_equals "$(grep '^nomatch=' <<<"$option_state")" 'nomatch=on' \
  'validating a selector does not leave NOMATCH disabled'
assert_equals "$(grep '^fd_parameter=' <<<"$option_state")" 'fd_parameter=0' \
  'validating a selector does not leak its file-descriptor parameter'

# ---------------------------------------------------------------------------
# Criterion: symlink containment, independent of the grammar.
# ---------------------------------------------------------------------------
#
# A well-formed slug whose directory is a symlink out of $HOME/code passes every
# grammar row above. This is the second, independent check, and it is the reason
# containment is not left to the grammar alone.
link_home="$(new_home link-home)"
mkdir -p "$link_home/outside/planted"
printf 'export WORK_PROFILE_ESCAPED=yes\n' >"$link_home/outside/planted/profile.zsh"
ln -s "$link_home/outside/planted" "$link_home/code/sneaky-dotfiles"
printf 'sneaky\n' >"$link_home/.dotfiles_state/work-profile"
link_out="$(
  env -i HOME="$link_home" PATH=/usr/bin:/bin \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      print -r -- "escaped=${WORK_PROFILE_ESCAPED:-none}"
    ' _ "$adapter" 2>/dev/null
)"
assert_equals "$link_out" 'escaped=none' \
  'a well-formed slug pointing through a symlink out of the tree is refused'

# The human report must describe the loader's decision, not merely the fact that
# a candidate file exists. This is the one case where those facts differ.
link_report="$(
  env -i HOME="$link_home" PATH=/usr/bin:/bin \
    /bin/zsh -c '
      source "$1" >/dev/null 2>&1
      dotfiles-work-profile || true
    ' _ "$adapter" 2>/dev/null
)"
[[ "$link_report" == 'work-profile: sneaky (refused:'* ]] ||
  fail 'the human report says a symlink escape was refused'
pass 'the human report says a symlink escape was refused'
[[ "$link_report" != *'(loaded from '* ]] ||
  fail 'the human report never says a refused symlink was loaded'
pass 'the human report never says a refused symlink was loaded'

# ---------------------------------------------------------------------------
# Criterion: the generic adapter is the only public-to-private bridge.
# ---------------------------------------------------------------------------
#
# A second loader bypasses every check above. Two shapes matter and both are
# caught here, because they fail in the same way:
#
#   - a LITERAL employer-named loader, which skips validation and also puts an
#     employer name in a public repository;
#   - an INTERPOLATED loader such as `${WORK_PROFILE}-dotfiles/profile.zsh`,
#     which is the retired shape: it takes its selector from wherever that
#     variable came from, including the ambient environment.
#
# So the scan matches any startup line that sources a `-dotfiles/profile.zsh`
# path at all, then subtracts only the adapter's own line. The adapter sources
# `$resolved`, a local set from the validated slug and checked for containment,
# and it is identified by that variable rather than by a path pattern.
scan_literal_bridges() {
  local root="$1" owner
  for owner in .zshenv .zprofile .zshrc .zlogin; do
    [[ -f "$root/$owner" ]] || continue
    grep -nE '(source|\.) .*-dotfiles/profile\.zsh' "$root/$owner" 2>/dev/null |
      grep -v 'source "\$resolved"' |
      sed "s#^#$owner:#" || true
  done
}

literal_bridges="$(scan_literal_bridges "$REPO_ROOT")"
[[ -z "$literal_bridges" ]] ||
  fail "startup owners contain a literal private-profile loader: $literal_bridges"
pass 'the validated adapter is the only public-to-private bridge in startup'

# The scanner must be able to see one, otherwise the row above is vacuous.
bridge_fixture="$TEST_ROOT/bridge-fixture"
mkdir -p "$bridge_fixture"
printf '[ -f "$HOME/code/acme-dotfiles/profile.zsh" ] && source "$HOME/code/acme-dotfiles/profile.zsh"\n' \
  >"$bridge_fixture/.zshrc"
assert_equals "$(scan_literal_bridges "$bridge_fixture" | wc -l | tr -d ' ')" '1' \
  'the bridge scanner detects a literal employer-named loader'

# The interpolated shape is the retired one, so the scanner must see it too.
printf 'source "$HOME/code/${WORK_PROFILE}-dotfiles/profile.zsh"\n' >"$bridge_fixture/.zshrc"
assert_equals "$(scan_literal_bridges "$bridge_fixture" | wc -l | tr -d ' ')" '1' \
  'the bridge scanner detects an interpolated ambient loader'

# And it must NOT flag the adapter's own validated source line, otherwise the
# repository row above would be impossible to satisfy and the scan would be
# reporting a constant rather than a measurement.
printf 'source "$resolved"\n' >"$bridge_fixture/.zshrc"
assert_equals "$(scan_literal_bridges "$bridge_fixture" | wc -l | tr -d ' ')" '0' \
  'the bridge scanner clears the adapter own validated loader'

# ---------------------------------------------------------------------------
# Criterion: startup sources no secret file.
# ---------------------------------------------------------------------------
#
# The retired shape read a `secrets.env` from the account-switch config: it
# `eval`ed `op inject` output when the file named an `op://` reference and
# `source`d the file otherwise. Both put a credential into every zsh process and
# into every harness snapshot of exported variables.
#
# The oracle is a real child. A hermetic HOME is given BOTH shapes of that file,
# each exporting a sentinel, and neither sentinel may appear in the child's
# environment. The sentinels are fixture strings, not credentials.
secret_home="$TEST_ROOT/secret-home"
rm -rf "$secret_home"
mkdir -p "$secret_home/.config/lll-account-switch"
for owner in .zshenv .zprofile .zshrc; do
  cp "$REPO_ROOT/$owner" "$secret_home/$owner"
done
printf 'export CONTRACT_PLAIN_SENTINEL=plain-fixture-value\n' \
  >"$secret_home/.config/lll-account-switch/secrets.env"

secret_probe="$(
  env -i HOME="$secret_home" ZDOTDIR="$secret_home" PATH=/usr/bin:/bin TERM=dumb \
    /bin/zsh -i -l -c '
      print -r -- "plain=${CONTRACT_PLAIN_SENTINEL:-none}"
    ' 2>/dev/null
)"
assert_equals "$(grep '^plain=' <<<"$secret_probe")" 'plain=none' \
  'startup does not source a plain secret file into the shell'

# The same file in `op://` shape must not be evaluated either. The reference is
# not a real vault path and carries no credential. The retired lane ran only when
# `op` resolved, so without an `op` this row passes with the lane restored. The
# child gets a stand-in function, appended to the fixture's .zshenv copy so it
# exists before .zshrc runs and outranks any real `op` on PATH: `op inject -i
# FILE` echoes FILE unresolved, which is enough for an `eval` to export the
# sentinel. A PATH stand-in cannot work here: .zshrc drops temporary entries.
printf '%s\n' 'op() { [[ "$1" == inject && "$2" == -i ]] && cat -- "$3"; }' \
  >>"$secret_home/.zshenv"
printf 'CONTRACT_REF_SENTINEL=op://contract-not-a-real-vault/item/field\nexport CONTRACT_EVAL_SENTINEL=eval-fixture-value\n' \
  >"$secret_home/.config/lll-account-switch/secrets.env"
op_kind="$(
  env -i HOME="$secret_home" ZDOTDIR="$secret_home" PATH=/usr/bin:/bin TERM=dumb \
    /bin/zsh -i -l -c 'whence -w op' 2>/dev/null
)" || true
[[ "$op_kind" == 'op: function' ]] ||
  fail "reference-bearing secret row: startup child lost the stand-in op (got [$op_kind])"
ref_probe="$(
  env -i HOME="$secret_home" ZDOTDIR="$secret_home" PATH=/usr/bin:/bin TERM=dumb \
    /bin/zsh -i -l -c '
      print -r -- "evaled=${CONTRACT_EVAL_SENTINEL:-none}"
    ' 2>/dev/null
)"
assert_equals "$(grep '^evaled=' <<<"$ref_probe")" 'evaled=none' \
  'startup does not evaluate a reference-bearing secret file'

# ---------------------------------------------------------------------------
# Criterion: existing work-profile behaviour is preserved.
# ---------------------------------------------------------------------------
#
# The literal employer-named loader was unconditional, so removing it without
# seeding the new scalar would silently disable a working work environment on a
# machine that had one. That is the regression issue 47 names as user story 4,
# and it is a safety change turning into an outage.
#
# setup.sh owns the migration. It is extracted and driven directly with stub
# loggers, because running the real installer would touch this machine.
migration="$TEST_ROOT/migrate.sh"
sed -n '/^    # Work-profile state migration\./,/^    }$/p' "$REPO_ROOT/setup.sh" |
  sed 's/^    //' >"$migration"
[[ -s "$migration" ]] || fail 'could not extract the work-profile migration from setup.sh'
grep -q '^migrate_work_profile_state()' "$migration" ||
  fail 'extracted migration does not define its function'
pass 'the work-profile migration is extracted from setup.sh'

# Migration publishes its selector through the production atomic state writer.
# Load the exact helper definitions beside the extracted function, and fail
# closed if a source refactor removes one of its dependencies.
state_helpers="$TEST_ROOT/state-helpers.sh"
{
  sed -n '/^    state_file_is_safe() {$/,/^    }$/p' "$REPO_ROOT/setup.sh"
  sed -n '/^    atomic_publish_file() {$/,/^    }$/p' "$REPO_ROOT/setup.sh"
  sed -n '/^    atomic_write_state_text() {$/,/^    }$/p' "$REPO_ROOT/setup.sh"
} | sed 's/^    //' >"$state_helpers"
[[ -s "$state_helpers" ]] || fail 'could not extract migration state helpers from setup.sh'
for helper in state_file_is_safe atomic_publish_file atomic_write_state_text; do
  grep -q "^${helper}() {$" "$state_helpers" ||
    fail "extracted migration state helpers do not define $helper"
done
pass 'migration loads production atomic state helpers from setup.sh'

migrate_home="$TEST_ROOT/migrate-home"
# Optional leading `--ambient <value>` exports the retired WORK_PROFILE into
# the child, exercising the migration's ambient branch; remaining arguments
# name repositories to plant. The guarded expansion keeps an empty array legal
# under `set -u` on bash 3.2.
run_migration() {
  local ambient_env=()
  if [[ "${1:-}" == '--ambient' ]]; then
    ambient_env=(WORK_PROFILE="$2")
    shift 2
  fi
  rm -rf "$migrate_home"
  mkdir -p "$migrate_home/state" "$migrate_home/code"
  local repo
  for repo in "$@"; do
    mkdir -p "$migrate_home/code/${repo}-dotfiles"
    : >"$migrate_home/code/${repo}-dotfiles/profile.zsh"
  done
  env -i HOME="$migrate_home" PATH=/usr/bin:/bin \
    ${ambient_env[@]+"${ambient_env[@]}"} \
    bash -c '
      STATE_DIR="$HOME/state"
      log() { :; }
      log_warn() { :; }
      source "$2"
      source "$1"
      migrate_work_profile_state
      printf "state=%s\n" "$(cat "$STATE_DIR/work-profile" 2>/dev/null)"
    ' _ "$migration" "$state_helpers" 2>/dev/null
}

assert_equals "$(run_migration acme)" 'state=acme' \
  'migration adopts the one private profile repository present'
assert_equals "$(run_migration)" 'state=' \
  'migration writes nothing when no private profile repository exists'
assert_equals "$(run_migration acme beta)" 'state=' \
  'migration refuses to guess between two private profile repositories'

# A directory name that cannot pass the shell grammar must not be written, or
# setup would leave a selection .zshrc silently refuses at every startup.
assert_equals "$(run_migration 'Bad_Name')" 'state=' \
  'migration refuses a directory name that fails the slug grammar'

# The ambient branch is a one-time convenience for a machine whose old shell
# still exports the retired WORK_PROFILE. It seeds the state file only when the
# value names a repository that is really present; an ambient value naming
# nothing must fall through and write no selection.
assert_equals "$(run_migration --ambient acme acme)" 'state=acme' \
  'migration adopts a valid ambient selection naming a present repository'
assert_equals "$(run_migration --ambient ghost)" 'state=' \
  'migration ignores an ambient selection with no matching repository'

# Containment parity with the shell: a well-formed candidate whose directory is
# a symlink out of $HOME/code is a selection .zshrc refuses at every startup,
# so the migration must not seed it.
rm -rf "$migrate_home"
mkdir -p "$migrate_home/state" "$migrate_home/code" "$migrate_home/outside/planted-dotfiles"
: >"$migrate_home/outside/planted-dotfiles/profile.zsh"
ln -s "$migrate_home/outside/planted-dotfiles" "$migrate_home/code/sneaky-dotfiles"
out_of_tree="$(
  env -i HOME="$migrate_home" PATH=/usr/bin:/bin \
    bash -c '
      STATE_DIR="$HOME/state"
      log() { :; }
      log_warn() { :; }
      source "$2"
      source "$1"
      migrate_work_profile_state
      printf "state=%s\n" "$(cat "$STATE_DIR/work-profile" 2>/dev/null)"
    ' _ "$migration" "$state_helpers" 2>/dev/null
)"
assert_equals "$out_of_tree" 'state=' \
  'migration refuses a candidate that resolves outside HOME/code'

# An existing selection is authoritative. Overwriting it would let a later setup
# run change which work profile loads without anyone asking for that.
rm -rf "$migrate_home"
mkdir -p "$migrate_home/state" "$migrate_home/code/acme-dotfiles"
: >"$migrate_home/code/acme-dotfiles/profile.zsh"
printf 'chosen\n' >"$migrate_home/state/work-profile"
preserved="$(
  env -i HOME="$migrate_home" PATH=/usr/bin:/bin \
    bash -c '
      STATE_DIR="$HOME/state"
      log() { :; }
      log_warn() { :; }
      source "$2"
      source "$1"
      migrate_work_profile_state
      printf "state=%s\n" "$(cat "$STATE_DIR/work-profile" 2>/dev/null)"
    ' _ "$migration" "$state_helpers" 2>/dev/null
)"
assert_equals "$preserved" 'state=chosen' \
  'migration never overwrites an existing selection'

# The migration and the shell must agree on the grammar, otherwise setup can
# write a value startup refuses. Every slug the migration accepts is fed back
# through the adapter's own validator.
printf 'acme\n' >"$home/.dotfiles_state/work-profile"
assert_equals "$(check_slug)" 'accept:acme' \
  'a slug the migration writes is accepted by the shell validator'

printf '1..%d\n' "$assertion_count"
