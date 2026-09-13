#!/usr/bin/env bash

# Managed Codex installation contract.
#
# A fresh setup must install Codex through the OpenAI-managed standalone path,
# even when an unrelated codex executable is already on PATH. The real network
# payload and this machine's live installation stay outside the harness.

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
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

phase="$TEST_ROOT/phase-2.sh"
sed -n '/^    phase_2_ai_rescue() {$/,/^    }$/p' "$REPO_ROOT/setup.sh" |
  sed 's/^    //' >"$phase"
[[ -s "$phase" ]] || fail 'could not extract phase_2_ai_rescue from setup.sh'
grep -q '^phase_2_ai_rescue() {$' "$phase" ||
  fail 'extracted phase does not define its function'
pass 'phase_2_ai_rescue is extracted from setup.sh'

# The phase now publishes its readiness marker through the production atomic
# state writer. Load the exact helper definitions beside the extracted phase,
# and fail closed if a source refactor makes any dependency disappear.
state_helpers="$TEST_ROOT/state-helpers.sh"
{
  sed -n '/^    state_file_is_safe() {$/,/^    }$/p' "$REPO_ROOT/setup.sh"
  sed -n '/^    atomic_publish_file() {$/,/^    }$/p' "$REPO_ROOT/setup.sh"
  sed -n '/^    atomic_write_state_text() {$/,/^    }$/p' "$REPO_ROOT/setup.sh"
} | sed 's/^    //' >"$state_helpers"
[[ -s "$state_helpers" ]] || fail 'could not extract Phase 2 state helpers from setup.sh'
for helper in state_file_is_safe atomic_publish_file atomic_write_state_text; do
  grep -q "^${helper}() {$" "$state_helpers" ||
    fail "extracted state helpers do not define $helper"
done
pass 'Phase 2 loads production atomic state helpers from setup.sh'

phase_home="$TEST_ROOT/phase-home"
stub_bin="$TEST_ROOT/stub-bin"
record_dir="$TEST_ROOT/records"
mkdir -p "$stub_bin"

cat >"$stub_bin/curl" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" >"$RECORD_DIR/codex-curl-argv"
if [[ "${CURL_MODE:-ok}" == fail ]]; then
  exit 22
fi
printf 'mkdir -p "$HOME/.codex/packages/standalone/current" "$HOME/.local/bin"\n'
printf 'printf "#!/bin/sh\\nexit 0\\n" >"$HOME/.codex/packages/standalone/current/codex"\n'
printf 'chmod +x "$HOME/.codex/packages/standalone/current/codex"\n'
printf 'ln -s "$HOME/.codex/packages/standalone/current/codex" "$HOME/.local/bin/codex"\n'
STUB
chmod +x "$stub_bin/curl"

cat >"$stub_bin/brew" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" >>"$RECORD_DIR/brew-calls"
exit 1
STUB
chmod +x "$stub_bin/brew"

# This executable is the Homebrew near miss: command discovery can find Codex,
# but the fixed managed path is absent until the standalone installer runs.
cat >"$stub_bin/codex" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$stub_bin/codex"

run_phase() {
  local managed=0 curl_mode=ok
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --managed) managed=1 ;;
      --fail-install) curl_mode=fail ;;
    esac
    shift
  done

  rm -rf "$phase_home" "$record_dir"
  mkdir -p "$phase_home/.local/bin" "$phase_home/state" "$record_dir"

  # Keep the existing Claude contract out of this lane.
  printf '#!/bin/sh\nexit 0\n' >"$phase_home/.local/bin/claude"
  chmod +x "$phase_home/.local/bin/claude"

  if [[ "$managed" -eq 1 ]]; then
    mkdir -p "$phase_home/.codex/packages/standalone/current"
    printf '#!/bin/sh\nexit 0\n' \
      >"$phase_home/.codex/packages/standalone/current/codex"
    chmod +x "$phase_home/.codex/packages/standalone/current/codex"
  fi

  env -i HOME="$phase_home" PATH="$stub_bin:/usr/bin:/bin" \
    RECORD_DIR="$record_dir" CURL_MODE="$curl_mode" \
    bash -c '
      set -euo pipefail
      STATE_DIR="$HOME/state"
      log() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_warn() { printf "%s\n" "$1" >>"$RECORD_DIR/log"; }
      log_phase() { :; }
      source "$2"
      source "$1"
      phase_2_ai_rescue
    ' _ "$phase" "$state_helpers"
}

refuse_brew() {
  local label="$1"
  [[ ! -e "$record_dir/brew-calls" ]] || fail "$label invoked brew"
  grep -qi 'brew.*codex\|codex.*brew' "$record_dir/log" &&
    fail "$label recommended Homebrew for Codex"
  pass "$label carries no Homebrew Codex route"
}

run_phase || fail 'fresh managed-Codex run exited nonzero'
pass 'fresh run exits zero despite the PATH near miss'

[[ -f "$record_dir/codex-curl-argv" ]] ||
  fail 'fresh run skipped the managed installer because codex was on PATH'
assert_equals "$(cat "$record_dir/codex-curl-argv")" '-fsSL
https://chatgpt.com/codex/install.sh' \
  'fresh run fetches the managed installer with the expected argv'

[[ -x "$phase_home/.codex/packages/standalone/current/codex" ]] ||
  fail 'fresh run did not leave the fixed managed Codex executable'
pass 'fresh run leaves the fixed managed Codex executable'

[[ -L "$phase_home/.local/bin/codex" ]] ||
  fail 'fresh run did not leave the user-facing Codex symlink'
pass 'fresh run leaves the user-facing Codex symlink'

refuse_brew 'fresh run'

run_phase --managed || fail 'managed preinstalled run exited nonzero'
pass 'managed preinstalled run exits zero'

[[ ! -e "$record_dir/codex-curl-argv" ]] ||
  fail 'managed preinstalled run re-invoked the installer'
pass 'managed preinstalled run skips the installer'

grep -Fq 'Managed Codex already installed' "$record_dir/log" ||
  fail 'managed preinstalled run did not report the skip'
pass 'managed preinstalled run reports the skip'

refuse_brew 'managed preinstalled run'

run_phase --fail-install || fail 'failed managed install must stay non-fatal'
pass 'failed managed install stays non-fatal'

[[ ! -e "$phase_home/.codex/packages/standalone/current/codex" ]] ||
  fail 'failed managed install left a managed executable'
pass 'failed managed install leaves no managed executable'

grep -Fq 'You can install it later: curl -fsSL https://chatgpt.com/codex/install.sh | sh' \
  "$record_dir/log" || fail 'failed run does not point at the managed installer'
pass 'failed run points at the managed installer'

refuse_brew 'failed managed install'

for owner in setup.sh verify_install.sh config/brew/Brewfile; do
  if grep -Eq 'brew( install)?[^\n]*codex|cask "codex"' "$REPO_ROOT/$owner"; then
    fail "$owner still carries a Homebrew Codex CLI route"
  fi
  pass "$owner carries no Homebrew Codex CLI route"
done

managed_fix_count="$(grep -Fc \
  'Fix: curl -fsSL https://chatgpt.com/codex/install.sh | sh' \
  "$REPO_ROOT/verify_install.sh" || true)"
assert_equals "$managed_fix_count" '1' \
  'verify_install.sh names one managed Codex repair route'

printf '1..%d\n' "$assertion_count"
