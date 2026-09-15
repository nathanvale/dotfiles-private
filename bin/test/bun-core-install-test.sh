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

# Independent oracle: the VM runner is host-only and its trust is item-scoped.
for vm_case in desktop-disabled server-enabled desktop-enabled; do
  case "$vm_case" in
    desktop-disabled)
      profile_name=desktop
      vm_host=0
      expected_softnet_row=''
      expected_tart_row=''
      ;;
    server-enabled)
      profile_name=server
      vm_host=1
      expected_softnet_row=''
      expected_tart_row=''
      ;;
    desktop-enabled)
      profile_name=desktop
      vm_host=1
      expected_softnet_row=$'openai/tools/softnet\ttrue'
      expected_tart_row=$'openai/tools/tart\ttrue'
      ;;
  esac

  brewfile_rows="$TEST_ROOT/brewfile-vm-$vm_case"
  HOMEBREW_DOTFILES_PROFILE="$profile_name" HOMEBREW_DOTFILES_VM_HOST="$vm_host" /usr/bin/ruby -e '
    def tap(*) end
    def cask(*) end
    def brew(name, *args)
      options = args.last.is_a?(Hash) ? args.last : {}
      puts "#{name}\t#{options.fetch(:trusted, false)}"
    end
    load ARGV.fetch(0)
  ' "$REPO_ROOT/config/brew/Brewfile" >"$brewfile_rows" ||
    fail "$vm_case Brewfile evaluation failed"

  if [[ -z "$expected_tart_row" ]]; then
    assert_exact_count 0 $'openai/tools/softnet\ttrue' "$brewfile_rows" \
      "$vm_case Brewfile omits the host-only Softnet dependency"
    assert_exact_count 0 $'openai/tools/tart\ttrue' "$brewfile_rows" \
      "$vm_case Brewfile omits the host-only Tart runner"
  else
    assert_exact_count 1 "$expected_softnet_row" "$brewfile_rows" \
      "$vm_case Brewfile emits one trusted Softnet dependency"
    assert_exact_count 1 "$expected_tart_row" "$brewfile_rows" \
      "$vm_case Brewfile emits one trusted Tart runner"
  fi
done

# Independent oracle: Homebrew 6 requires an explicit item-level trust grant
# before it will load a formula or cask from a non-official tap. The test owns
# the complete approved set so a new fully qualified dependency cannot inherit
# trust accidentally from a whole-tap grant.
brewfile_trust_probe="$TEST_ROOT/brewfile-trust-probe.rb"
cat >"$brewfile_trust_probe" <<'RUBY'
def record(type, name, args)
  options = args.last.is_a?(Hash) ? args.last : {}
  puts "#{type}\t#{name}\t#{options.fetch(:trusted, false)}"
end

def tap(name, *args)
  record("tap", name, args)
end

def brew(name, *args)
  record("brew", name, args)
end

def cask(name, *args)
  record("cask", name, args)
end

load ARGV.fetch(0)
RUBY
trusted_third_party_rows="$TEST_ROOT/brewfile-trusted-third-party"
HOMEBREW_DOTFILES_PROFILE=desktop HOMEBREW_DOTFILES_VM_HOST=1 \
  /usr/bin/ruby "$brewfile_trust_probe" "$REPO_ROOT/config/brew/Brewfile" >"$trusted_third_party_rows" ||
  fail 'desktop VM-host Brewfile trust evaluation failed'

expected_trusted_third_party_rows=(
  $'brew\tognistik/homebrew-formulae/macrowhisper\ttrue'
  $'brew\tsteipete/tap/mcporter\ttrue'
  $'brew\tsteipete/tap/peekaboo\ttrue'
  $'brew\tsteipete/tap/remindctl\ttrue'
  $'brew\tsteipete/tap/imsg\ttrue'
  $'brew\topenclaw/tap/gogcli\ttrue'
  $'brew\tanomalyco/tap/opencode\ttrue'
  $'brew\tk1LoW/tap/mo\ttrue'
  $'brew\topenai/tools/softnet\ttrue'
  $'brew\topenai/tools/tart\ttrue'
  $'cask\tsteipete/tap/codexbar\ttrue'
  $'cask\tsteipete/tap/trimmy\ttrue'
)
for trusted_row in "${expected_trusted_third_party_rows[@]}"; do
  assert_exact_count 1 "$trusted_row" "$trusted_third_party_rows" \
    "desktop VM-host Brewfile scopes trust to ${trusted_row//$'\t'/ }"
done

untrusted_third_party_rows="$(awk -F '\t' '$2 ~ /\// && $3 != "true" { print }' "$trusted_third_party_rows")"
[[ -z "$untrusted_third_party_rows" ]] ||
  fail "desktop VM-host Brewfile has untrusted third-party items [$untrusted_third_party_rows]"
pass 'desktop VM-host Brewfile has no untrusted third-party items'
explicit_third_party_taps="$(awk -F '\t' '$1 == "tap" { print $2 }' "$trusted_third_party_rows")"
[[ -z "$explicit_third_party_taps" ]] ||
  fail "desktop VM-host Brewfile loads whole third-party taps [$explicit_third_party_taps]"
pass 'desktop VM-host Brewfile relies on selected items instead of whole-tap loads'
trusted_third_party_flags="$TEST_ROOT/brewfile-trusted-third-party-flags"
awk -F '\t' '$2 ~ /\// { print $3 }' "$trusted_third_party_rows" >"$trusted_third_party_flags"
assert_exact_count 12 'true' "$trusted_third_party_flags" \
  'desktop VM-host Brewfile declares exactly twelve item-level trust grants'

# Homebrew also persists trust outside Brewfile evaluation. Keep the tracked
# seed at the same narrow boundary so a stale tap-wide grant cannot authorize a
# future item that is absent from the approved package table.
tracked_trust_rows="$TEST_ROOT/tracked-homebrew-trust"
/usr/bin/ruby -rjson -e '
  trust = JSON.parse(File.read(ARGV.fetch(0)))
  %w[trustedtaps trustedformulae trustedcasks].each do |kind|
    trust.fetch(kind).each { |name| puts "#{kind}\t#{name}" }
  end
' "$REPO_ROOT/config/homebrew/trust.json" >"$tracked_trust_rows" ||
  fail 'tracked Homebrew trust configuration is not valid JSON'

expected_tracked_trust_rows=(
  $'trustedformulae\tanomalyco/tap/opencode'
  $'trustedformulae\tk1low/tap/mo'
  $'trustedformulae\tognistik/formulae/macrowhisper'
  $'trustedformulae\topenai/tools/softnet'
  $'trustedformulae\topenai/tools/tart'
  $'trustedformulae\topenclaw/tap/gogcli'
  $'trustedformulae\tsteipete/tap/codexbar'
  $'trustedformulae\tsteipete/tap/imsg'
  $'trustedformulae\tsteipete/tap/mcporter'
  $'trustedformulae\tsteipete/tap/peekaboo'
  $'trustedformulae\tsteipete/tap/remindctl'
  $'trustedcasks\tsteipete/tap/codexbar'
  $'trustedcasks\tsteipete/tap/trimmy'
)
for trust_row in "${expected_tracked_trust_rows[@]}"; do
  assert_exact_count 1 "$trust_row" "$tracked_trust_rows" \
    "tracked Homebrew trust preserves ${trust_row//$'\t'/ }"
done
tracked_trust_count="$(wc -l <"$tracked_trust_rows" | tr -d '[:space:]')"
[[ "$tracked_trust_count" == "${#expected_tracked_trust_rows[@]}" ]] ||
  fail "tracked Homebrew trust contains extra entries (expected ${#expected_tracked_trust_rows[@]}, observed $tracked_trust_count)"
pass 'tracked Homebrew trust contains only the approved item entries'
tracked_tap_rows="$(awk -F '\t' '$1 == "trustedtaps" { print }' "$tracked_trust_rows")"
[[ -z "$tracked_tap_rows" ]] ||
  fail "tracked Homebrew trust grants whole taps [$tracked_tap_rows]"
pass 'tracked Homebrew trust grants no whole tap'

server_third_party_rows="$TEST_ROOT/brewfile-server-third-party"
HOMEBREW_DOTFILES_PROFILE=server HOMEBREW_DOTFILES_VM_HOST=0 \
  /usr/bin/ruby "$brewfile_trust_probe" "$REPO_ROOT/config/brew/Brewfile" >"$server_third_party_rows" ||
  fail 'server Brewfile trust evaluation failed'
server_untrusted_third_party_rows="$(awk -F '\t' '$2 ~ /\// && $3 != "true" { print }' "$server_third_party_rows")"
[[ -z "$server_untrusted_third_party_rows" ]] ||
  fail "server Brewfile has untrusted third-party items [$server_untrusted_third_party_rows]"
pass 'server Brewfile has no untrusted third-party items'
server_explicit_third_party_taps="$(awk -F '\t' '$1 == "tap" { print $2 }' "$server_third_party_rows")"
[[ -z "$server_explicit_third_party_taps" ]] ||
  fail "server Brewfile loads whole third-party taps [$server_explicit_third_party_taps]"
pass 'server Brewfile relies on selected items instead of whole-tap loads'

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
  bundle_attempt_file="$RECORD_DIR/bundle-attempt-count"
  bundle_attempt=0
  if [[ -f "$bundle_attempt_file" ]]; then
    bundle_attempt="$(<"$bundle_attempt_file")"
  fi
  bundle_attempt=$((bundle_attempt + 1))
  printf '%s\n' "$bundle_attempt" >"$bundle_attempt_file"
  bundle_result="$(awk -v attempt="$bundle_attempt" '{ if (NF >= attempt) print $attempt; else print $NF }' <<<"${BUNDLE_RESULTS:-success}")"
  printf 'attempt=%s profile=%s download_concurrency=%s vm_host=%s result=%s\n' "$bundle_attempt" "${HOMEBREW_DOTFILES_PROFILE:-unset}" "${HOMEBREW_DOWNLOAD_CONCURRENCY:-unset}" "${HOMEBREW_DOTFILES_VM_HOST:-unset}" "$bundle_result" >>"$RECORD_DIR/bundle-environment"
  [[ "$bundle_result" == success ]]
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
  elif [[ "$formula_name" == git ]]; then
    [[ -x "${CORE_STUB_BIN:-}/git" ]]
  else
    exit 1
  fi
  exit
fi

if [[ "$command_name" == unlink && "$formula_name" == git ]]; then
  rm -f "${CORE_STUB_BIN:-}/git"
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

phase3="$TEST_ROOT/phase-3.sh"
sed -n '/^    phase_3_core_tools() {$/,/^    }$/p' "$REPO_ROOT/setup.sh" |
  sed 's/^    //' >"$phase3"
[[ -s "$phase3" ]] || fail 'could not extract phase_3_core_tools from setup.sh'
grep -q '^phase_3_core_tools() {$' "$phase3" ||
  fail 'extracted Phase 3 does not define its function'
pass 'phase_3_core_tools is extracted from setup.sh'

run_phase3() {
  rm -rf "$RECORD_DIR"
  mkdir -p "$RECORD_DIR"
  env -i HOME="$TEST_ROOT/home" PATH="$STUB_BIN:/usr/bin:/bin" \
    RECORD_DIR="$RECORD_DIR" CORE_STUB_BIN="$STUB_BIN" \
    bash -c '
      set -euo pipefail
      log() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_warn() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_phase() { :; }
      source "$1"
      phase_3_core_tools
    ' _ "$phase3"
}

run_phase3 || fail 'Phase 3 run exited nonzero'
pass 'Phase 3 run exits zero'
assert_not_recorded $'install\tgit' \
  'Phase 3 preserves the selected macOS system Git owner'
assert_recorded $'install\tzsh' \
  'Phase 3 continues installing the remaining core tools'

cat >"$STUB_BIN/git" <<'STUB'
#!/bin/bash
printf 'homebrew git fixture\n'
STUB
chmod +x "$STUB_BIN/git"
run_phase3 || fail 'Phase 3 rerun with a linked Homebrew Git exited nonzero'
pass 'Phase 3 rerun with a linked Homebrew Git exits zero'
assert_recorded $'list\tgit' \
  'Phase 3 detects an already installed Homebrew Git formula'
assert_recorded $'unlink\tgit' \
  'Phase 3 unlinks an already linked Homebrew Git formula'
[[ ! -e "$STUB_BIN/git" ]] ||
  fail 'Phase 3 left the linked Homebrew Git executable in place'
pass 'Phase 3 removes the linked Homebrew Git executable'
grep -Fxq 'Git owner verified: /usr/bin/git' "$RECORD_DIR/log" ||
  fail 'Phase 3 did not verify the system Git owner after unlinking'
pass 'Phase 3 verifies Git resolves to /usr/bin/git after unlinking'

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
  local bundle_results="$1"
  rm -rf "$RECORD_DIR"
  mkdir -p "$RECORD_DIR"
  # The isolated child expands its supplied environment and receipt paths.
  # shellcheck disable=SC2016
  env -i HOME="$TEST_ROOT/home" PATH="$STUB_BIN:/usr/bin:/bin" \
    RECORD_DIR="$RECORD_DIR" BUNDLE_RESULTS="$bundle_results" \
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
grep -Fxq 'attempt=1 profile=desktop download_concurrency=1 vm_host=0 result=success' "$RECORD_DIR/bundle-environment" ||
  fail 'Phase 5 did not pass the desktop profile into Brewfile evaluation'
pass 'Phase 5 passes the selected profile to Brewfile evaluation'
grep -Fxq 'Profile package download concurrency: 1' "$RECORD_DIR/log" ||
  fail 'Phase 5 did not record serial Homebrew downloads'
pass 'Phase 5 records serial Homebrew downloads'
grep -Fxq 'Applications: COMPLETE' "$RECORD_DIR/log" ||
  fail 'successful Phase 5 omitted its completion marker'
pass 'successful Phase 5 reports completion'
grep -Fxq '6' "$RECORD_DIR/checkpoint" ||
  fail 'successful Phase 5 did not reach the post-phase checkpoint seam'
pass 'successful Phase 5 reaches the post-phase checkpoint seam'

run_phase5 'fail success' || fail 'second bundle attempt did not recover Phase 5'
pass 'first failed bundle and second successful bundle completes Phase 5'
assert_exact_count 2 $'bundle\t--file='"$FIXTURE_DOTFILES/config/brew/Brewfile" "$RECORD_DIR/brew-calls" \
  'Phase 5 retries the bundle exactly once after an initial failure'
grep -Fxq 'attempt=1 profile=desktop download_concurrency=1 vm_host=0 result=fail' "$RECORD_DIR/bundle-environment" ||
  fail 'Phase 5 records the failed first bundle attempt'
pass 'Phase 5 records the failed first bundle attempt'
grep -Fxq 'attempt=2 profile=desktop download_concurrency=1 vm_host=0 result=success' "$RECORD_DIR/bundle-environment" ||
  fail 'Phase 5 records the successful second bundle attempt'
pass 'Phase 5 records the successful second bundle attempt'
grep -Fxq 'Profile package bundle attempt 1 of 2 exited 1' "$RECORD_DIR/log" ||
  fail 'Phase 5 reports the first bundle failure before retrying'
pass 'Phase 5 reports the first bundle failure before retrying'
grep -Fxq 'Profile package bundle attempt 2 of 2 exited 0' "$RECORD_DIR/log" ||
  fail 'Phase 5 reports the successful retry exit status'
pass 'Phase 5 reports the successful retry exit status'
grep -Fxq 'Applications: COMPLETE' "$RECORD_DIR/log" ||
  fail 'successful retry omitted the Applications completion marker'
pass 'successful retry reports Applications completion'
grep -Fxq '6' "$RECORD_DIR/checkpoint" ||
  fail 'successful retry did not reach the post-phase checkpoint seam'
pass 'successful retry reaches the post-phase checkpoint seam'

if run_phase5 'fail fail'; then
  fail 'two failed brew bundle attempts did not fail Phase 5'
fi
pass 'two failed brew bundle attempts fail Phase 5'
assert_exact_count 2 $'bundle\t--file='"$FIXTURE_DOTFILES/config/brew/Brewfile" "$RECORD_DIR/brew-calls" \
  'two failed bundle attempts stop at the retry bound'
grep -Fxq 'Profile package bundle attempt 2 of 2 exited 1' "$RECORD_DIR/log" ||
  fail 'Phase 5 reports the final bundle failure exit status'
pass 'Phase 5 reports the final bundle failure exit status'
grep -Fxq "Retry: HOMEBREW_DOWNLOAD_CONCURRENCY=1 HOMEBREW_DOTFILES_PROFILE=desktop HOMEBREW_DOTFILES_VM_HOST=0 brew bundle --file=$FIXTURE_DOTFILES/config/brew/Brewfile" "$RECORD_DIR/log" ||
  fail 'two failed bundle attempts preserve the manual repair command'
pass 'two failed bundle attempts preserve the manual repair command'
if grep -Fxq 'Applications: COMPLETE' "$RECORD_DIR/log"; then
  fail 'two failed brew bundle attempts still reported Applications completion'
fi
pass 'two failed bundle attempts omit the Applications completion marker'
if [[ -e "$RECORD_DIR/checkpoint" ]]; then
  fail 'two failed brew bundle attempts still reached the post-phase checkpoint seam'
fi
pass 'two failed bundle attempts prevent the post-phase checkpoint'

expected_assertions=105
[[ "$assertion_count" -eq "$expected_assertions" ]] ||
  fail "expected $expected_assertions assertions, observed $assertion_count"
printf '1..%d\n' "$assertion_count"
