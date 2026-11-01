#!/usr/bin/env bash

# Husky direct-pins contract.
#
# Runs the production Husky init and direct-pins selector in real /bin/sh
# processes under a test-owned HOME and a real Git checkout that opts in with
# .husky/direct-pins. Node, pnpm and Mise are process fakes; the suite proves
# that an opted-in checkout gets the exact pinned executables exported without
# any Mise call, and that a wrong, missing, linked or disagreeing pin refuses
# (exit 1) before the hook body. It does not prove real runtimes.

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
CHECKOUT="$TEST_ROOT/checkout"
INSTALLS="$HOME_FIXTURE/.local/share/mise/installs"
NODE_BIN="$INSTALLS/node/22.14.0/bin/node"
PNPM_BIN="$INSTALLS/pnpm/10.32.1/pnpm"
mkdir -p "$HOME_FIXTURE/.config/husky" "$HOME_FIXTURE/.config/mise" "$FAKE_BIN" \
  "${NODE_BIN%/*}" "${PNPM_BIN%/*}" "$CHECKOUT/.husky"
for file in husky/init.sh husky/direct-pins.sh husky/toolchain-guard.sh mise/bootstrap.sh; do
  cp "$REPO_ROOT/config/$file" "$HOME_FIXTURE/.config/$file"
done

# Any Mise call is recorded; the direct route must never make one.
cat >"$FAKE_BIN/mise" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >>"$TEST_ROOT/mise-calls"
STUB
chmod +x "$FAKE_BIN/mise"

write_node() {
  printf '#!/bin/sh\necho %s\n' "$1" >"$NODE_BIN"
  chmod +x "$NODE_BIN"
}
write_pnpm() {
  cat >"$PNPM_BIN" <<STUB
#!/bin/sh
[ "\${1:-}" = --version ] && { echo $1; exit 0; }
printf 'manage=%s args=%s\n' "\${npm_config_manage_package_manager_versions-unset}" "\$*" >>"$TEST_ROOT/pnpm-calls"
STUB
  chmod +x "$PNPM_BIN"
}
write_node v22.14.0
write_pnpm 10.32.1

git -C "$CHECKOUT" init -q
write_package() {
  printf '{\n  "engines": {\n    "node": "%s"\n  },\n  "packageManager": "%s"\n}\n' \
    "$1" "$2" >"$CHECKOUT/package.json"
}
write_package 22.14.0 pnpm@10.32.1
printf '22.14.0' >"$CHECKOUT/.nvmrc"
printf 'direct pins\n' >"$CHECKOUT/.husky/direct-pins"

# Sources init as Husky does, then runs a hook body that uses the exports.
run_init() {
  set +e
  # shellcheck disable=SC2016
  out="$(cd "$CHECKOUT" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" "$@" \
    /bin/sh -c '. "$HOME/.config/husky/init.sh"
      : "${HUSKY_PINNED_NODE:?no node}"
      : "${HUSKY_PINNED_PNPM:?no pnpm}"
      echo "HOOK_BODY_RAN node=$HUSKY_PINNED_NODE pnpm=$HUSKY_PINNED_PNPM first=${PATH%%:*}"
      "$HUSKY_PINNED_PNPM" lint-staged' 2>&1)"
  status=$?
  set -e
}
assert_refused() {
  run_init "${@:2}"
  assert_equals "$status" '1' "$1 exits one"
  grep -Fq HOOK_BODY_RAN <<<"$out" && fail "$1 ran the hook body"
  pass "$1 never reaches the hook body"
  assert_contains "$out" 'repair: ' "$1 names its repair"
}

run_init
assert_equals "$status" '0' 'an opted-in checkout with exact pins passes'
assert_contains "$out" "node=$NODE_BIN" 'the pinned Node path is exported'
assert_contains "$out" "pnpm=$PNPM_BIN" 'the pinned pnpm path is exported'
assert_contains "$out" "first=${NODE_BIN%/*}" 'the pinned Node directory leads PATH'
assert_contains "$(cat "$TEST_ROOT/pnpm-calls")" 'manage=false args=lint-staged' \
  'the hook runs the pinned pnpm with manager switching off'
[[ ! -e "$TEST_ROOT/mise-calls" ]] || fail 'the direct route called Mise'
pass 'the direct route makes no Mise call'

# Mise is never asked, so even an untrusted config with an exec template in the
# checkout cannot run.
printf '[env]\nX = "{{ exec(command='"'"'touch %s/MISE_EFFECT'"'"') }}"\n' "$TEST_ROOT" >"$CHECKOUT/mise.toml"
run_init
assert_equals "$status" '0' 'a checkout Mise config does not affect the direct route'
[[ ! -e "$TEST_ROOT/MISE_EFFECT" && ! -e "$TEST_ROOT/mise-calls" ]] || fail 'Mise ran for the direct route'
pass 'no Mise config is evaluated on the direct route'
mv "$CHECKOUT/mise.toml" "$TEST_ROOT/mise.toml.parked"

printf '22.14.1' >"$CHECKOUT/.nvmrc"
assert_refused 'disagreeing engines.node and .nvmrc'
assert_contains "$out" '[22.14.0] and .nvmrc [22.14.1] disagree' 'the disagreement names both versions'
# The same normalisation as the guard: line endings, spaces and a leading v.
printf 'v22.14.0 \r\n' >"$CHECKOUT/.nvmrc"
run_init
assert_equals "$status" '0' 'a .nvmrc with a v prefix, space and CRLF still matches'
printf '22.14.0' >"$CHECKOUT/.nvmrc"

# A checkout-owned tool bin would run before the pins: Husky puts
# node_modules/.bin first, and pnpm bin wrappers exec a sibling node.
mkdir -p "$CHECKOUT/node_modules/.bin"
cat >"$CHECKOUT/node_modules/.bin/lint-staged" <<'STUB'
#!/bin/sh
basedir=$(dirname "$0")
[ -x "$basedir/node" ] && exec "$basedir/node" "$@"
echo LINT_STAGED_RAN
STUB
chmod +x "$CHECKOUT/node_modules/.bin/lint-staged"
for tool in node pnpm npx corepack; do
  printf '#!/bin/sh\necho CHECKOUT_TOOL_RAN\n' >"$CHECKOUT/node_modules/.bin/$tool"
  chmod +x "$CHECKOUT/node_modules/.bin/$tool"
  assert_refused "a checkout-owned node_modules/.bin/$tool"
  assert_contains "$out" "shadowing $CHECKOUT/node_modules/.bin/$tool" "the $tool shadow refusal says why"
  grep -Fq CHECKOUT_TOOL_RAN <<<"$out" && fail "the checkout-owned $tool ran"
  pass "the checkout-owned $tool never ran"
  mv "$CHECKOUT/node_modules/.bin/$tool" "$TEST_ROOT/shadow-$tool.parked"
done
ln -s "$TEST_ROOT/shadow-node.parked" "$CHECKOUT/node_modules/.bin/node"
assert_refused 'a linked checkout-owned node_modules/.bin/node'
mv "$CHECKOUT/node_modules/.bin/node" "$TEST_ROOT/shadow-node-link.parked"
run_init
assert_equals "$status" '0' 'other checkout bins such as lint-staged do not refuse'

# lint-staged runs a workspace package's tasks with that package's own
# node_modules/.bin, so a shadow in any package directory refuses too, tracked
# or not. An ignored directory is not a package of this checkout.
printf 'node_modules/\nignored/\n' >"$CHECKOUT/.gitignore"
mkdir -p "$CHECKOUT/extensions/x/node_modules/.bin" "$CHECKOUT/packages/y/node_modules/.bin" \
  "$CHECKOUT/ignored/z/node_modules/.bin"
printf '{}\n' >"$CHECKOUT/extensions/x/package.json"
printf '{}\n' >"$CHECKOUT/packages/y/package.json"
printf '{}\n' >"$CHECKOUT/ignored/z/package.json"
git -C "$CHECKOUT" add packages/y/package.json
for dir in extensions/x packages/y; do
  printf '#!/bin/sh\necho CHECKOUT_TOOL_RAN\n' >"$CHECKOUT/$dir/node_modules/.bin/node"
  chmod +x "$CHECKOUT/$dir/node_modules/.bin/node"
  assert_refused "a checkout-owned $dir/node_modules/.bin/node"
  assert_contains "$out" "shadowing $CHECKOUT/$dir/node_modules/.bin/node" "the $dir shadow refusal says why"
  mv "$CHECKOUT/$dir/node_modules/.bin/node" "$TEST_ROOT/shadow-${dir%%/*}.parked"
done
printf '#!/bin/sh\necho CHECKOUT_TOOL_RAN\n' >"$CHECKOUT/ignored/z/node_modules/.bin/node"
chmod +x "$CHECKOUT/ignored/z/node_modules/.bin/node"
run_init
assert_equals "$status" '0' 'workspace packages without shadows, and ignored directories, pass'

# lint-staged also puts every ancestor's node_modules/.bin on PATH, so a stray
# one between the package and the root (ignored, not a package), or above the
# checkout, refuses too.
for dir in "$CHECKOUT/extensions" "$TEST_ROOT"; do
  mkdir -p "$dir/node_modules/.bin"
  printf '#!/bin/sh\necho CHECKOUT_TOOL_RAN\n' >"$dir/node_modules/.bin/node"
  chmod +x "$dir/node_modules/.bin/node"
  assert_refused "a node_modules/.bin/node in ancestor $dir"
  assert_contains "$out" "shadowing $dir/node_modules/.bin/node" "the ancestor $dir refusal says why"
  mv "$dir/node_modules/.bin/node" "$TEST_ROOT/ancestor-node.$assertion_count.parked"
done
run_init
assert_equals "$status" '0' 'the checkout passes again without ancestor shadows'

# Corepack's integrity suffix is accepted, as the guard accepts it.
write_package 22.14.0 'pnpm@10.32.1+sha512.0123abcd'
run_init
assert_equals "$status" '0' 'a pnpm pin with a Corepack integrity suffix passes'
write_package 22.14.0 pnpm@10.32.1
write_package 22.14.0 'pnpm@^10.32.1'
assert_refused 'a non-exact pnpm pin'
write_package 22 pnpm@10.32.1
assert_refused 'a non-exact Node pin'
write_package 22.14.0 bun@1.4.0
assert_refused 'a manager other than pnpm'
write_package 22.14.0 pnpm@10.32.1

write_pnpm 12.4.2
assert_refused 'a pinned pnpm that reports another version'
assert_contains "$out" 'expected 10.32.1' 'the pnpm version refusal names the pin'
assert_contains "$out" "move ${PNPM_BIN%/*} aside yourself and run bin/dotfiles/pnpm-provision 10.32.1" \
  'the pnpm version refusal names the non-overwriting repair'
write_pnpm 10.32.1
write_node v20.11.1
assert_refused 'a pinned Node that reports another version'
write_node v22.14.0

mv "$PNPM_BIN" "$TEST_ROOT/pnpm.parked"
assert_refused 'an unprovisioned pnpm pin'
assert_contains "$out" 'provision explicitly: run bin/dotfiles/pnpm-provision 10.32.1' 'the missing pin names explicit provisioning'
ln -s "$TEST_ROOT/pnpm.parked" "$PNPM_BIN"
assert_refused 'a linked pinned pnpm'
rm "$PNPM_BIN"
mv "$TEST_ROOT/pnpm.parked" "$PNPM_BIN"

# A link above the executable (the version directory) into the checkout must
# not let checkout-owned tools run, for Node or pnpm.
for tool in node/22.14.0 pnpm/10.32.1; do
  mv "$INSTALLS/$tool" "$TEST_ROOT/install-parked"
  mkdir -p "$CHECKOUT/evil"
  cp -R "$TEST_ROOT/install-parked" "$CHECKOUT/evil/${tool%%/*}"
  ln -s "$CHECKOUT/evil/${tool%%/*}" "$INSTALLS/$tool"
  : >"$TEST_ROOT/pnpm-calls"
  assert_refused "a linked $tool version directory into the checkout"
  assert_contains "$out" 'not its own install directory' "the linked $tool refusal says why"
  [[ ! -s "$TEST_ROOT/pnpm-calls" ]] || fail "a checkout-owned tool ran for $tool"
  pass "no checkout-owned tool ran for $tool"
  rm "$INSTALLS/$tool"
  mv "$TEST_ROOT/install-parked" "$INSTALLS/$tool"
done
# The installs root itself inside the checkout is refused too.
mv "$HOME_FIXTURE/.local" "$CHECKOUT/dot-local"
ln -s "$CHECKOUT/dot-local" "$HOME_FIXTURE/.local"
assert_refused 'a Mise installs directory inside the checkout'
assert_contains "$out" 'installs directory' 'the installs-root refusal says why'
rm "$HOME_FIXTURE/.local"
mv "$CHECKOUT/dot-local" "$HOME_FIXTURE/.local"
run_init
assert_equals "$status" '0' 'the real install layout passes again'

mv "$CHECKOUT/.husky/direct-pins" "$TEST_ROOT/marker.parked"
ln -s "$TEST_ROOT/marker.parked" "$CHECKOUT/.husky/direct-pins"
assert_refused 'a linked opt-in marker'
assert_contains "$out" 'marker must be a regular file' 'the linked marker refusal says why'
rm "$CHECKOUT/.husky/direct-pins"
mv "$TEST_ROOT/marker.parked" "$CHECKOUT/.husky/direct-pins"

mv "$HOME_FIXTURE/.config/husky/direct-pins.sh" "$TEST_ROOT/selector.parked"
assert_refused 'a missing installed selector'
assert_contains "$out" 'missing installed selector' 'the missing selector refusal says why'
mv "$TEST_ROOT/selector.parked" "$HOME_FIXTURE/.config/husky/direct-pins.sh"

# Without the marker the checkout takes the guarded Mise route, which has no
# applied state here and so refuses without exporting the direct pins.
mv "$CHECKOUT/.husky/direct-pins" "$TEST_ROOT/marker.parked"
assert_refused 'a checkout without the opt-in marker'
assert_contains "$out" 'husky toolchain guard' 'without the marker the guard decides'
mv "$TEST_ROOT/marker.parked" "$CHECKOUT/.husky/direct-pins"

run_init
assert_equals "$status" '0' 'the restored opted-in checkout passes again'

printf '%s tests passed\n' "$assertion_count"
