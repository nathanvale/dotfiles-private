#!/usr/bin/env bash

# Claude Code native-install contract.
#
# Proves that fresh-machine setup Phase 2 (AI Rescue) installs the Claude Code
# CLI through the native installer, skips installation when a claude binary is
# already reachable, records the ai_rescue_ready marker on success, stays
# non-fatal when the installer fails, and never invokes or recommends Homebrew
# for the Claude Code CLI. The Homebrew cask named claude is the separate GUI
# app and is outside this contract.
#
# The production consumer is a fresh Mac running setup.sh before any symlink or
# shell configuration exists. Every behavioural row drives the phase function
# extracted verbatim from setup.sh inside a real bash child under env -i with a
# hermetic HOME, so no row can touch this machine's Homebrew, network, or live
# claude install. The oracles are the argv recorded by a stub curl, the
# invocation record of a stub brew, the claude executable the stub installer
# plants under the hermetic ~/.local/bin, the ai_rescue_ready marker read back
# independently, the child's exit status, and the captured log lines.
#
# Single quotes around the bash -c probe body are load-bearing: its expansions
# must happen in the child, not in this shell.
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
# The phase under test.
# ---------------------------------------------------------------------------
#
# phase_2_ai_rescue is extracted from setup.sh rather than re-implemented, so
# this file cannot drift into testing its own copy of the logic. Extraction is
# asserted non-empty and shape-checked: an empty extraction would let every row
# below pass vacuously.
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

# ---------------------------------------------------------------------------
# Harness.
# ---------------------------------------------------------------------------
#
# The stub curl records its argv and emits a fake installer script on stdout,
# so the pipe into bash plants a claude executable in the same durable place
# the real installer does. CURL_MODE=fail exercises the failure branch. The
# stub brew records any invocation and fails: Phase 2 reaching for Homebrew in
# any way is the defect this contract exists to refuse.
phase_home="$TEST_ROOT/phase-home"
stub_bin="$TEST_ROOT/stub-bin"
record_dir="$TEST_ROOT/records"
mkdir -p "$stub_bin"

cat >"$stub_bin/curl" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" >"$RECORD_DIR/curl-argv"
if [[ "${CURL_MODE:-ok}" == fail ]]; then
  exit 22
fi
printf 'mkdir -p "$HOME/.local/bin"\n'
printf 'printf "#!/bin/sh\\nexit 0\\n" >"$HOME/.local/bin/claude"\n'
printf 'chmod +x "$HOME/.local/bin/claude"\n'
STUB
chmod +x "$stub_bin/curl"

cat >"$stub_bin/brew" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" >>"$RECORD_DIR/brew-calls"
exit 1
STUB
chmod +x "$stub_bin/brew"

# Optional --preinstalled plants a claude executable in the hermetic
# ~/.local/bin before the run; optional --fail-install makes the stub curl
# fail. The stub loggers keep every log line inspectable without reproducing
# setup.sh's colour and timestamp machinery.
run_phase() {
  local preinstalled=0 curl_mode=ok
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --preinstalled) preinstalled=1 ;;
      --fail-install) curl_mode=fail ;;
    esac
    shift
  done
  rm -rf "$phase_home" "$record_dir"
  mkdir -p "$phase_home/state" \
    "$phase_home/.codex/packages/standalone/current" "$record_dir"
  # Keep the managed Codex contract out of this Claude-specific lane.
  printf '#!/bin/sh\nexit 0\n' \
    >"$phase_home/.codex/packages/standalone/current/codex"
  chmod +x "$phase_home/.codex/packages/standalone/current/codex"
  if [[ "$preinstalled" -eq 1 ]]; then
    mkdir -p "$phase_home/.local/bin"
    printf '#!/bin/sh\nexit 0\n' >"$phase_home/.local/bin/claude"
    chmod +x "$phase_home/.local/bin/claude"
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
  if grep -qi 'brew' "$record_dir/log"; then
    fail "$label recommended brew (route the CLI through the native installer)"
  fi
  pass "$label neither invoked nor recommended Homebrew"
}

# ---------------------------------------------------------------------------
# Fresh machine: no claude anywhere.
# ---------------------------------------------------------------------------
run_phase || fail 'fresh run exited nonzero'
pass 'fresh run exits zero'

[[ -f "$record_dir/curl-argv" ]] || fail 'fresh run did not invoke the native installer'
assert_equals "$(cat "$record_dir/curl-argv")" '-fsSL
https://claude.ai/install.sh' 'fresh run fetches the native installer with the expected argv'

[[ -x "$phase_home/.local/bin/claude" ]] ||
  fail 'fresh run did not leave an executable claude under ~/.local/bin'
pass 'fresh run leaves an executable claude under ~/.local/bin'

assert_equals "$(cat "$phase_home/state/ai_rescue_ready" 2>/dev/null)" 'ai_rescue_ready' \
  'fresh run records the ai_rescue_ready marker'

refuse_brew 'fresh run'

# ---------------------------------------------------------------------------
# Already installed: a second run must change nothing.
# ---------------------------------------------------------------------------
run_phase --preinstalled || fail 'preinstalled run exited nonzero'
pass 'preinstalled run exits zero'

[[ ! -e "$record_dir/curl-argv" ]] ||
  fail 'preinstalled run re-invoked the installer instead of skipping'
pass 'preinstalled run skips the installer'

grep -Fq 'Claude Code already installed' "$record_dir/log" ||
  fail 'preinstalled run did not report the skip'
pass 'preinstalled run reports the skip'

assert_equals "$(cat "$phase_home/state/ai_rescue_ready" 2>/dev/null)" 'ai_rescue_ready' \
  'preinstalled run still records the ai_rescue_ready marker'

refuse_brew 'preinstalled run'

# ---------------------------------------------------------------------------
# Installer failure: non-fatal, and the guidance stays native.
# ---------------------------------------------------------------------------
run_phase --fail-install || fail 'failed-install run exited nonzero (must be non-fatal)'
pass 'failed-install run stays non-fatal'

[[ ! -e "$phase_home/state/ai_rescue_ready" ]] ||
  fail 'failed-install run recorded the ai_rescue_ready marker anyway'
pass 'failed-install run records no ai_rescue_ready marker'

grep -Fq 'You can install it later: curl -fsSL https://claude.ai/install.sh | bash' \
  "$record_dir/log" ||
  fail 'failed-install run does not point at the native installer'
pass 'failed-install run points at the native installer'

refuse_brew 'failed-install run'

# ---------------------------------------------------------------------------
# First-run verifier: the native install path is usable before shell startup.
# ---------------------------------------------------------------------------
#
# Setup's final verifier is a child process. Keep ~/.local/bin out of its
# inherited PATH and observe the real verifier against two independent HOME
# fixtures: one without Claude, and one containing only the native installer
# output. The first case keeps the warning meaningful; the second proves that
# the verifier recognizes the canonical executable without mutating PATH.
verifier_root="$TEST_ROOT/verifier"
verifier_dotfiles="$verifier_root/dotfiles"
verifier_without_claude_home="$verifier_root/home-without-claude"
verifier_with_claude_home="$verifier_root/home-with-claude"
verifier_with_claude_directory_home="$verifier_root/home-with-claude-directory"
mkdir -p "$verifier_dotfiles" "$verifier_without_claude_home" \
  "$verifier_with_claude_home/.local/bin" \
  "$verifier_with_claude_directory_home/.local/bin/claude"
cp "$REPO_ROOT/verify_install.sh" "$verifier_dotfiles/verify_install.sh"
chmod +x "$verifier_dotfiles/verify_install.sh"
printf '#!/bin/sh\nexit 0\n' \
  >"$verifier_with_claude_home/.local/bin/claude"
chmod +x "$verifier_with_claude_home/.local/bin/claude"

run_verifier() {
  local home="$1"
  set +e
  verifier_output="$(env -i HOME="$home" PATH=/usr/bin:/bin DOTFILES_PROFILE=desktop \
    "$verifier_dotfiles/verify_install.sh" --verbose --machine-summary 2>&1)"
  verifier_exit=$?
  set -e
  verifier_output="$(sed -E $'s/\033\\[[0-9;]*[[:alpha:]]//g' <<<"$verifier_output")"
}

run_verifier "$verifier_without_claude_home"
grep -Fq '⚠ Claude Code' <<<"$verifier_output" ||
  fail 'verifier keeps the Claude warning when no executable is installed'
pass 'verifier keeps the Claude warning when no executable is installed'
grep -Fq '⚠ AI rescue marker' <<<"$verifier_output" ||
  fail 'verifier keeps the rescue-marker warning when Claude is unavailable'
pass 'verifier keeps the rescue-marker warning when Claude is unavailable'

run_verifier "$verifier_with_claude_home"
if grep -Fq '⚠ Claude Code' <<<"$verifier_output"; then
  fail 'verifier does not warn for Claude installed at ~/.local/bin'
fi
pass 'verifier accepts Claude installed at ~/.local/bin before shell startup'
if grep -Fq '⚠ AI rescue marker' <<<"$verifier_output"; then
  fail 'verifier does not warn about the rescue marker when Claude is available'
fi
pass 'verifier suppresses the rescue-marker warning when Claude is available'

run_verifier "$verifier_with_claude_directory_home"
grep -Fq '⚠ Claude Code' <<<"$verifier_output" ||
  fail 'verifier rejects an executable directory at ~/.local/bin/claude'
pass 'verifier rejects an executable directory at ~/.local/bin/claude'
grep -Fq '⚠ AI rescue marker' <<<"$verifier_output" ||
  fail 'verifier keeps the rescue-marker warning for a Claude directory placeholder'
pass 'verifier keeps the rescue-marker warning for a Claude directory placeholder'

# ---------------------------------------------------------------------------
# Repair guidance text.
# ---------------------------------------------------------------------------
#
# verify_install.sh's fix strings are output data, so the text layer is the
# honest ceiling here: its live checks read this machine's real state and
# cannot run hermetically. Any claude-code mention in either executable is a
# Homebrew cask route; the native world names the binary claude.
for owner in setup.sh verify_install.sh; do
  if grep -q 'claude-code' "$REPO_ROOT/$owner"; then
    fail "$owner still names the claude-code cask (route the CLI through the native installer)"
  fi
  pass "$owner carries no Homebrew route for the Claude Code CLI"
done

native_fix_count="$(grep -Fc 'Fix: curl -fsSL https://claude.ai/install.sh | bash' \
  "$REPO_ROOT/verify_install.sh" || true)"
assert_equals "$native_fix_count" '2' \
  'verify_install.sh recommends the native installer at both Claude Code fix sites'

printf '1..%d\n' "$assertion_count"
