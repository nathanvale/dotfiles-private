#!/usr/bin/env bash

# mise-config-review contract.
#
# Runs the production script under a test-owned HOME and proves it records the
# exact content digest the Husky guard looks up, is idempotent, never changes
# the config, refuses symlinked state or inputs, and records a changed file as a
# new digest. It does not run Mise.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(CDPATH='' cd -P "$(mktemp -d)" && pwd)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assertion_count=0
pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}
fail() {
  printf 'not ok - %s\n' "$1" >&2
  printf 'Bail out! %s\n' "$1"
  exit 1
}
assert_equals() {
  [[ "$1" == "$2" ]] || fail "$3 (expected [$2], got [$1])"
  pass "$3"
}
assert_contains() {
  grep -Fq -- "$2" <<<"$1" || fail "$3 (missing [$2] in [$1])"
  pass "$3"
}

HOME_FIXTURE="$TEST_ROOT/home"
LEDGER="$HOME_FIXTURE/.dotfiles_state/toolchain/reviewed-configs"
mkdir -p "$HOME_FIXTURE"
CONFIG="$TEST_ROOT/mise.toml"
printf '[tools]\nnode = "22.14.0"\n' >"$CONFIG"
DIGEST="$(shasum -a 256 "$CONFIG" | cut -d' ' -f1)"

review() {
  set +e
  out="$(env -i HOME="$HOME_FIXTURE" PATH=/usr/bin:/bin "$REPO_ROOT/bin/dotfiles/mise-config-review" "$@" 2>&1)"
  status=$?
  set -e
}

review
assert_equals "$status" '2' 'no argument is refused with usage status'
review "$TEST_ROOT/missing.toml"
assert_equals "$status" '2' 'a missing file is refused'
printf 'x' >"$TEST_ROOT/notes.txt"
review "$TEST_ROOT/notes.txt"
assert_equals "$status" '2' 'a non-TOML file is refused'
ln -s "$CONFIG" "$TEST_ROOT/link.toml"
review "$TEST_ROOT/link.toml"
assert_equals "$status" '2' 'a symlinked config is refused'

before="$(shasum -a 256 "$CONFIG")"
mkdir -p "$LEDGER"
outside_record="$TEST_ROOT/outside-review-record"
ln -s "$outside_record" "$LEDGER/$DIGEST"
review "$CONFIG"
assert_equals "$status" '1' 'a dangling digest-record symlink is refused'
assert_contains "$out" 'exists but is not a regular file' 'the digest-record refusal says why'
[[ ! -e "$outside_record" ]] || fail 'a dangling digest-record symlink wrote outside the ledger'
pass 'a refused digest-record symlink does not create its target'
[[ -L "$LEDGER/$DIGEST" ]] || fail 'the refused digest-record symlink was changed'
pass 'the refused digest-record symlink is retained for inspection'
rm "$LEDGER/$DIGEST"
review "$CONFIG"
assert_equals "$status" '0' 'a regular TOML file is recorded'
assert_contains "$out" "$DIGEST" 'the record names the exact content digest'
[[ -f "$LEDGER/$DIGEST" && ! -L "$LEDGER/$DIGEST" ]] || fail 'the digest record is not a regular file'
pass 'the ledger entry is a regular file named by the digest'
assert_equals "$(shasum -a 256 "$CONFIG")" "$before" 'the config is not modified'

review "$CONFIG"
assert_contains "$out" 'Already reviewed' 'a second run is idempotent'

printf '[env]\nX = "1"\n' >>"$CONFIG"
NEW="$(shasum -a 256 "$CONFIG" | cut -d' ' -f1)"
[[ ! -e "$LEDGER/$NEW" ]] || fail 'an edit was already reviewed'
pass 'an edited config has no review until it is recorded'
review "$CONFIG"
[[ -f "$LEDGER/$NEW" && -f "$LEDGER/$DIGEST" ]] || fail 'the edit was not recorded alongside the original'
pass 'an edit is recorded as its own digest'

mv "$HOME_FIXTURE/.dotfiles_state/toolchain" "$TEST_ROOT/moved-toolchain"
ln -s "$TEST_ROOT/moved-toolchain" "$HOME_FIXTURE/.dotfiles_state/toolchain"
review "$CONFIG"
assert_equals "$status" '1' 'a symlinked state directory is refused'
assert_contains "$out" 'is a symlink' 'the symlink refusal says why'

printf '%s tests passed\n' "$assertion_count"
