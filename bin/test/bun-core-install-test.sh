#!/usr/bin/env bash

# Development runtime setup contract.
#
# Proves that both Brewfile profiles declare Mise and the retained runtime
# fallbacks, and that fresh-machine setup Phase 4 makes Mise available before
# one explicit applied-revision update. It keeps the existing Bun and fnm
# contract. The production phase is extracted verbatim from setup.sh and runs
# in a real hermetic Bash child. Homebrew, fnm, Mise, and the public toolchain
# executable are stubbed at their process boundaries; recorded argv, ordering,
# exit status, and the phase log are the independent observables.
#
# This contract does not install software or prove live Homebrew, network, or
# Headless-server behaviour.

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

assert_recorded() {
  local expected="$1" label="$2"
  grep -Fxq "$expected" "$RECORD_DIR/brew-calls" ||
    fail "$label (missing [$expected])"
  pass "$label"
}

assert_not_recorded() {
  local unexpected="$1" label="$2"
  if grep -Fxq "$unexpected" "$RECORD_DIR/brew-calls"; then
    fail "$label (found [$unexpected])"
  fi
  pass "$label"
}

assert_text_absent() {
  local unexpected="$1" label="$2"
  if grep -Fq "$unexpected" "$RECORD_DIR/brew-calls"; then
    fail "$label (found [$unexpected])"
  fi
  pass "$label"
}

assert_exact_count() {
  local expected="$1" pattern="$2" file="$3" label="$4"
  local actual
  actual="$(grep -Fxc "$pattern" "$file" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected $expected, observed $actual)"
  pass "$label"
}

# Independent oracle: keep the intended parity version literal in the test.
[[ "$(tr -d '[:space:]' < "$REPO_ROOT/config/node/version")" == "24.20.0" ]] ||
  fail 'Node version declaration differs from 24.20.0'
pass 'Node version declaration is 24.20.0'

# Evaluate the real Brewfile as Ruby for each profile. The tiny DSL adapter
# records literal declarations only; it does not call Homebrew or mutate the
# machine.
for profile_name in desktop server; do
  brewfile_rows="$TEST_ROOT/brewfile-$profile_name"
  HOMEBREW_DOTFILES_PROFILE="$profile_name" /usr/bin/ruby -e '
    def tap(*) end
    def cask(*) end
    def brew(name, *)
      puts name
    end
    load ARGV.fetch(0)
  ' "$REPO_ROOT/config/brew/Brewfile" >"$brewfile_rows" ||
    fail "$profile_name Brewfile evaluation failed"
  for formula in mise bun python pyenv fnm pnpm; do
    grep -Fxq "$formula" "$brewfile_rows" ||
      fail "$profile_name Brewfile omits retained formula $formula"
  done
  pass "$profile_name Brewfile declares Mise and every retained runtime fallback"
  duplicate_formulas="$(awk -F/ '{ print $NF }' "$brewfile_rows" | LC_ALL=C sort | uniq -d)"
  [[ -z "$duplicate_formulas" ]] ||
    fail "$profile_name Brewfile has duplicate normalized formula ownership [$duplicate_formulas]"
  pass "$profile_name Brewfile has one owner for every normalized formula name"
  assert_exact_count 1 'steipete/tap/peekaboo' "$brewfile_rows" \
    "$profile_name Brewfile keeps one fully qualified Peekaboo owner"
done

phase="$TEST_ROOT/phase-4.sh"
sed -n '/^    phase_4_development() {$/,/^    }$/p' "$REPO_ROOT/setup.sh" |
  sed 's/^    //' >"$phase"
[[ -s "$phase" ]] || fail 'could not extract phase_4_development from setup.sh'
grep -q '^phase_4_development() {$' "$phase" ||
  fail 'extracted phase does not define its function'
pass 'phase_4_development is extracted from setup.sh'

STUB_BIN="$TEST_ROOT/stub-bin"
RECORD_DIR="$TEST_ROOT/records"
FIXTURE_DOTFILES="$TEST_ROOT/dotfiles"
mkdir -p "$STUB_BIN" "$RECORD_DIR" "$FIXTURE_DOTFILES/config/node" \
  "$FIXTURE_DOTFILES/config/brew" \
  "$FIXTURE_DOTFILES/bin/dotfiles"
cp "$REPO_ROOT/config/node/version" "$FIXTURE_DOTFILES/config/node/version"
cp "$REPO_ROOT/config/brew/Brewfile" "$FIXTURE_DOTFILES/config/brew/Brewfile"

cat >"$STUB_BIN/brew" <<'STUB'
#!/bin/bash
command_name="${1:-}"
formula_name="${2:-}"
{
  printf '%s' "$1"
  shift
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
} >>"$RECORD_DIR/brew-calls"
printf 'brew\t%s\t%s\n' "$command_name" "$formula_name" >>"$RECORD_DIR/sequence"

if [[ "$command_name" == bundle ]]; then
  printf 'profile=%s\n' "${HOMEBREW_DOTFILES_PROFILE:-unset}" >"$RECORD_DIR/bundle-environment"
  [[ "${BUNDLE_RESULT:-success}" == success ]]
  exit
fi

if [[ "$command_name" == list ]]; then
  if [[ "$formula_name" == --cask && "${3:-}" == orbstack ]]; then
    exit 0
  fi
  if [[ "$formula_name" == bun ]]; then
    [[ "${BUN_STATE:-missing}" == present ]]
  elif [[ "$formula_name" == mise ]]; then
    [[ "${MISE_STATE:-missing}" == present ]] ||
      grep -Fxq $'install\tmise' "$RECORD_DIR/brew-calls"
  else
    exit 1
  fi
  exit
fi

exit 0
STUB
chmod +x "$STUB_BIN/brew"

cat >"$STUB_BIN/fnm" <<'STUB'
#!/bin/bash
{
  printf '%s' "$1"
  shift
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
} >>"$RECORD_DIR/fnm-calls"
STUB
chmod +x "$STUB_BIN/fnm"

cat >"$STUB_BIN/mise" <<'STUB'
#!/bin/bash
exit 0
STUB
chmod +x "$STUB_BIN/mise"

cat >"$FIXTURE_DOTFILES/bin/dotfiles/toolchain" <<'STUB'
#!/bin/bash
printf 'toolchain' >>"$RECORD_DIR/toolchain-calls"
for arg in "$@"; do
  printf '\t%s' "$arg" >>"$RECORD_DIR/toolchain-calls"
done
printf '\n' >>"$RECORD_DIR/toolchain-calls"
printf 'toolchain\t%s\t%s\n' "${1:-}" "${2:-}" >>"$RECORD_DIR/sequence"
[[ "${TOOLCHAIN_RESULT:-success}" == success ]]
STUB
chmod +x "$FIXTURE_DOTFILES/bin/dotfiles/toolchain"

run_phase() {
  local bun_state="$1"
  local mise_state="${2:-missing}"
  local toolchain_result="${3:-success}"
  rm -rf "$RECORD_DIR"
  mkdir -p "$RECORD_DIR"
  # The child, not this test process, must expand its hermetic environment.
  # shellcheck disable=SC2016
  env -i HOME="$TEST_ROOT/home" PATH="$STUB_BIN:/usr/bin:/bin" \
    RECORD_DIR="$RECORD_DIR" BUN_STATE="$bun_state" \
    MISE_STATE="$mise_state" TOOLCHAIN_RESULT="$toolchain_result" \
    DOTFILES_DIR="$FIXTURE_DOTFILES" \
    bash -c '
      set -euo pipefail
      log() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_warn() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_error() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_phase() { :; }
      source "$1"
      phase_4_development
      printf "5\n" >"$RECORD_DIR/checkpoint"
    ' _ "$phase"
}

run_phase missing || fail 'fresh run exited nonzero'
pass 'fresh run exits zero'

assert_not_recorded $'tap\toven-sh/bun' \
  'fresh run does not request the retired Bun tap'
assert_recorded $'list\tbun' 'fresh run checks Bun by its core name'
assert_recorded $'install\tbun' 'fresh run installs Bun by its core name'
assert_text_absent 'oven-sh/bun' 'fresh run carries no retired Bun address'
assert_recorded $'install\tpython' \
  'fresh run continues to the next development tool'
assert_recorded $'list\tmise' 'fresh run checks Mise by its declared formula name'
assert_recorded $'install\tmise' 'fresh run installs Mise before toolchain apply'
grep -Fxq $'install\t--corepack-enabled\t24.20.0' "$RECORD_DIR/fnm-calls" ||
  fail 'fresh run does not install Node 24.20.0 with Corepack'
pass 'fresh run installs Node 24.20.0 with Corepack'
grep -Fxq $'default\t24.20.0' "$RECORD_DIR/fnm-calls" ||
  fail 'fresh run does not set Node 24.20.0 as the fnm default'
pass 'fresh run sets Node 24.20.0 as the fnm default'
assert_exact_count 1 $'toolchain\tupdate\t--apply' "$RECORD_DIR/toolchain-calls" \
  'fresh run invokes exactly one explicit toolchain apply'
mise_install_line="$(grep -nFx $'brew\tinstall\tmise' "$RECORD_DIR/sequence" | cut -d: -f1)"
toolchain_apply_line="$(grep -nFx $'toolchain\tupdate\t--apply' "$RECORD_DIR/sequence" | cut -d: -f1)"
[[ -n "$mise_install_line" && -n "$toolchain_apply_line" &&
  "$mise_install_line" -lt "$toolchain_apply_line" ]] ||
  fail 'fresh run does not make Mise available before toolchain apply'
pass 'fresh run makes Mise available before toolchain apply'
grep -Fxq 'Development Toolchain: COMPLETE' "$RECORD_DIR/log" ||
  fail 'fresh run does not report completion'
pass 'fresh run reports completion'
grep -Fxq '5' "$RECORD_DIR/checkpoint" ||
  fail 'fresh run did not reach the post-phase checkpoint seam'
pass 'fresh run reaches the post-phase checkpoint seam'

run_phase present present || fail 'preinstalled run exited nonzero'
pass 'preinstalled run exits zero'

assert_not_recorded $'tap\toven-sh/bun' \
  'preinstalled run does not request the retired Bun tap'
assert_recorded $'list\tbun' 'preinstalled run checks Bun by its core name'
assert_not_recorded $'install\tbun' 'preinstalled run skips the Bun install'
assert_text_absent 'oven-sh/bun' 'preinstalled run carries no retired Bun address'
assert_recorded $'install\tpython' \
  'preinstalled run continues to the next development tool'
assert_recorded $'list\tmise' 'preinstalled run checks Mise by its declared formula name'
assert_not_recorded $'install\tmise' 'preinstalled run skips the Mise install'
grep -Fxq $'install\t--corepack-enabled\t24.20.0' "$RECORD_DIR/fnm-calls" ||
  fail 'preinstalled run does not reconcile Node 24.20.0 with Corepack'
pass 'preinstalled run reconciles Node 24.20.0 with Corepack'
grep -Fxq $'default\t24.20.0' "$RECORD_DIR/fnm-calls" ||
  fail 'preinstalled run does not reconcile the fnm default'
pass 'preinstalled run reconciles the fnm default'
assert_exact_count 1 $'toolchain\tupdate\t--apply' "$RECORD_DIR/toolchain-calls" \
  'preinstalled run invokes exactly one explicit toolchain apply'

if run_phase present present fail; then
  fail 'failed toolchain apply did not fail Phase 4'
fi
pass 'failed toolchain apply fails Phase 4'
if grep -Fxq 'Development Toolchain: COMPLETE' "$RECORD_DIR/log"; then
  fail 'failed toolchain apply still reported Phase 4 completion'
fi
pass 'failed toolchain apply prevents the Phase 4 completion marker'
if [[ -e "$RECORD_DIR/checkpoint" ]]; then
  fail 'failed toolchain apply still reached the post-phase checkpoint seam'
fi
pass 'failed toolchain apply prevents the post-phase checkpoint'
assert_exact_count 1 $'toolchain\tupdate\t--apply' "$RECORD_DIR/toolchain-calls" \
  'failed apply is attempted exactly once'

phase5="$TEST_ROOT/phase-5.sh"
sed -n '/^    phase_5_applications() {$/,/^    }$/p' "$REPO_ROOT/setup.sh" |
  sed 's/^    //' >"$phase5"
[[ -s "$phase5" ]] || fail 'could not extract phase_5_applications from setup.sh'
grep -q '^phase_5_applications() {$' "$phase5" ||
  fail 'extracted Phase 5 does not define its function'
pass 'phase_5_applications is extracted from setup.sh'

run_phase5() {
  local bundle_result="$1"
  rm -rf "$RECORD_DIR"
  mkdir -p "$RECORD_DIR"
  # The isolated child expands its supplied environment and receipt paths.
  # shellcheck disable=SC2016
  env -i HOME="$TEST_ROOT/home" PATH="$STUB_BIN:/usr/bin:/bin" \
    RECORD_DIR="$RECORD_DIR" BUNDLE_RESULT="$bundle_result" \
    DOTFILES_DIR="$FIXTURE_DOTFILES" DOTFILES_PROFILE=desktop \
    bash -c '
      set -euo pipefail
      log() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_warn() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_error() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_phase() { :; }
      get_profile() { printf "%s\n" "$DOTFILES_PROFILE"; }
      source "$1"
      phase_5_applications
      printf "6\n" >"$RECORD_DIR/checkpoint"
    ' _ "$phase5"
}

run_phase5 success || fail 'successful Phase 5 run exited nonzero'
pass 'successful Phase 5 run exits zero'
assert_recorded $'bundle\t--file='"$FIXTURE_DOTFILES/config/brew/Brewfile" \
  'Phase 5 calls the profile Brewfile through brew bundle'
grep -Fxq 'profile=desktop' "$RECORD_DIR/bundle-environment" ||
  fail 'Phase 5 did not pass the desktop profile into Brewfile evaluation'
pass 'Phase 5 passes the selected profile to Brewfile evaluation'
grep -Fxq 'Applications: COMPLETE' "$RECORD_DIR/log" ||
  fail 'successful Phase 5 omitted its completion marker'
pass 'successful Phase 5 reports completion'
grep -Fxq '6' "$RECORD_DIR/checkpoint" ||
  fail 'successful Phase 5 did not reach the post-phase checkpoint seam'
pass 'successful Phase 5 reaches the post-phase checkpoint seam'

if run_phase5 fail; then
  fail 'failed brew bundle did not fail Phase 5'
fi
pass 'failed brew bundle fails Phase 5'
if grep -Fxq 'Applications: COMPLETE' "$RECORD_DIR/log"; then
  fail 'failed brew bundle still reported Applications completion'
fi
pass 'failed brew bundle omits the Applications completion marker'
if [[ -e "$RECORD_DIR/checkpoint" ]]; then
  fail 'failed brew bundle still reached the post-phase checkpoint seam'
fi
pass 'failed brew bundle prevents the post-phase checkpoint'

expected_assertions=46
[[ "$assertion_count" -eq "$expected_assertions" ]] ||
  fail "expected $expected_assertions assertions, observed $assertion_count"
printf '1..%d\n' "$assertion_count"
