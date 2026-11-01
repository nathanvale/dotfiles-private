#!/usr/bin/env bash

# Husky toolchain-guard contract.
#
# Runs the production Husky init, Mise bootstrap, and guard in real /bin/sh
# processes under a test-owned HOME and a real Git checkout. Mise shims, node,
# and pnpm are process fakes whose answers the test controls; the suite proves
# that a wrong, missing, untrusted, or fallback tool makes init refuse (exit 1,
# cause and repair on stderr) before the hook body runs, and that exact pinned
# tools pass. It does not install Mise, Node, or pnpm, and does not prove real
# runtime behavior; live qualification is recorded separately.

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
PNPM_BIN="$TEST_ROOT/pnpm-bin"
CHECKOUT="$TEST_ROOT/checkout"
# The applied revision is named by the digest of its four files, as the
# toolchain apply names it; the guard recomputes that name.
revision_content_id() {
  local dir="$1" name
  for name in contract.txt manifest.tsv config.toml mise.lock; do
    printf '%s_sha256=%s\n' "$name" "$(shasum -a 256 "$dir/$name" | cut -d' ' -f1)"
  done | shasum -a 256 | cut -d' ' -f1
}
SHIMS="$HOME_FIXTURE/.local/share/mise/shims"
INSTALLS="$HOME_FIXTURE/.local/share/mise/installs"
REVISION_STAGE="$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/stage"
mkdir -p "$HOME_FIXTURE/.config/mise" "$HOME_FIXTURE/.config/husky" \
  "$FAKE_BIN" "$PNPM_BIN" "$SHIMS" "$REVISION_STAGE" "$CHECKOUT"
for file in mise/bootstrap.sh husky/init.sh husky/toolchain-guard.sh; do
  cp "$REPO_ROOT/config/$file" "$HOME_FIXTURE/.config/$file"
done
# Init restores the Homebrew prefix ahead of PATH; point it at the test-owned
# pnpm directory so the fake pnpm, not this machine's, is what init finds.
sed "s#/opt/homebrew#${TEST_ROOT}/prefix#g" "$REPO_ROOT/config/husky/init.sh" \
  >"$HOME_FIXTURE/.config/husky/init.sh"
mkdir -p "$TEST_ROOT/prefix"
ln -s "$PNPM_BIN" "$TEST_ROOT/prefix/bin"
printf '%s\n' '[tools]' >"$REVISION_STAGE/config.toml"
printf 'mise-revision-v1\n' >"$REVISION_STAGE/contract.txt"
printf 'node\t22.14.0\n' >"$REVISION_STAGE/manifest.tsv"
printf '# lock\n' >"$REVISION_STAGE/mise.lock"
REVISION_ID="$(revision_content_id "$REVISION_STAGE")"
REVISION_DIR="$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID"
mv "$REVISION_STAGE" "$REVISION_DIR"
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"

# One fake serves as the mise executable and, through the shim symlink, as
# node, like the real Mise: `mise trust --show` answers from FAKE_TRUST
# (trusted, tilde, untrusted, none, empty, failing); invoked as node it answers `node -p`
# from FAKE_NODE_MODE (pinned, wrong-version, fallback, untrusted).
cat >"$FAKE_BIN/mise" <<STUB
#!/bin/sh
if [ "\${0##*/}" = node ]; then
  printf 'auto=%s,%s,%s,%s\\n' "\${MISE_NOT_FOUND_AUTO_INSTALL-unset}" "\${MISE_AUTO_INSTALL-unset}" "\${MISE_EXEC_AUTO_INSTALL-unset}" "\${MISE_OFFLINE-unset}" >>"\${0%/*}/../node-shim-env"
  case "\${FAKE_NODE_MODE:-pinned}" in
    pinned) printf 'v%s %s\\n' "\$FAKE_NODE_PIN" "$INSTALLS/node/\$FAKE_NODE_PIN/bin/node" ;;
    wrong-version) printf 'v20.11.1 %s\\n' "$INSTALLS/node/20.11.1/bin/node" ;;
    fallback) printf 'v%s /opt/homebrew/Cellar/node/bin/node\\n' "\$FAKE_NODE_PIN" ;;
    untrusted) printf 'mise ERROR Config files are not trusted.\\n' >&2; exit 1 ;;
  esac
  exit 0
fi
# Any non-shim call counts: even \`trust --show\` can evaluate config on a cold HOME.
[ -z "\${FAKE_MISE_CALLED:-}" ] || : >"\$FAKE_MISE_CALLED"
if [ "\${1:-}" = config ] && [ "\${2:-}" = ls ]; then
  # Real Mise evaluates templates in a changed [env] when it lists configs.
  [ -z "\${CONFIG_LS_EFFECT:-}" ] || : >"\$CONFIG_LS_EFFECT"
  printf '[\\n  {\\n    "path": "%s",\\n    "tools": []\\n  }' "\$MISE_GLOBAL_CONFIG_FILE"
  [ -f "\$PWD/mise.toml" ] && printf ',\\n  {\\n    "path": "%s/mise.toml",\\n    "tools": []\\n  }' "\$PWD"
  printf ',\\n  {\\n    "path": "%s/.nvmrc",\\n    "tools": ["node"]\\n  }\\n]\\n' "\$PWD"
  exit 0
fi
[ "\${1:-}" = trust ] || exit 0
case "\${FAKE_TRUST:-trusted}" in
  trusted) printf '%s: trusted\\n' "\$PWD" ;;
  tilde) printf '%s: trusted\\n' "~\${PWD#"\$HOME"}" ;;
  untrusted) printf '%s: untrusted\\n' "\$PWD" ;;
  none) printf 'mise No trusted config files found.\\n' >&2 ;;
  empty) ;;
  failing) printf 'mise ERROR boom\\n' >&2; exit 1 ;;
esac
STUB
chmod +x "$FAKE_BIN/mise"
ln -s "$FAKE_BIN/mise" "$SHIMS/node"

# Two pnpm fakes. The ambient one stands for Homebrew pnpm 12: it reports the
# project's pin (manager forwarding) and logs AMBIENT, so a run that ever
# consults it is visible. The pinned one is the Mise-provisioned binary for a
# version: it reports FAKE_PNPM_VERSION or its own version, never forwards, and
# logs its environment. FAKE_PNPM_VERSION=failing exits 127; FAKE_PNPM_EXIT adds
# a trailing exit status.
cat >"$PNPM_BIN/pnpm" <<'STUB'
#!/bin/sh
printf 'AMBIENT %s\n' "$*" >>"$PNPM_CALLS"
printf '%s\n' "$FAKE_PNPM_PIN"
STUB
chmod +x "$PNPM_BIN/pnpm"
provision_pnpm() {
  mkdir -p "$INSTALLS/pnpm/$1"
  cat >"$INSTALLS/pnpm/$1/pnpm" <<STUB
#!/bin/sh
printf 'PINNED $1 manage=%s offline=%s corepack=%s,%s\\n' "\${npm_config_manage_package_manager_versions-unset}" \\
  "\${pnpm_config_offline-unset}" "\${COREPACK_ENABLE_NETWORK-unset}" \\
  "\${COREPACK_ENABLE_DOWNLOAD_PROMPT-unset}" >>"\$PNPM_CALLS"
[ "\${FAKE_PNPM_VERSION:-}" = failing ] && exit 127
printf '%s\\n' "\${FAKE_PNPM_VERSION:-$1}"
[ "\${FAKE_PNPM_EXIT:-0}" = 0 ] || exit "\$FAKE_PNPM_EXIT"
STUB
  chmod +x "$INSTALLS/pnpm/$1/pnpm"
}
provision_pnpm 10.32.1

git -C "$CHECKOUT" init -q
write_package() {
  printf '{\n  "engines": {\n    "node": "%s"\n  },\n  "packageManager": "pnpm@%s"\n}\n' \
    "$1" "$2" >"$CHECKOUT/package.json"
}

# Records the exact content digest of a config, as bin/dotfiles/mise-config-review does.
review_config() {
  mkdir -p "$HOME_FIXTURE/.dotfiles_state/toolchain/reviewed-configs"
  : >"$HOME_FIXTURE/.dotfiles_state/toolchain/reviewed-configs/$(shasum -a 256 "$1" | cut -d' ' -f1)"
}

# Runs init, then the hook body marker, from the checkout; sets out/status.
run_init() {
  set +e
  # shellcheck disable=SC2016
  out="$(cd "$CHECKOUT" && env -i HOME="$HOME_FIXTURE" \
    PATH="$PNPM_BIN:$FAKE_BIN:/usr/bin:/bin" \
    PNPM_CALLS="$TEST_ROOT/pnpm-calls" FAKE_NODE_PIN=22.14.0 FAKE_PNPM_PIN=10.32.1 "$@" \
    /bin/sh -c '. "$HOME/.config/husky/init.sh"; echo HOOK_BODY_RAN; PATH="node_modules/.bin:$PATH"; echo "SELECTED_PNPM=$(command -v pnpm) MANAGE=${npm_config_manage_package_manager_versions-unset}"' 2>&1)"
  status=$?
  set -e
}

assert_refused() {
  run_init "${@:2}"
  assert_equals "$status" '1' "$1 exits one"
  grep -Fq HOOK_BODY_RAN <<<"$out" && fail "$1 ran the hook body"
  pass "$1 never reaches the hook body"
  assert_contains "$out" 'repair:' "$1 names a repair"
}

write_package 22.14.0 10.32.1
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'exact pinned Node and pnpm pass'
assert_contains "$out" HOOK_BODY_RAN 'exact pins reach the hook body'

assert_contains "$out" "SELECTED_PNPM=$INSTALLS/pnpm/10.32.1/pnpm MANAGE=false" \
  'the hook runs the bound pnpm with manager switching off'
assert_equals "$(sort -u "$TEST_ROOT/pnpm-calls")" 'PINNED 10.32.1 manage=false offline=unset corepack=0,0' \
  'only the bound pnpm is asked, with Corepack network and prompts off'
grep -Fq AMBIENT "$TEST_ROOT/pnpm-calls" && fail 'the ambient pnpm was consulted'
pass 'the ambient (forwarding) pnpm is never consulted'

# An ambient pnpm that reports the pin through forwarding is no substitute for
# the provisioned binary.
mv "$INSTALLS/pnpm/10.32.1" "$INSTALLS/pnpm/10.32.1.parked"
assert_refused 'a pin that is not provisioned' FAKE_NODE_MODE=pinned
assert_contains "$out" 'bin/dotfiles/pnpm-provision 10.32.1' 'missing pin names the explicit provisioning step'
grep -Fq AMBIENT "$TEST_ROOT/pnpm-calls" && fail 'an unprovisioned pin consulted the ambient pnpm'
pass 'an unprovisioned pin never falls back to the ambient pnpm'
mv "$INSTALLS/pnpm/10.32.1.parked" "$INSTALLS/pnpm/10.32.1"
ln -s "$INSTALLS/pnpm/10.32.1/pnpm" "$INSTALLS/pnpm/10.32.1/pnpm.link"
mv "$INSTALLS/pnpm/10.32.1/pnpm" "$INSTALLS/pnpm/10.32.1/pnpm.real"
ln -s "$INSTALLS/pnpm/10.32.1/pnpm.real" "$INSTALLS/pnpm/10.32.1/pnpm"
assert_refused 'a symlinked pnpm binary'
rm "$INSTALLS/pnpm/10.32.1/pnpm" "$INSTALLS/pnpm/10.32.1/pnpm.link"
mv "$INSTALLS/pnpm/10.32.1/pnpm.real" "$INSTALLS/pnpm/10.32.1/pnpm"

# Two owned checkouts with different pins each bind their own binary; a pin
# that was never provisioned refuses without touching the other.
SECOND="$TEST_ROOT/second"
mkdir -p "$SECOND"
git -C "$SECOND" init -q
printf '{"engines":{"node":"22.14.0"},"packageManager":"pnpm@10.33.0"}' >"$SECOND/package.json"
OUTER=$CHECKOUT
CHECKOUT=$SECOND
assert_refused 'a second checkout whose differing pin is not provisioned'
provision_pnpm 10.33.0
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'a second checkout binds its own provisioned pin'
assert_contains "$out" "SELECTED_PNPM=$INSTALLS/pnpm/10.33.0/pnpm" 'the second checkout selects its own pnpm'
CHECKOUT=$OUTER
run_init FAKE_NODE_MODE=pinned
assert_contains "$out" "SELECTED_PNPM=$INSTALLS/pnpm/10.32.1/pnpm" 'the first checkout still selects its own pnpm'

# The PATH can only be checked for a minimal or wrong environment through init:
# a PATH without the ambient pnpm, or with a decoy first, changes nothing.
run_init FAKE_NODE_MODE=pinned PATH="$FAKE_BIN:/usr/bin:/bin"
assert_contains "$out" "SELECTED_PNPM=$INSTALLS/pnpm/10.32.1/pnpm" 'a minimal PATH still binds the provisioned pnpm'

# Without applied Mise state a pnpm pin cannot be bound.
rm "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
printf '{"packageManager":"pnpm@10.32.1"}' >"$CHECKOUT/package.json"
assert_refused 'a pnpm-only pin without applied Mise state'
assert_contains "$out" 'no applied Mise state' 'pnpm-only refusal names its cause'
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
write_package 22.14.0 10.32.1

assert_refused 'wrong Node version' FAKE_NODE_MODE=wrong-version
assert_contains "$out" 'is v20.11.1' 'wrong Node refusal names the actual version'
assert_refused 'PATH fallback to a non-Mise node' FAKE_NODE_MODE=fallback
assert_contains "$out" 'not the Mise install' 'fallback refusal names the Mise install'
assert_refused 'untrusted or failing Mise config' FAKE_NODE_MODE=untrusted
assert_contains "$out" 'not trusted' 'untrusted refusal surfaces the Mise error'
assert_refused 'tools-only config that Mise reports untrusted' FAKE_TRUST=untrusted
assert_contains "$out" 'untrusted config' 'untrusted refusal names the cause'
assert_contains "$out" "$CHECKOUT" 'untrusted refusal names the checkout'
assert_refused 'unreadable Mise trust state' FAKE_TRUST=failing
run_init FAKE_TRUST=none
assert_equals "$status" '0' 'a checkout with no trust-gated config passes'
assert_refused 'wrong pnpm version' FAKE_PNPM_VERSION=12.4.2
assert_contains "$out" 'reported [12.4.2]' 'wrong pnpm refusal names the actual version'
assert_contains "$out" 'move' 'a wrong-version pnpm names the manual owner repair'
assert_contains "$out" 'never overwrites' 'the wrong-version repair promises no overwrite'
grep -Fq 'reprovision' <<<"$out" && fail 'a wrong-version pnpm still prescribes blind reprovisioning'
pass 'a wrong-version pnpm does not prescribe a blind rerun'
assert_refused 'failing pnpm' FAKE_PNPM_VERSION=failing

printf '22.14.1\n' >"$CHECKOUT/.nvmrc"
assert_refused 'disagreeing Node pins'
assert_contains "$out" 'disagree' 'disagreement refusal explains itself'
printf 'v22.14.0\n' >"$CHECKOUT/.nvmrc"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'agreeing .nvmrc with v prefix passes'

rm "$CHECKOUT/.nvmrc"
printf '{"name":"x","engines":{"node":"22.14.0"},"packageManager":"pnpm@10.32.1+sha512.abc"}' >"$CHECKOUT/package.json"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'minified manifest with a hash suffix passes'
assert_refused 'minified manifest wrong pnpm' FAKE_PNPM_VERSION=12.4.2
assert_refused 'pnpm that prints the pin then fails' FAKE_PNPM_EXIT=42
assert_contains "$out" 'failed' 'pnpm failure status is surfaced'
printf '{"engines":{"node":"22.14.0"},"packageManager":"pnpm@^10.32.1"}' >"$CHECKOUT/package.json"
assert_refused 'non-exact pnpm pin'

# A nested engines object after the top-level one must not replace the pin.
printf '{"engines":{"node":"22.14.0"},"config":{"engines":{"node":">=22"}},"packageManager":"pnpm@10.32.1"}' >"$CHECKOUT/package.json"
assert_refused 'wrong Node beside a nested engines object' FAKE_NODE_MODE=wrong-version
assert_contains "$out" 'is v20.11.1' 'nested engines does not hide the top-level Node pin'
printf '{"scripts":{"x":"echo \\"engines\\": {\\"node\\": \\"1.1.1\\"}"},"engines":{"node":"22.14.0"}}' >"$CHECKOUT/package.json"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'engines text inside a string value is not a pin'

# A literal dotted key is not the nested engines.node pin, and an escaped key
# could spell one, so it refuses rather than guess.
printf '{"engines":{"node":"22.14.0"},"packageManager":"pnpm@10.32.1","engines.node":">=22"}' >"$CHECKOUT/package.json"
assert_refused 'wrong Node beside a literal engines.node key' FAKE_NODE_MODE=wrong-version
assert_contains "$out" 'is v20.11.1' 'dotted key does not replace the nested Node pin'
printf '{"eng\\u0069nes":{"node":"22.14.0"},"packageManager":"pnpm@10.32.1"}' >"$CHECKOUT/package.json"
assert_refused 'escaped object key' FAKE_NODE_MODE=wrong-version
assert_contains "$out" 'escape sequence' 'escaped key refusal names its cause'
printf '{"engines":{"node":"22.14.0"},"packageManager":"pnpm\\u004010.32.1"}' >"$CHECKOUT/package.json"
assert_refused 'escaped packageManager value' FAKE_PNPM_VERSION=12.4.2
assert_contains "$out" 'escape sequence' 'escaped pin refusal names its cause'

# Without applied Mise state no Node executable can be proved Mise-owned.
write_package 22.14.0 10.32.1
rm "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
mkdir -p "$TEST_ROOT/ambient"
cp "$SHIMS/node" "$TEST_ROOT/ambient/node"
assert_refused 'ambient Node without applied Mise state' PATH="$TEST_ROOT/ambient:/usr/bin:/bin" FAKE_NODE_MODE=pinned
assert_contains "$out" 'no applied Mise state' 'missing state refusal names its cause'
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"

# The real Husky 9 wrapper prepends node_modules/.bin after init. Run it with
# the production init and hooks: the effective tools must be the pinned ones.
mkdir -p "$CHECKOUT/.husky/_" "$CHECKOUT/node_modules/.bin"
cat >"$CHECKOUT/.husky/_/h" <<'WRAP'
#!/usr/bin/env sh
[ "$HUSKY" = "2" ] && set -x
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n

[ ! -f "$s" ] && exit 0

i="${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"
[ -f "$i" ] && . "$i"

[ "${HUSKY-}" = "0" ] && exit 0

export PATH="node_modules/.bin:$PATH"
sh -e "$s" "$@"
c=$?

[ $c != 0 ] && echo "husky - $n script failed (code $c)"
[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"
exit $c
WRAP
printf '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n' >"$CHECKOUT/.husky/_/pre-commit"
printf 'pnpm lint-staged\n' >"$CHECKOUT/.husky/pre-commit"
cat >"$CHECKOUT/node_modules/.bin/pnpm" <<'SHADOW'
#!/bin/sh
printf 'WRONG_PNPM_EFFECT %s\n' "$*"
SHADOW
chmod +x "$CHECKOUT/node_modules/.bin/pnpm"
run_wrapper() {
  set +e
  out="$(cd "$CHECKOUT" && env -i HOME="$HOME_FIXTURE" \
    PATH="$PNPM_BIN:$FAKE_BIN:/usr/bin:/bin" \
    PNPM_CALLS="$TEST_ROOT/pnpm-calls" FAKE_NODE_PIN=22.14.0 FAKE_PNPM_PIN=10.32.1 "$@" \
    /bin/sh .husky/_/pre-commit 2>&1)"
  status=$?
  set -e
}
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '1' 'repo-local pnpm shadow is refused through the Husky wrapper'
grep -Fq "WRONG_PNPM_EFFECT lint-staged" <<<"$out" && fail 'shadow pnpm executed a hook effect'
pass 'shadow pnpm never executes a hook effect'
rm "$CHECKOUT/node_modules/.bin/pnpm"
cat >"$CHECKOUT/node_modules/.bin/node" <<'SHADOW'
#!/bin/sh
printf 'v22.14.0 /repo/node_modules/.bin/node\n'
SHADOW
chmod +x "$CHECKOUT/node_modules/.bin/node"
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '1' 'repo-local node shadow is refused through the Husky wrapper'
rm "$CHECKOUT/node_modules/.bin/node"
# A checkout-local mise that claims trust must not answer the trust question.
cat >"$CHECKOUT/node_modules/.bin/mise" <<'SHADOW'
#!/bin/sh
printf 'LOCAL_MISE %s: trusted\n' "$PWD"
SHADOW
chmod +x "$CHECKOUT/node_modules/.bin/mise"
run_wrapper FAKE_NODE_MODE=pinned FAKE_TRUST=untrusted
assert_equals "$status" '1' 'a checkout-local mise cannot vouch for untrusted config'
assert_contains "$out" 'untrusted config' 'the real Mise answered, not the checkout-local one'
# The same copy named by an inherited absolute PATH entry must not win either:
# Mise comes from the shim's own link, not from PATH.
run_wrapper FAKE_NODE_MODE=pinned FAKE_TRUST=untrusted \
  PATH="$CHECKOUT/node_modules/.bin:$PNPM_BIN:$FAKE_BIN:/usr/bin:/bin"
assert_equals "$status" '1' 'an inherited absolute checkout-local mise cannot vouch either'
assert_contains "$out" 'untrusted config' 'the shim-linked Mise answered the absolute-PATH case'
rm "$CHECKOUT/node_modules/.bin/mise"
# Helpers in the trust path must not come from the checkout's node_modules/.bin
# either: a local readlink that prints a harmless target would otherwise make
# the chain look fine while no trust answer is ever read.
for helper in readlink dirname basename git sed awk tr wc head tail; do
  printf '#!/bin/sh\necho /usr/bin/true\n' >"$CHECKOUT/node_modules/.bin/$helper"
  chmod +x "$CHECKOUT/node_modules/.bin/$helper"
done
run_wrapper FAKE_NODE_MODE=pinned FAKE_TRUST=untrusted
assert_equals "$status" '1' 'checkout-local helper shadows cannot hide untrusted config'
assert_contains "$out" 'untrusted config' 'the real helpers and Mise answered despite helper shadows'
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'checkout-local helper shadows do not break a trusted run'
for helper in readlink dirname basename git sed awk tr wc head tail; do
  rm "$CHECKOUT/node_modules/.bin/$helper"
done
# A chain whose first hop is outside the checkout but whose final file is inside.
cp "$FAKE_BIN/mise" "$CHECKOUT/mise-final"
ln -s "$CHECKOUT/mise-final" "$TEST_ROOT/outside-link"
rm "$SHIMS/node"
ln -s "$TEST_ROOT/outside-link" "$SHIMS/node"
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '1' 'a shim chain that ends inside the checkout is refused'
assert_contains "$out" 'inside the checkout' 'chained-link refusal names its cause'
rm "$SHIMS/node"
ln -s "$FAKE_BIN/mise" "$SHIMS/node"
# Mise's path trust keeps accepting a trusted file after it is edited, so the
# guard binds the reviewed content: an unreviewed or since-changed config
# refuses even when Mise itself calls it trusted.
printf '[tools]\nnode = "22.14.0"\n' >"$CHECKOUT/mise.toml"
assert_refused 'a Mise config whose content was never reviewed' FAKE_NODE_MODE=pinned FAKE_TRUST=trusted
assert_contains "$out" 'bin/dotfiles/mise-config-review' 'the unreviewed refusal names the review step'
assert_contains "$out" 'has not been reviewed in its current content' 'the unreviewed refusal names its cause'
review_config "$CHECKOUT/mise.toml"
run_init FAKE_NODE_MODE=pinned FAKE_TRUST=trusted
assert_equals "$status" '0' 'a config reviewed in its exact content passes'
printf '[env]\nDSFU_UNREVIEWED_PROBE = "changed-after-trust"\n' >>"$CHECKOUT/mise.toml"
assert_refused 'a trusted config changed after review' FAKE_NODE_MODE=pinned FAKE_TRUST=trusted FAKE_MISE_CALLED="$TEST_ROOT/config-ls-effect"
assert_contains "$out" 'has not been reviewed in its current content' 'the changed-config refusal names its cause'
[[ ! -e "$TEST_ROOT/config-ls-effect" ]] || fail 'Mise listed (and so evaluated) an unreviewed config before the refusal'
pass 'an unreviewed config is refused before Mise lists or evaluates anything'
printf '[tools]\nnode = "22.14.0"\n' >"$CHECKOUT/mise.toml"
run_init FAKE_NODE_MODE=pinned FAKE_TRUST=trusted
assert_equals "$status" '0' 'restoring the reviewed content passes again'
# Discovery covers conf.d files, env-specific files and every ancestor, not just
# the checkout's mise.toml, and an env var that changes discovery refuses.
mkdir -p "$CHECKOUT/.config/mise/conf.d"
printf '[env]\nA = "1"\n' >"$CHECKOUT/.config/mise/conf.d/extra.toml"
assert_refused 'an unreviewed conf.d config' FAKE_NODE_MODE=pinned
review_config "$CHECKOUT/.config/mise/conf.d/extra.toml"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'a reviewed conf.d config passes'
rm "$CHECKOUT/.config/mise/conf.d/extra.toml"
printf '[env]\nA = "2"\n' >"$CHECKOUT/mise.staging.toml"
assert_refused 'an unreviewed env-specific config' FAKE_NODE_MODE=pinned
rm "$CHECKOUT/mise.staging.toml"
# Paths a real Mise loads that an earlier walk missed.
for missed in .config/mise.local.toml .config/mise/mise.toml .config/mise/config.local.toml .mise/config.local.toml .config/mise.staging.toml; do
  mkdir -p "$CHECKOUT/${missed%/*}"
  printf '[env]\nA = "4"\n' >"$CHECKOUT/$missed"
  assert_refused "an unreviewed $missed" FAKE_NODE_MODE=pinned FAKE_MISE_CALLED="$TEST_ROOT/mise-called-$$"
  [[ ! -e "$TEST_ROOT/mise-called-$$" ]] || fail "Mise was run for $missed before the refusal"
  pass "$missed is refused before Mise evaluates anything"
  mv "$CHECKOUT/$missed" "$CHECKOUT/$missed.parked"
done
printf '[env]\nA = "3"\n' >"$TEST_ROOT/mise.toml"
assert_refused 'an unreviewed config in an ancestor directory' FAKE_NODE_MODE=pinned
review_config "$TEST_ROOT/mise.toml"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'a reviewed ancestor config passes'
rm "$TEST_ROOT/mise.toml"
assert_refused 'MISE_ENV changing config discovery' FAKE_NODE_MODE=pinned MISE_ENV=staging
assert_contains "$out" 'MISE_ENV is set' 'the discovery-variable refusal names the variable'
# Every installed-Mise (2026.9.10) variable that can reach a config or trust
# location is refused before Mise evaluates anything.
for selector in MISE_SYSTEM_CONFIG_FILE MISE_SYSTEM_CONFIG_DIR MISE_CONFIG_DIR MISE_GLOBAL_CONFIG_ROOT MISE_ENV_FILE MISE_ENV \
  MISE_OVERRIDE_CONFIG_FILENAMES MISE_DEFAULT_CONFIG_FILENAME MISE_NO_CONFIG MISE_PROFILE MISE_PROJECT_ROOT MISE_STATE_DIR \
  MISE_TRUSTED_CONFIG_PATHS MISE_IGNORED_CONFIG_PATHS MISE_CEILING_PATHS XDG_CONFIG_HOME XDG_STATE_HOME; do
  assert_refused "inherited $selector" FAKE_NODE_MODE=pinned "$selector=$TEST_ROOT/elsewhere" FAKE_MISE_CALLED="$TEST_ROOT/mise-called-sel"
  [[ ! -e "$TEST_ROOT/mise-called-sel" ]] || fail "Mise was run with $selector set"
  pass "$selector is refused before Mise evaluates anything"
done
# Early settings files can redirect which configs load; none is parsed, any refuses
# before a Mise command runs.
for early in .miserc.toml miserc.toml .config/miserc.toml .config/mise/miserc.toml .mise/miserc.toml; do
  case "$early" in */*) mkdir -p "$CHECKOUT/${early%/*}" ;; esac
  printf 'override_config_filenames = ["other.toml"]\n' >"$CHECKOUT/$early"
  assert_refused "an early settings file $early" FAKE_NODE_MODE=pinned FAKE_MISE_CALLED="$TEST_ROOT/mise-called-early"
  assert_contains "$out" 'early settings file' "$early refusal names the cause"
  [[ ! -e "$TEST_ROOT/mise-called-early" ]] || fail "Mise ran with $early present"
  pass "$early is refused before a Mise command"
  mkdir -p "$TEST_ROOT/parked-early"
  mv "$CHECKOUT/$early" "$TEST_ROOT/parked-early/$(printf '%s' "$early" | tr '/' '_')"
done
# Inherited automatic-install overrides (and any other MISE_* outside the
# supported applied-state set) refuse before any Mise command runs.
for selector in MISE_NOT_FOUND_AUTO_INSTALL MISE_AUTO_INSTALL MISE_EXEC_AUTO_INSTALL MISE_YES MISE_JOBS MISE_LOCKED; do
  assert_refused "inherited $selector" FAKE_NODE_MODE=pinned "$selector=true" FAKE_MISE_CALLED="$TEST_ROOT/mise-called-auto"
  assert_contains "$out" "$selector is set" "$selector refusal names the variable"
  [[ ! -e "$TEST_ROOT/mise-called-auto" ]] || fail "Mise was run with $selector set"
  pass "$selector is refused before a Mise command"
done
# The fake Node shim records the environment at invocation. Real Mise's
# config precedence and missing-tool behavior require separate process proof.
# A nested hook that inherits these exact controls is accepted.
: >"$HOME_FIXTURE/.local/share/mise/node-shim-env"
run_init FAKE_NODE_MODE=pinned
assert_equals "$(sort -u "$HOME_FIXTURE/.local/share/mise/node-shim-env")" 'auto=false,false,false,true' 'the Node shim runs with installation forced off and Mise offline'
assert_contains "$out" HOOK_BODY_RAN 'the forced controls do not block the hook'
run_init FAKE_NODE_MODE=pinned MISE_NOT_FOUND_AUTO_INSTALL=false MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_OFFLINE=true
assert_equals "$status" '0' 'a nested hook inheriting exactly the forced controls passes'
for pair in MISE_OFFLINE=false MISE_NOT_FOUND_AUTO_INSTALL=1 MISE_AUTO_INSTALL=; do
  assert_refused "a wrong inherited value $pair" FAKE_NODE_MODE=pinned "$pair"
done
# The bootstrap itself runs before the guard: an absolute PATH entry inside the
# checkout must not supply the readlink it uses on the applied-state link.
mkdir -p "$CHECKOUT/bin"
printf '#!/bin/sh\n: >"%s/CHECKOUT_READLINK_RAN"\necho /usr/bin/true\n' "$TEST_ROOT" >"$CHECKOUT/bin/readlink"
chmod +x "$CHECKOUT/bin/readlink"
run_init FAKE_NODE_MODE=pinned PATH="$CHECKOUT/bin:$PNPM_BIN:$FAKE_BIN:/usr/bin:/bin"
assert_equals "$status" '0' 'a checkout-local readlink on an absolute PATH entry does not change the run'
[[ ! -e "$TEST_ROOT/CHECKOUT_READLINK_RAN" ]] || fail 'the bootstrap ran the checkout-local readlink'
pass 'the bootstrap never ran the checkout-local readlink'
# The selected global config is bound to the applied revision's content identity.
for victim in config.toml mise.lock manifest.tsv contract.txt; do
  cp "$REVISION_DIR/$victim" "$TEST_ROOT/revision-original-$victim"
  printf '[env]\nX = "{{ exec(command=\x27true\x27) }}"\n' >>"$REVISION_DIR/$victim"
  assert_refused "an applied revision with an edited $victim" FAKE_NODE_MODE=pinned FAKE_MISE_CALLED="$TEST_ROOT/mise-called-rev"
  assert_contains "$out" 'no longer matches its content identity' "the edited $victim refusal names the cause"
  [[ ! -e "$TEST_ROOT/mise-called-rev" ]] || fail "Mise was run with an edited revision $victim"
  pass "an edited revision $victim is refused before a Mise command"
  cp "$TEST_ROOT/revision-original-$victim" "$REVISION_DIR/$victim"
done
mv "$REVISION_DIR/manifest.tsv" "$TEST_ROOT/revision-manifest-parked"
assert_refused 'an applied revision missing a file' FAKE_NODE_MODE=pinned
mv "$TEST_ROOT/revision-manifest-parked" "$REVISION_DIR/manifest.tsv"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'the restored applied revision passes again'
run_init FAKE_NODE_MODE=pinned MISE_SHELL=zsh MISE_VERBOSE=1 XDG_CONFIG_HOME="$HOME_FIXTURE/.config" XDG_STATE_HOME="$HOME_FIXTURE/.local/state"
assert_equals "$status" '0' 'harmless MISE_* variables, the shell marker and default XDG locations are allowed'
# User and system config locations load even when they are not ancestors.
mkdir -p "$HOME_FIXTURE/.config/mise"
printf '[env]\nA = "5"\n' >"$HOME_FIXTURE/.config/mise/config.toml"
assert_refused 'an unreviewed user-level Mise config' FAKE_NODE_MODE=pinned
assert_contains "$out" "$HOME_FIXTURE/.config/mise/config.toml" 'the user-level refusal names the file'
mv "$HOME_FIXTURE/.config/mise/config.toml" "$HOME_FIXTURE/.config/mise/config.toml.parked"

# An empty exit-0 trust answer is no evidence when a Mise config is present.
run_wrapper FAKE_NODE_MODE=pinned FAKE_TRUST=empty
assert_equals "$status" '1' 'an empty trust answer does not vouch for a present config'
assert_contains "$out" 'did not report it trusted' 'empty-answer refusal names its cause'
run_wrapper FAKE_NODE_MODE=pinned FAKE_TRUST=trusted
assert_equals "$status" '0' 'a present config that Mise names trusted passes'
rm "$CHECKOUT/mise.toml"
# Mise prints a checkout under HOME with a leading ~; that spelling counts.
OUTER_CHECKOUT=$CHECKOUT
CHECKOUT="$HOME_FIXTURE/work/linked"
mkdir -p "$CHECKOUT"
git -C "$CHECKOUT" init -q
write_package 22.14.0 10.32.1
printf '[tools]\nnode = "22.14.0"\n' >"$CHECKOUT/mise.toml"
review_config "$CHECKOUT/mise.toml"
run_init FAKE_NODE_MODE=pinned FAKE_TRUST=tilde
assert_equals "$status" '0' 'a checkout under HOME that Mise names with ~ passes'
run_init FAKE_NODE_MODE=pinned FAKE_TRUST=empty
assert_equals "$status" '1' 'an empty trust answer still refuses under HOME'
CHECKOUT=$OUTER_CHECKOUT
# A shim that links to a Mise inside the checkout is refused outright.
cp "$FAKE_BIN/mise" "$CHECKOUT/mise-copy"
rm "$SHIMS/node"
ln -s "$CHECKOUT/mise-copy" "$SHIMS/node"
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '1' 'a shim linked to a Mise inside the checkout is refused'
assert_contains "$out" 'inside the checkout' 'checkout-local shim target names its cause'
rm "$SHIMS/node" "$CHECKOUT/mise-copy"
ln -s "$FAKE_BIN/mise" "$SHIMS/node"
# A link straight to the real Mise Node skips the shim, and with it the
# per-launch config trust evaluation, so it is refused too.
ln -s "$SHIMS/node" "$CHECKOUT/node_modules/.bin/node"
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '1' 'a node_modules/.bin link to the Mise Node is refused'
assert_contains "$out" 'not the Mise shim' 'bypass refusal names the shim'
rm "$CHECKOUT/node_modules/.bin/node"
run_wrapper FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'pinned tools run the hook through the Husky wrapper'

rm -r "$CHECKOUT/.husky"
printf '{\n  "engines": {\n    "node": ">=22"\n  }\n}\n' >"$CHECKOUT/package.json"
run_init FAKE_NODE_MODE=wrong-version FAKE_PNPM_VERSION=12.4.2
assert_equals "$status" '0' 'range-only checkout without exact pins is not guarded'

rm "$CHECKOUT/package.json"
# A Node version file pins Node with no package.json at all.
printf '22.14.0\n' >"$CHECKOUT/.nvmrc"
assert_refused 'a .nvmrc-only checkout with the wrong Node' FAKE_NODE_MODE=wrong-version
assert_contains "$out" 'is v20.11.1' 'the .nvmrc-only refusal names the actual version'
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'a .nvmrc-only checkout with the pinned Node passes'
printf '22.14.0\n' >"$CHECKOUT/.node-version"
rm "$CHECKOUT/.nvmrc"
assert_refused 'a .node-version-only checkout with the wrong Node' FAKE_NODE_MODE=wrong-version
rm "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
printf '22.14.0\n' >"$CHECKOUT/.nvmrc"
rm "$CHECKOUT/.node-version"
assert_refused 'a .nvmrc-only checkout without applied Mise state' FAKE_NODE_MODE=pinned PATH="$TEST_ROOT/ambient:/usr/bin:/bin"
assert_contains "$out" 'no applied Mise state' 'the .nvmrc-only state refusal names its cause'
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
rm "$CHECKOUT/.nvmrc"
run_init FAKE_NODE_MODE=wrong-version
assert_equals "$status" '0' 'checkout without package.json is not guarded'

# A partial installation without the guard refuses in a pinned checkout instead
# of letting the hook run with ambient tools.
write_package 22.14.0 10.32.1
GUARD_FILE="$HOME_FIXTURE/.config/husky/toolchain-guard.sh"
mv "$GUARD_FILE" "$TEST_ROOT/guard.parked"
assert_refused 'a pinned checkout with the guard missing' FAKE_NODE_MODE=wrong-version
assert_contains "$out" 'is missing or not a regular file' 'the missing-guard refusal says why'
ln -s "$TEST_ROOT/guard.parked" "$GUARD_FILE"
assert_refused 'a pinned checkout with a linked guard' FAKE_NODE_MODE=pinned
rm "$GUARD_FILE"
set +e
# shellcheck disable=SC2016
out="$(cd "$TEST_ROOT" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" \
  /bin/sh -c '. "$HOME/.config/husky/init.sh"; echo HOOK_BODY_RAN' 2>&1)"
status=$?
set -e
assert_equals "$status" '0' 'outside any checkout a missing guard does not block'
mv "$TEST_ROOT/guard.parked" "$GUARD_FILE"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'the restored guard passes again'

# Without the bootstrap, inherited Mise state would reach the guard uncleaned,
# so a missing or linked bootstrap refuses in a pinned checkout too.
BOOTSTRAP_FILE="$HOME_FIXTURE/.config/mise/bootstrap.sh"
mv "$BOOTSTRAP_FILE" "$TEST_ROOT/bootstrap.parked"
assert_refused 'a pinned checkout with the bootstrap missing' FAKE_NODE_MODE=pinned
assert_contains "$out" "$BOOTSTRAP_FILE is missing or not a regular file" 'the missing-bootstrap refusal says why'
assert_contains "$out" 'repair: install config/mise/bootstrap.sh' 'the missing-bootstrap refusal names the repair'
ln -s "$TEST_ROOT/bootstrap.parked" "$BOOTSTRAP_FILE"
assert_refused 'a pinned checkout with a linked bootstrap' FAKE_NODE_MODE=pinned
rm "$BOOTSTRAP_FILE"
set +e
# shellcheck disable=SC2016
out="$(cd "$TEST_ROOT" && env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" \
  /bin/sh -c '. "$HOME/.config/husky/init.sh"; echo HOOK_BODY_RAN' 2>&1)"
status=$?
set -e
assert_equals "$status" '0' 'outside any checkout a missing bootstrap does not block'
mv "$TEST_ROOT/bootstrap.parked" "$BOOTSTRAP_FILE"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'the restored bootstrap passes again'

# The root resolving correctly is not enough: lint-staged runs a workspace
# package's tasks with that package's own node_modules/.bin, where pnpm bin
# wrappers exec a sibling node.
mkdir -p "$CHECKOUT/extensions/x/node_modules/.bin"
printf '{}\n' >"$CHECKOUT/extensions/x/package.json"
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'a workspace package without a shadow passes'
for tool in node pnpm npx; do
  printf '#!/bin/sh\necho CHECKOUT_TOOL_RAN\n' >"$CHECKOUT/extensions/x/node_modules/.bin/$tool"
  chmod +x "$CHECKOUT/extensions/x/node_modules/.bin/$tool"
  assert_refused "a checkout-owned workspace node_modules/.bin/$tool" FAKE_NODE_MODE=pinned
  assert_contains "$out" "shadowing $CHECKOUT/extensions/x/node_modules/.bin/$tool" "the workspace $tool refusal says why"
  assert_contains "$out" 'repair: remove the dependency' "the workspace $tool refusal names the repair"
  mv "$CHECKOUT/extensions/x/node_modules/.bin/$tool" "$TEST_ROOT/workspace-$tool.parked"
done
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'the workspace without shadows passes again'

# lint-staged also puts every ancestor's node_modules/.bin on PATH, so a stray
# one between the package and the root, or above the checkout, refuses too.
for dir in "$CHECKOUT/extensions" "${CHECKOUT%/*}"; do
  mkdir -p "$dir/node_modules/.bin"
  printf '#!/bin/sh\necho CHECKOUT_TOOL_RAN\n' >"$dir/node_modules/.bin/node"
  chmod +x "$dir/node_modules/.bin/node"
  assert_refused "a node_modules/.bin/node in ancestor $dir" FAKE_NODE_MODE=pinned
  assert_contains "$out" "shadowing $dir/node_modules/.bin/node" "the ancestor $dir refusal says why"
  mv "$dir/node_modules/.bin/node" "$TEST_ROOT/ancestor-node.$assertion_count.parked"
done
run_init FAKE_NODE_MODE=pinned
assert_equals "$status" '0' 'the checkout passes again without ancestor shadows'

printf '%s tests passed\n' "$assertion_count"
