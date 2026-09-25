#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass_count=0

pass() {
  pass_count=$((pass_count + 1))
  printf 'ok %d - %s\n' "$pass_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  # A failure ends the stream early, so tell the TAP consumer the run stopped
  # deliberately rather than truncating; the diagnostic above stays on stderr.
  printf 'Bail out! %s\n' "$1"
  exit 1
}

assert_contains() {
  local value="$1"
  local expected="$2"
  local label="$3"
  [[ "$value" == *"$expected"* ]] || fail "$label"
  pass "$label"
}

assert_not_contains() {
  local value="$1"
  local unexpected="$2"
  local label="$3"
  [[ "$value" != *"$unexpected"* ]] || fail "$label"
  pass "$label"
}

# Exact whole-line match, for oracles like the launchctl call log where a
# substring would also accept a superset call (e.g. `unsetenv FOO_BAR` matching
# a search for `unsetenv FOO`).
assert_has_line() {
  local value="$1"
  local expected="$2"
  local label="$3"
  grep -Fqx -- "$expected" <<<"$value" || fail "$label"
  pass "$label"
}

home="$TEST_ROOT/home"
mkdir -p "$home/code/dotfiles" "$home/bin"
cp "$REPO_ROOT/.zshenv" "$home/.zshenv"
printf 'export OP_SERVICE_ACCOUNT_TOKEN="ops_TEST_SENTINEL"\n' >"$home/code/dotfiles/.env"

# The nested zsh evaluates the environment expression.
# shellcheck disable=SC2016
startup_output="$(env -i HOME="$home" PATH="/usr/bin:/bin" ZDOTDIR="$home" /bin/zsh -c '
  if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    printf "service_token_present=yes\n"
  else
    printf "service_token_present=no\n"
  fi
')"
assert_contains "$startup_output" 'service_token_present=no' 'zsh startup receives no service token'
assert_not_contains "$(<"$REPO_ROOT/.zshenv")" 'code/dotfiles/.env' '.zshenv never sources the token file'

assert_not_contains "$(<"$REPO_ROOT/.zshrc")" 'load-secrets()' 'no load-secrets function sources secrets into a shell'
assert_not_contains "$(<"$REPO_ROOT/.zshrc")" '.env.1password' '.zshrc never references the retired plain-text store'

# ---------------------------------------------------------------------------
# GUI (launchd) environment projection is an allowlist.
# ---------------------------------------------------------------------------
#
# This helper publishes values into the launchd session, where they outlive the
# shell that set them and are visible to every GUI process. It previously used a
# denylist: it skipped OP_SERVICE_ACCOUNT_TOKEN and projected every other
# `export` in dotfiles/.env. That fails open, so any credential added to that
# file later was published without anyone editing the helper.
#
# The contract is now an allowlist, and the rows below are written so that
# reverting to a denylist fails them. The oracle is the argv the helper actually
# handed to launchctl, captured through a stub on PATH; nothing here asserts on
# the helper's source text, and no projected value is ever printed.
#
# The fixture holds sentinel strings, not credentials. The token-shaped name is
# present precisely because it must be refused.
sync_block="$TEST_ROOT/sync-launchctl-env.zsh"
sed -n '/^typeset -ga DOTFILES_LAUNCHCTL_ALLOWLIST/,/^}/p' "$REPO_ROOT/.zshrc" >"$sync_block"
[[ -s "$sync_block" ]] || fail 'could not extract the launchctl projection helper from .zshrc'
grep -q '^sync-launchctl-env()' "$sync_block" || fail 'extracted block does not contain the helper'
pass 'the launchctl projection helper is extracted with its allowlist'

# One allowlisted name, one ordinary non-secret name that is NOT allowlisted, and
# two credential-shaped names. Under a denylist the middle two would both be
# projected; under an allowlist only the first is.
printf 'export DOTFILES_PROFILE="desktop"\nexport UNLISTED_CANARY="unlisted-value"\nexport OP_SERVICE_ACCOUNT_TOKEN="ops_TEST_SENTINEL"\nexport SOME_NEW_API_KEY="key_TEST_SENTINEL"\n' >"$home/code/dotfiles/.env"
cat >"$home/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "${1:-}" "${2:-}" >>"$LAUNCHCTL_CALLS"
EOF
chmod +x "$home/bin/launchctl"
: >"$TEST_ROOT/launchctl-calls"
LAUNCHCTL_CALLS="$TEST_ROOT/launchctl-calls" HOME="$home" PATH="$home/bin:/usr/bin:/bin" \
  /bin/zsh -c 'source "$1"; sync-launchctl-env >/dev/null' _ "$sync_block"
launchctl_calls="$(<"$TEST_ROOT/launchctl-calls")"

assert_has_line "$launchctl_calls" 'unsetenv OP_SERVICE_ACCOUNT_TOKEN' 'launchctl helper clears a stale service token'

# Positive control. Without it, a helper that projected nothing at all would
# satisfy every refusal row below while quietly breaking GUI configuration.
assert_has_line "$launchctl_calls" 'setenv DOTFILES_PROFILE' 'launchctl helper projects an allowlisted non-secret name'

# The allowlist claim. A name absent from the list is not projected even though
# it is neither secret-shaped nor denied anywhere. This is the row that a
# denylist cannot pass.
if grep -Fqx 'setenv UNLISTED_CANARY' <<<"$launchctl_calls"; then
  fail 'launchctl helper refuses a name that is not on the allowlist'
fi
pass 'launchctl helper refuses a name that is not on the allowlist'

if grep -Fqx 'setenv OP_SERVICE_ACCOUNT_TOKEN' <<<"$launchctl_calls"; then
  fail 'launchctl helper refuses the service token'
fi
pass 'launchctl helper refuses the service token'

# A credential added to the env file later must not be projected without a
# deliberate edit to the allowlist. This is the fail-open defect made concrete.
if grep -Fqx 'setenv SOME_NEW_API_KEY' <<<"$launchctl_calls"; then
  fail 'launchctl helper refuses a newly added credential-bearing name'
fi
pass 'launchctl helper refuses a newly added credential-bearing name'

# The helper runs in the caller's interactive shell, so it must leave that
# shell's parameters alone. `local` in zsh is dynamically scoped: a loop
# variable the function never declares is written in the caller and outlives the
# call. `name` iterates the allowlist, so an undeclared `name` leaves the last
# compared allowlist entry sitting in the shell, where a later command reading
# `${name}` picks up the residue.
#
# The oracle is the caller's own parameter state, read before and after the
# call. The `before` read proves the child started clean, so a pass cannot come
# from a variable that was never going to be set. `${name-UNSET}` uses the
# unset-only default: a leaked-but-empty `name` still counts as a leak.
: >"$TEST_ROOT/launchctl-calls"
printf 'export DOTFILES_PROFILE="desktop"\n' >"$home/code/dotfiles/.env"
caller_scope="$(LAUNCHCTL_CALLS="$TEST_ROOT/launchctl-calls" HOME="$home" PATH="$home/bin:/usr/bin:/bin" \
  /bin/zsh -c '
    source "$1"
    printf "before=[%s]\n" "${name-UNSET}"
    sync-launchctl-env >/dev/null
    printf "after=[%s]\n" "${name-UNSET}"
  ' _ "$sync_block")"
assert_contains "$caller_scope" 'before=[UNSET]' 'caller shell has no name parameter before the helper runs'
assert_contains "$caller_scope" 'after=[UNSET]' 'launchctl helper leaks no name parameter into the caller shell'

# Restore the multi-name fixture for any later row.
printf 'export DOTFILES_PROFILE="desktop"\nexport UNLISTED_CANARY="unlisted-value"\nexport OP_SERVICE_ACCOUNT_TOKEN="ops_TEST_SENTINEL"\nexport SOME_NEW_API_KEY="key_TEST_SENTINEL"\n' >"$home/code/dotfiles/.env"

# The stale projection is cleared before any read, so a machine whose env file
# has gone missing still loses a value the retired denylist had published.
: >"$TEST_ROOT/launchctl-calls"
LAUNCHCTL_CALLS="$TEST_ROOT/launchctl-calls" HOME="$home" PATH="$home/bin:/usr/bin:/bin" \
  /bin/zsh -c 'rm -f "$HOME/code/dotfiles/.env"; source "$1"; sync-launchctl-env >/dev/null 2>&1 || true' _ "$sync_block"
assert_has_line "$(<"$TEST_ROOT/launchctl-calls")" 'unsetenv OP_SERVICE_ACCOUNT_TOKEN' \
  'launchctl helper clears a stale service token even with no env file'

# Startup holds no credential delivery lane. The retired shape read a secrets
# file from the account-switch config and put its values into every zsh
# process, which an agent harness then captured. The behavioural proof that it
# is gone lives in the work-profile boundary contract, which starts a real
# child against a fixture secrets file in both its plain and its `op://`
# shapes and asserts the sentinel never reaches the child's environment.
# Contract: bin/test/zsh-work-profile-boundary-test.sh

example_text="$(<"$REPO_ROOT/.env.example")"
assert_contains "$example_text" 'bin/with-one-password-token' 'example names the scoped token owner'
assert_contains "$example_text" 'Never source .env' 'example forbids ambient token sourcing'

printf '1..%d\n' "$pass_count"
