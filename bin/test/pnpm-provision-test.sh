#!/usr/bin/env bash

# pnpm-provision contract.
#
# Runs the production script under a test-owned HOME with an applied Mise state
# and a fake mise. The fake records its arguments, working directory, and the
# configuration it was given, and installs a fake pnpm; the suite proves the
# input validation, the isolated-config install, the idempotent skip, and the
# refusal of a result that is not the requested version. It does not download
# anything or prove a real Mise install.

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
FAKE_BIN="$TEST_ROOT/fake-bin"
RECORDS="$TEST_ROOT/records"
REVISION_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
REVISION_DIR="$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID"
INSTALLS="$HOME_FIXTURE/.local/share/mise/installs"
mkdir -p "$HOME_FIXTURE/.config/mise" "$FAKE_BIN" "$RECORDS" "$REVISION_DIR" \
  "$HOME_FIXTURE/.local/share/mise/shims"
cp "$REPO_ROOT/config/mise/bootstrap.sh" "$HOME_FIXTURE/.config/mise/bootstrap.sh"
printf '[tools]\n' >"$REVISION_DIR/config.toml"
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"

# The fake installs a pnpm that, like pnpm, refuses in any directory below a
# package.json, and otherwise reports FAKE_INSTALLED_VERSION (default: the
# requested one) and records how Mise was called.
cat >"$FAKE_BIN/mise" <<'STUB'
#!/bin/sh
# The provisioner scrubs the environment, so records live beside the fake.
RECORDS=${0%/*}/../records
{
  printf 'args=%s\n' "$*"
  printf 'cwd=%s\n' "$PWD"
  printf 'config=%s\n' "$MISE_GLOBAL_CONFIG_FILE"
  printf 'config_bytes=%s\n' "$(wc -c <"$MISE_GLOBAL_CONFIG_FILE" | tr -d ' ')"
  printf 'ceiling=%s\n' "$MISE_CEILING_PATHS"
  printf 'home=%s\n' "$HOME"
  printf 'system=%s\n' "${MISE_SYSTEM_CONFIG_FILE:-unset}"
  printf 'selectors=%s\n' "$(env | grep -E '^(MISE_|XDG_)' | grep -vE '^MISE_(DATA|INSTALLS|SHIMS)_DIR=' | sort | tr '\n' ' ')"
} >>"$RECORDS/mise-calls"
[ "${1:-}" = install ] || exit 0
# A failing install (network, checksum) is simulated by a marker file.
if [ -e "$RECORDS/fail-install" ]; then
  printf 'mise ERROR checksum mismatch\n' >&2
  exit 1
fi
shift
force=false
if [ "${1:-}" = --force ]; then
  force=true
  shift
fi
version=${1#pnpm@}
# Like real Mise: a version directory that exists counts as installed and is
# skipped unless --force asks for a reinstall.
if [ -d "$MISE_INSTALLS_DIR/pnpm/$version" ] && [ "$force" = false ]; then
  printf 'mise pnpm@%s already installed\n' "$version" >&2
  exit 0
fi
mkdir -p "$MISE_INSTALLS_DIR/pnpm/$version"
cat >"$MISE_INSTALLS_DIR/pnpm/$version/pnpm" <<PNPM
#!/bin/sh
dir=\$PWD
while :; do
  if [ -e "\$dir/package.json" ]; then
    printf ' ERROR  This project is configured to use bun\\n' >&2
    exit 1
  fi
  [ "\$dir" = / ] && break
  dir=\${dir%/*}
  [ -n "\$dir" ] || dir=/
done
printf '%s\n' "\${FAKE_INSTALLED_VERSION:-$version}"
PNPM
chmod +x "$MISE_INSTALLS_DIR/pnpm/$version/pnpm"
STUB
chmod +x "$FAKE_BIN/mise"

# Callers run it from a checkout; the default one pins a different manager,
# as a dotfiles checkout does (bun@1.4.0).
CALLER="$TEST_ROOT/caller"
mkdir -p "$CALLER"
printf '{"packageManager":"bun@1.4.0"}\n' >"$CALLER/package.json"

# The applied shim chain is how the provisioner finds Mise, as the real shims do.
ln -s "$FAKE_BIN/mise" "$HOME_FIXTURE/.local/share/mise/shims/node"

run_provision() {
  set +e
  out="$(cd "$CALLER" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" RECORDS="$RECORDS" "$@" \
    "$REPO_ROOT/bin/dotfiles/pnpm-provision" "$ARG" 2>&1)"
  status=$?
  set -e
}

for ARG in '' 10.32 v10.32.1 '10.32.1;touch' latest; do
  run_provision
  assert_equals "$status" '2' "argument [$ARG] is refused with usage status"
done
[[ ! -e "$RECORDS/mise-calls" ]] || fail 'a refused argument reached Mise'
pass 'refused arguments never reach Mise'

ARG=10.32.1
run_provision
assert_equals "$status" '0' 'a fresh exact version installs'
assert_contains "$out" "provisioned at $INSTALLS/pnpm/10.32.1/pnpm" 'the install names the bound path'
calls="$(cat "$RECORDS/mise-calls")"
assert_contains "$calls" 'args=install pnpm@10.32.1' 'Mise installs exactly the requested pnpm'
assert_contains "$calls" 'config_bytes=0' 'the install reads an empty private configuration'
grep -Fq "cwd=$HOME_FIXTURE" <<<"$calls" && fail 'the install ran from HOME'
grep -Fq "config=$HOME_FIXTURE/.dotfiles_state" <<<"$calls" && fail 'the install used the selected revision config'
pass 'the install touches neither HOME nor the selected revision config'

: >"$RECORDS/mise-calls"
run_provision
assert_equals "$status" '0' 'a second run succeeds'
assert_contains "$out" 'already provisioned' 'a second run reports the existing install'
assert_equals "$(wc -c <"$RECORDS/mise-calls" | tr -d ' ')" '0' 'a second run does not call Mise'

# Real regression control: the caller's bun pin must not decide the verdict,
# on the install path or on the already-provisioned path.
(cd "$CALLER" && "$INSTALLS/pnpm/10.32.1/pnpm" --version) >/dev/null 2>&1 &&
  fail 'the fake pnpm should refuse in a directory with a package.json'
pass 'the fake pnpm refuses inside a project directory, as pnpm does for a bun pin'
assert_equals "$(cd "$TEST_ROOT" && env -i "$INSTALLS/pnpm/10.32.1/pnpm" --version)" '10.32.1' \
  'the same binary reports its exact version from a neutral directory'

# A mktemp earlier on PATH that honours TMPDIR must not place the private work
# directory below the caller's project.
mkdir -p "$CALLER/tmp"
cat >"$FAKE_BIN/mktemp" <<STUB
#!/bin/sh
exec /usr/bin/mktemp -d "$CALLER/tmp/gnu.XXXXXX"
STUB
chmod +x "$FAKE_BIN/mktemp"
ARG=10.35.0
run_provision TMPDIR="$CALLER/tmp"
assert_equals "$status" '0' 'a PATH mktemp or TMPDIR inside the project does not change the verdict'
rm "$FAKE_BIN/mktemp"

# A checkout-local mise on PATH (including an absolute PATH entry) must never be
# the executable that installs anything.
mkdir -p "$CALLER/bin"
printf '#!/bin/sh\n: >"%s/SHADOW_MISE_RAN"\nexit 23\n' "$TEST_ROOT" >"$CALLER/bin/mise"
chmod +x "$CALLER/bin/mise"
ARG=10.39.0
run_provision PATH="$CALLER/bin:$FAKE_BIN:/usr/bin:/bin"
assert_equals "$status" '0' 'a checkout-local mise on PATH does not change the install'
[[ ! -e "$TEST_ROOT/SHADOW_MISE_RAN" ]] || fail 'the checkout-local mise ran'
pass 'the checkout-local mise never ran'
assert_contains "$(cat "$RECORDS/mise-calls")" 'args=install pnpm@10.39.0' 'the shim-chain Mise did the install'

# A shim chain that ends inside the directory the command runs from is refused.
cp "$FAKE_BIN/mise" "$CALLER/mise-final"
mv "$HOME_FIXTURE/.local/share/mise/shims/node" "$HOME_FIXTURE/.local/share/mise/shims/node.parked"
ln -s "$CALLER/mise-final" "$HOME_FIXTURE/.local/share/mise/shims/node"
ARG=10.39.1
run_provision
assert_equals "$status" '1' 'a Mise inside the calling directory is refused'
assert_contains "$out" 'does not end at an installed Mise' 'the in-checkout refusal says why'
[[ ! -e "$INSTALLS/pnpm/10.39.1" ]] || fail 'the refused Mise installed something'
pass 'the refused Mise installed nothing'
mv "$HOME_FIXTURE/.local/share/mise/shims/node" "$HOME_FIXTURE/.local/share/mise/shims/node.refused"
mv "$HOME_FIXTURE/.local/share/mise/shims/node.parked" "$HOME_FIXTURE/.local/share/mise/shims/node"

# The install runs in a protected environment: inherited Mise selectors that
# could pull in an unreviewed config (a system config file, config dirs, trust
# lists, XDG locations) never reach Mise, and Mise sees a private HOME.
ARG=10.40.0
: >"$RECORDS/mise-calls"
run_provision MISE_SYSTEM_CONFIG_FILE=/evil/system.toml MISE_CONFIG_DIR=/evil MISE_TRUSTED_CONFIG_PATHS=/evil \
  MISE_OVERRIDE_CONFIG_FILENAMES=other.toml XDG_CONFIG_HOME=/evil/xdg MISE_ENV=evil
assert_equals "$status" '0' 'hostile inherited selectors do not stop the install'
calls="$(cat "$RECORDS/mise-calls")"
grep -Fq '/evil' <<<"$calls" && fail 'an inherited selector reached Mise'
pass 'no inherited selector value reached Mise'
assert_contains "$calls" 'selectors=MISE_CEILING_PATHS=' 'only the protected Mise variables are visible to Mise'
grep -E '^selectors=' <<<"$calls" | grep -Eq 'MISE_(TRUSTED|OVERRIDE|ENV=|CONFIG_DIR=)' && fail 'a config selector other than the protected set reached Mise'
pass 'the protected set has no trust, override, environment or config-dir selector'
grep -Fq "home=$HOME_FIXTURE" <<<"$calls" && fail 'Mise ran with the real HOME'
pass 'Mise ran with a private HOME'
grep -Eq 'system=/tmp/pnpm-provision\.[^/]+/system\.toml' <<<"$calls" || fail 'the system config was not redirected to the private empty file'
pass 'the system config is the private empty file'

# A Mise elsewhere in the same checkout is checkout-owned too, even when the
# command runs from a subdirectory.
git -C "$CALLER" init -q
mkdir -p "$CALLER/src"
mv "$HOME_FIXTURE/.local/share/mise/shims/node" "$HOME_FIXTURE/.local/share/mise/shims/node.parked2"
ln -s "$CALLER/mise-final" "$HOME_FIXTURE/.local/share/mise/shims/node"
ARG=10.39.2
set +e
out="$(cd "$CALLER/src" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" RECORDS="$RECORDS" \
  "$REPO_ROOT/bin/dotfiles/pnpm-provision" "$ARG" 2>&1)"
status=$?
set -e
assert_equals "$status" '1' 'a Mise elsewhere in the calling checkout is refused from a subdirectory'
assert_contains "$out" 'does not end at an installed Mise' 'the subdirectory refusal says why'
[[ ! -e "$INSTALLS/pnpm/10.39.2" ]] || fail 'the refused Mise installed something from a subdirectory'
pass 'the subdirectory refusal installed nothing'
mv "$HOME_FIXTURE/.local/share/mise/shims/node" "$HOME_FIXTURE/.local/share/mise/shims/node.refused2"
mv "$HOME_FIXTURE/.local/share/mise/shims/node.parked2" "$HOME_FIXTURE/.local/share/mise/shims/node"

# A link above the version directory (installs/pnpm) that sends the install
# into the calling checkout is refused before Mise runs, as the guard would.
mv "$INSTALLS/pnpm" "$TEST_ROOT/pnpm-installs-parked"
mkdir -p "$CALLER/redirected"
ln -s "$CALLER/redirected" "$INSTALLS/pnpm"
ARG=10.99.1
: >"$RECORDS/mise-calls"
run_provision
assert_equals "$status" '1' 'an installs/pnpm link into the calling checkout is refused'
assert_contains "$out" 'inside the calling checkout' 'the redirect refusal says why'
[[ ! -e "$CALLER/redirected/10.99.1" ]] || fail 'the redirected install was created'
pass 'nothing was installed through the redirect'
assert_equals "$(wc -c <"$RECORDS/mise-calls" | tr -d ' ')" '0' 'the redirect refusal does not call Mise'
mkdir -p "$CALLER/redirected/10.32.1"
cp "$TEST_ROOT/pnpm-installs-parked/10.32.1/pnpm" "$CALLER/redirected/10.32.1/pnpm"
ARG=10.32.1
run_provision
assert_equals "$status" '1' 'an existing install reached through the redirect is not reported as provisioned'
rm "$INSTALLS/pnpm"
mv "$TEST_ROOT/pnpm-installs-parked" "$INSTALLS/pnpm"
run_provision
assert_equals "$status" '0' 'the restored installs directory provisions again'

# A plain directory is not a checkout: from HOME (a fresh terminal), or any
# non-Git ancestor of the installs directory, the installs path is below the
# current directory and must still provision.
for dir in "$HOME_FIXTURE" "$HOME_FIXTURE/.local"; do
  set +e
  out="$(cd "$dir" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" RECORDS="$RECORDS" \
    "$REPO_ROOT/bin/dotfiles/pnpm-provision" "$ARG" 2>&1)"
  status=$?
  set -e
  assert_equals "$status" '0' "running from non-checkout $dir succeeds"
  assert_contains "$out" 'already provisioned' "running from non-checkout $dir reports the existing install"
done
ARG=10.99.2
: >"$RECORDS/mise-calls"
set +e
out="$(cd "$HOME_FIXTURE" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" RECORDS="$RECORDS" \
  "$REPO_ROOT/bin/dotfiles/pnpm-provision" "$ARG" 2>&1)"
status=$?
set -e
assert_equals "$status" '0' 'a fresh install from HOME succeeds'
assert_contains "$(cat "$RECORDS/mise-calls")" 'args=install pnpm@10.99.2' 'the install from HOME reaches Mise'
ARG=10.32.1

# Even a forced base below a manifest cannot decide the verdict: it refuses.
ARG=10.37.0
: >"$RECORDS/mise-calls"
run_provision PNPM_PROVISION_WORK_BASE="$CALLER/tmp"
assert_equals "$status" '1' 'a work directory below a project manifest is refused'
assert_contains "$out" 'which pnpm would read' 'the ancestor refusal says why'
assert_equals "$(wc -c <"$RECORDS/mise-calls" | tr -d ' ')" '0' 'the ancestor refusal does not call Mise'

# Real Mise skips a version it thinks is installed (the fake models that), so an
# existing regular executable that reports the wrong version cannot be repaired
# by installing again. The provisioner must say so and leave it untouched.
mkdir -p "$INSTALLS/pnpm/10.38.0"
printf '#!/bin/sh\necho 10.38.1\n' >"$INSTALLS/pnpm/10.38.0/pnpm"
chmod +x "$INSTALLS/pnpm/10.38.0/pnpm"
before="$(shasum -a 256 "$INSTALLS/pnpm/10.38.0/pnpm")"
ARG=10.38.0
: >"$RECORDS/mise-calls"
run_provision
assert_equals "$status" '1' 'a wrong-version executable fails clearly'
assert_contains "$out" 'reported [10.38.1]' 'the failure names the reported version'
assert_contains "$out" "$INSTALLS/pnpm/10.38.0/pnpm" 'the failure names the path'
assert_contains "$out" 'move' 'the failure names the manual owner repair'
assert_contains "$out" 'never overwrites or removes' 'the failure promises no overwrite'
assert_equals "$(wc -c <"$RECORDS/mise-calls" | tr -d ' ')" '0' 'the wrong-version failure does not call Mise'
assert_equals "$(shasum -a 256 "$INSTALLS/pnpm/10.38.0/pnpm")" "$before" 'the wrong-version executable is untouched'

# A symlinked version directory is refused the way the guard refuses it.
mkdir -p "$TEST_ROOT/elsewhere/pnpm-real"
cp "$INSTALLS/pnpm/10.32.1/pnpm" "$TEST_ROOT/elsewhere/pnpm-real/pnpm"
ln -s "$TEST_ROOT/elsewhere/pnpm-real" "$INSTALLS/pnpm/10.36.0"
ARG=10.36.0
: >"$RECORDS/mise-calls"
run_provision
assert_equals "$status" '1' 'a symlinked version directory is not reported as provisioned'
assert_contains "$out" 'is a symlink' 'the symlink refusal says why'
assert_equals "$(wc -c <"$RECORDS/mise-calls" | tr -d ' ')" '0' 'the symlink refusal does not call Mise'
[[ -L "$INSTALLS/pnpm/10.36.0" ]] || fail 'the symlink was removed'
pass 'the symlinked directory is left in place'

ARG=10.33.0
run_provision FAKE_INSTALLED_VERSION=10.33.1
assert_equals "$status" '1' 'an install that reports another version fails'
assert_contains "$out" 'did not install as a regular executable' 'the wrong-version failure says why'
assert_contains "$out" "Next action: inspect $INSTALLS/pnpm/10.33.0" 'the wrong-version failure names the repair'

: >"$RECORDS/fail-install"
ARG=10.33.2
run_provision
assert_equals "$status" '1' 'a failed Mise install fails'
assert_contains "$out" 'mise ERROR checksum mismatch' 'the failed install keeps the Mise error'
assert_contains "$out" 'Next action: fix the cause it reports' 'the failed install names the repair'
mv "$RECORDS/fail-install" "$RECORDS/fail-install.used"

rm "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
ARG=10.34.0
run_provision
assert_equals "$status" '1' 'no applied Mise state refuses'
assert_contains "$out" 'toolchain update --apply' 'the refusal names the next action'

printf '%s tests passed\n' "$assertion_count"
