#!/usr/bin/env bash

# Applied Mise shell-bootstrap contract.
#
# Runs the production startup owners in real zsh and /bin/sh processes under a
# test-owned HOME. Mise and fnm are process fakes; selected state, exported
# config, PATH, activation calls, fallback calls, streams, and exit status are
# observed outside the child. This does not install Mise or prove real runtime
# downloads, arbitrary GUI hosts, or a clean no-cache Mac. Runtime shims are
# empty test-owned executables: the suite proves which executable wins PATH
# resolution, never what a runtime prints.

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
  printf 'Bail out! %s\n' "$1"
  exit 1
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

HOME_FIXTURE="$TEST_ROOT/home"
FAKE_BIN="$TEST_ROOT/fake-bin"
EXTERNAL="$TEST_ROOT/external"
RECORD_DIR="$TEST_ROOT/records"
EMPTY_PREFIX="$TEST_ROOT/empty-prefix"
REVISION_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
mkdir -p "$HOME_FIXTURE/.config/mise" "$HOME_FIXTURE/.config/fnm" \
  "$HOME_FIXTURE/.config/husky" "$FAKE_BIN" "$EXTERNAL" "$RECORD_DIR" \
  "$EMPTY_PREFIX/bin"
HOME_CANONICAL="$(CDPATH='' cd -P "$HOME_FIXTURE" && pwd)"
cp "$REPO_ROOT/config/mise/bootstrap.sh" "$HOME_FIXTURE/.config/mise/bootstrap.sh"
sed "s#/opt/homebrew#${EMPTY_PREFIX}#g" "$REPO_ROOT/config/fnm/bootstrap.sh" \
  >"$HOME_FIXTURE/.config/fnm/bootstrap.sh"
cp "$REPO_ROOT/config/husky/init.sh" "$HOME_FIXTURE/.config/husky/init.sh"
for startup_owner in .zshenv .zprofile .zshrc; do
  sed "s#/opt/homebrew#${EMPTY_PREFIX}#g" "$REPO_ROOT/$startup_owner" \
    >"$HOME_FIXTURE/$startup_owner"
done

cat >"$FAKE_BIN/mise" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"$RECORD_DIR/mise-calls"
if [ "${1:-}" = activate ] && [ "${2:-}" = zsh ]; then
  printf '%s\n' 'export CONTRACT_MISE_ACTIVATED=1'
fi
STUB
chmod +x "$FAKE_BIN/mise"

cat >"$FAKE_BIN/fnm" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"$RECORD_DIR/fnm-calls"
if [ "${1:-}" = env ]; then
  printf '%s\n' 'export CONTRACT_FNM_BOOTSTRAPPED=1'
fi
STUB
chmod +x "$FAKE_BIN/fnm"

cat >"$FAKE_BIN/pyenv" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"$RECORD_DIR/pyenv-calls"
printf '%s\n' 'export CONTRACT_PYENV_INITIALIZED=1'
STUB
chmod +x "$FAKE_BIN/pyenv"

create_valid_state() {
  local revision_dir="$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID"
  mkdir -p "$revision_dir" "$HOME_FIXTURE/.local/share/mise/shims"
  printf '%s\n' '[tools]' 'node = "26.9.0"' 'bun = "1.4.0"' \
    'python = "3.11.9"' '"github:gastownhall/beads" = "1.3.0"' >"$revision_dir/config.toml"
  ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
}

reset_state() {
  local state="$HOME_FIXTURE/.dotfiles_state"
  if [[ -e "$state" || -L "$state" ]]; then
    rm -rf "$state"
  fi
  rm -f "$RECORD_DIR"/*
}

run_bootstrap() {
  local child_path="${1:-$FAKE_BIN:/usr/bin:/bin}"
  local err_file="$TEST_ROOT/bootstrap.err"
  : >"$err_file"
  set +e
  # The isolated child expands HOME and the activation variables.
  # shellcheck disable=SC2016
  bootstrap_out="$({
    env -i HOME="$HOME_FIXTURE" PATH="$child_path" \
      MISE_GLOBAL_CONFIG_FILE="$EXTERNAL/stale.toml" \
      MISE_DATA_DIR="$EXTERNAL/mise" \
      MISE_INSTALLS_DIR="$EXTERNAL/installs" \
      MISE_SHIMS_DIR="$EXTERNAL/direct-shims" \
      /bin/sh -c '
        . "$HOME/.config/mise/bootstrap.sh"
        printf "active=%s\n" "${DOTFILES_MISE_ACTIVE-unset}"
        printf "config=%s\n" "${MISE_GLOBAL_CONFIG_FILE-unset}"
        printf "data=%s\n" "${MISE_DATA_DIR-unset}"
        printf "installs=%s\n" "${MISE_INSTALLS_DIR-unset}"
        printf "shims=%s\n" "${MISE_SHIMS_DIR-unset}"
        printf "path=%s\n" "$PATH"
      '
  } 2>"$err_file")"
  bootstrap_status=$?
  set -e
  bootstrap_err_bytes="$(wc -c <"$err_file" | tr -d ' ')"
}

assert_inactive_bootstrap() {
  local label="$1"
  run_bootstrap "$FAKE_BIN:$EXTERNAL/mise/shims:$HOME_FIXTURE/.local/share/mise/shims:/usr/bin:/bin"
  assert_equals "$bootstrap_status" '0' "$label exits zero"
  assert_equals "$(grep '^active=' <<<"$bootstrap_out")" 'active=unset' \
    "$label stays inactive"
  assert_equals "$(grep '^config=' <<<"$bootstrap_out")" 'config=unset' \
    "$label clears inherited global config"
  assert_equals "$(grep '^data=' <<<"$bootstrap_out")" 'data=unset' \
    "$label clears inherited Mise data root"
  assert_equals "$(grep -E '^(installs|shims)=' <<<"$bootstrap_out" | tr '\n' '|')" \
    'installs=unset|shims=unset|' \
    "$label clears inherited Mise installs and shims overrides"
  if grep -Fq '/mise/shims' <<<"$(grep '^path=' <<<"$bootstrap_out")"; then
    fail "$label retained an inherited Mise shim path"
  fi
  pass "$label scrubs inherited Mise shim paths"
  assert_equals "$bootstrap_err_bytes" '0' "$label stays silent"
}

reset_state
create_valid_state
hostile_path=":$FAKE_BIN:.:relative/bin:/wildcard:/wild*:/usr/bin::$EXTERNAL/mise/shims:$EXTERNAL/direct-shims:/usr/bin:$HOME_FIXTURE/.local/share/mise/shims:/bin:"
run_bootstrap "$hostile_path"
assert_equals "$bootstrap_status" '0' 'valid applied bootstrap exits zero'
assert_equals "$(grep '^active=' <<<"$bootstrap_out")" 'active=1' \
  'valid applied bootstrap exports its activation sentinel'
assert_equals "$(grep '^config=' <<<"$bootstrap_out")" \
  "config=$HOME_CANONICAL/.dotfiles_state/toolchain/revisions/$REVISION_ID/config.toml" \
  'valid applied bootstrap exports the contained applied config'
assert_equals "$(grep '^data=' <<<"$bootstrap_out")" \
  "data=$HOME_CANONICAL/.local/share/mise" \
  'valid applied bootstrap replaces inherited Mise data root with canonical data'
assert_equals "$(grep '^installs=' <<<"$bootstrap_out")" \
  "installs=$HOME_CANONICAL/.local/share/mise/installs" \
  'valid applied bootstrap replaces inherited Mise installs directory'
assert_equals "$(grep '^shims=' <<<"$bootstrap_out")" \
  "shims=$HOME_CANONICAL/.local/share/mise/shims" \
  'valid applied bootstrap replaces inherited Mise shims directory'
valid_path="${bootstrap_out##*path=}"
[[ "$valid_path" == "$HOME_CANONICAL/.local/share/mise/shims:"* ]] ||
  fail 'valid applied bootstrap does not prepend canonical Mise shims'
[[ "$valid_path" != *"$EXTERNAL/mise/shims"* ]] ||
  fail 'valid applied bootstrap retains inherited custom Mise shims'
assert_equals "$valid_path" \
  "$HOME_CANONICAL/.local/share/mise/shims:$FAKE_BIN:/wildcard:/wild*:/usr/bin:/bin" \
  'valid bootstrap drops unsafe entries and deduplicates literal absolute PATH entries'
assert_equals "$(awk -F: -v shim="$HOME_CANONICAL/.local/share/mise/shims" \
  '{ count = 0; for (i = 1; i <= NF; i++) if ($i == shim) count++; print count }' \
  <<<"$valid_path")" '1' 'valid bootstrap publishes one canonical Mise shim entry'
assert_equals "$bootstrap_err_bytes" '0' 'valid applied bootstrap stays silent'

reset_state
assert_inactive_bootstrap 'missing current selection'

reset_state
mkdir -p "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions"
printf '%s\n' "revisions/$REVISION_ID" >"$HOME_FIXTURE/.dotfiles_state/toolchain/current"
assert_inactive_bootstrap 'non-symlink current selection'

for bad_target in \
  "revisions/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
  'revisions/short' \
  "revisions/$REVISION_ID/config.toml" \
  "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID"; do
  reset_state
  mkdir -p "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions"
  ln -s "$bad_target" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
  assert_inactive_bootstrap "invalid current target [$bad_target]"
done

reset_state
mkdir -p "$EXTERNAL/state/toolchain/revisions"
ln -s "$EXTERNAL/state" "$HOME_FIXTURE/.dotfiles_state"
assert_inactive_bootstrap 'symlinked state ancestor'

reset_state
mkdir -p "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions" "$EXTERNAL/revision"
printf '%s\n' '[tools]' >"$EXTERNAL/revision/config.toml"
ln -s "$EXTERNAL/revision" \
  "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID"
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
assert_inactive_bootstrap 'symlinked selected revision'

reset_state
mkdir -p "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID"
printf '%s\n' '[tools]' >"$EXTERNAL/config.toml"
ln -s "$EXTERNAL/config.toml" \
  "$HOME_FIXTURE/.dotfiles_state/toolchain/revisions/$REVISION_ID/config.toml"
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
assert_inactive_bootstrap 'symlinked applied config'

reset_state
create_valid_state
run_bootstrap "/usr/bin:/bin"
assert_equals "$bootstrap_status" '0' 'missing Mise executable bootstrap exits zero'
assert_equals "$(grep '^active=' <<<"$bootstrap_out")" 'active=unset' \
  'missing Mise executable leaves applied state inactive'
assert_equals "$(grep '^config=' <<<"$bootstrap_out")" 'config=unset' \
  'missing Mise executable clears inherited global config'
assert_equals "$(grep '^data=' <<<"$bootstrap_out")" 'data=unset' \
  'missing Mise executable clears inherited Mise data root'
assert_equals "$(grep -E '^(installs|shims)=' <<<"$bootstrap_out" | tr '\n' '|')" \
  'installs=unset|shims=unset|' \
  'missing Mise executable clears inherited installs and shims overrides'

# Run all four real zsh startup modes against valid applied state. A fake fnm
# and pyenv remain visible so the calls receipt proves active Mise gates their
# interactive ownership hooks rather than relying on absence.
#
# Every applied runtime exists twice: an empty Mise shim, and a decoy under
# ~/.local/bin, the user command directory .zshenv places ahead of the runtime
# bootstraps so a verified Mise selection can take priority over it. Resolution
# is observed with command -v, so no fake runtime supplies its own oracle.
# Interactive .zshrc deliberately restores ~/.local/bin ahead of the shims and
# delegates runtime precedence to mise activate, which the fake activation
# cannot prove; interactive rows therefore pin only that the shims stay on PATH.
SHIMS_DIR="$HOME_CANONICAL/.local/share/mise/shims"
DECOY_BIN="$HOME_FIXTURE/.local/bin"
mkdir -p "$HOME_FIXTURE/.local/share/mise/shims" "$DECOY_BIN"
APPLIED_RUNTIMES=(node bun python bd npm)
expected_shim_resolution=''
for runtime in "${APPLIED_RUNTIMES[@]}"; do
  printf '#!/bin/sh\nexit 0\n' >"$HOME_FIXTURE/.local/share/mise/shims/$runtime"
  printf '#!/bin/sh\nexit 96\n' >"$DECOY_BIN/$runtime"
  chmod +x "$HOME_FIXTURE/.local/share/mise/shims/$runtime" "$DECOY_BIN/$runtime"
  expected_shim_resolution+="$runtime=$SHIMS_DIR/$runtime|"
done
APPLIED_CONFIG="$HOME_CANONICAL/.dotfiles_state/toolchain/revisions/$REVISION_ID/config.toml"
applied_hash_before="$(shasum -a 256 "$APPLIED_CONFIG" | awk '{print $1}')"
all_modes=(noninteractive-nonlogin noninteractive-login interactive-nonlogin interactive-login)
for mode in "${all_modes[@]}"; do
  case "$mode" in
    noninteractive-nonlogin) flags=(-c) ;;
    noninteractive-login) flags=(-l -c) ;;
    interactive-nonlogin) flags=(-i -c) ;;
    interactive-login) flags=(-i -l -c) ;;
  esac
  rm -f "$RECORD_DIR"/*
  err_file="$TEST_ROOT/zsh-$mode.err"
  : >"$err_file"
  set +e
  # The isolated zsh child expands the effective startup variables.
  # shellcheck disable=SC2016
  zsh_out="$({
    env -i HOME="$HOME_FIXTURE" ZDOTDIR="$HOME_FIXTURE" \
      PATH="$FAKE_BIN:$EXTERNAL/mise/shims:/usr/bin:/bin" \
      MISE_DATA_DIR="$EXTERNAL/mise" MISE_INSTALLS_DIR="$EXTERNAL/installs" \
      MISE_SHIMS_DIR="$EXTERNAL/direct-shims" \
      RECORD_DIR="$RECORD_DIR" TERM=dumb CONTRACT_SHIMS_DIR="$SHIMS_DIR" \
      /bin/zsh "${flags[@]}" '
        print -r -- "active=${DOTFILES_MISE_ACTIVE-unset}"
        print -r -- "config=${MISE_GLOBAL_CONFIG_FILE-unset}"
        print -r -- "activated=${CONTRACT_MISE_ACTIVATED-unset}"
        print -r -- "directories=${MISE_DATA_DIR-unset}|${MISE_INSTALLS_DIR-unset}|${MISE_SHIMS_DIR-unset}"
        if alias python >/dev/null 2>&1; then print -r -- alias=yes; else print -r -- alias=no; fi
        resolved=""
        for runtime in node bun python bd npm; do
          resolved+="$runtime=$(command -v "$runtime" 2>/dev/null || print -r -- missing)|"
        done
        print -r -- "resolved=$resolved"
        case ":$PATH:" in
          *":$CONTRACT_SHIMS_DIR:"*) print -r -- shims-on-path=yes ;;
          *) print -r -- shims-on-path=no ;;
        esac
      '
  } 2>"$err_file")"
  zsh_status=$?
  set -e
  assert_equals "$zsh_status" '0' "$mode zsh startup exits zero"
  assert_equals "$(wc -c <"$err_file" | tr -d ' ')" '0' "$mode zsh startup keeps stderr empty"
  grep -Fxq 'active=1' <<<"$zsh_out" || fail "$mode did not select applied Mise state"
  pass "$mode selects applied Mise state"
  grep -Fxq "directories=$HOME_CANONICAL/.local/share/mise|$HOME_CANONICAL/.local/share/mise/installs|$HOME_CANONICAL/.local/share/mise/shims" <<<"$zsh_out" ||
    fail "$mode retained a hostile Mise directory override"
  pass "$mode exports the canonical Mise directory layout"
  if [[ "$mode" == interactive-* ]]; then
    grep -Fxq 'shims-on-path=yes' <<<"$zsh_out" || fail "$mode dropped the applied Mise shims from PATH"
    pass "$mode keeps the applied Mise shims on PATH for activation"
    grep -Fxq 'activated=1' <<<"$zsh_out" || fail "$mode did not run Mise activation"
    pass "$mode runs normal Mise activation"
    grep -Fxq 'alias=no' <<<"$zsh_out" || fail "$mode retained the fallback Python alias"
    pass "$mode suppresses the fallback Python alias"
    grep -Fxq 'activate zsh' "$RECORD_DIR/mise-calls" || fail "$mode did not record Mise activation"
    pass "$mode records exactly the interactive Mise activation seam"
    if [[ -e "$RECORD_DIR/pyenv-calls" ]]; then
      fail "$mode invoked pyenv while applied Mise was active"
    fi
    pass "$mode does not initialize pyenv while applied Mise is active"
    if [[ -e "$RECORD_DIR/fnm-calls" ]] && grep -Fq -- '--use-on-cd' "$RECORD_DIR/fnm-calls"; then
      fail "$mode invoked the interactive fnm hook while applied Mise was active"
    fi
    pass "$mode does not initialize the interactive fnm hook"
  else
    assert_equals "$(grep '^resolved=' <<<"$zsh_out")" "resolved=$expected_shim_resolution" \
      "$mode resolves every applied runtime to its Mise shim ahead of ~/.local/bin"
    grep -Fxq 'activated=unset' <<<"$zsh_out" || fail "$mode unexpectedly activated Mise"
    pass "$mode uses shims without interactive activation"
    if [[ -e "$RECORD_DIR/mise-calls" ]]; then
      fail "$mode invoked Mise instead of using bootstrap shims"
    fi
    pass "$mode makes no Mise activation call"
  fi
done

agent_err="$TEST_ROOT/agent-lane.err"
: >"$agent_err"
set +e
# The isolated agent zsh child expands the runtime lookups.
# shellcheck disable=SC2016
agent_out="$({
  env -i HOME="$HOME_FIXTURE" ZDOTDIR="$HOME_FIXTURE" \
    PATH="$FAKE_BIN:/usr/bin:/bin" RECORD_DIR="$RECORD_DIR" \
    "$REPO_ROOT/bin/agent-lane-zsh" -c '
      resolved=""
      for runtime in node bun python bd npm; do
        resolved+="$runtime=$(command -v "$runtime" 2>/dev/null || print -r -- missing)|"
      done
      print -r -- "$resolved"
    '
} 2>"$agent_err")"
agent_status=$?
set -e
assert_equals "$agent_status" '0' 'agent zsh launch exits zero'
assert_equals "$agent_out" "$expected_shim_resolution" \
  'agent zsh launch resolves every applied runtime to its Mise shim ahead of ~/.local/bin'
assert_equals "$(wc -c <"$agent_err" | tr -d ' ')" '0' 'agent zsh launch stays silent'
assert_equals "$(shasum -a 256 "$APPLIED_CONFIG" | awk '{print $1}')" "$applied_hash_before" \
  'zsh startup and the agent launch preserve the applied config bytes'

rm -f "$RECORD_DIR"/*
husky_err="$TEST_ROOT/husky.err"
: >"$husky_err"
set +e
# The isolated POSIX child expands HOME and the bootstrap variables.
# shellcheck disable=SC2016
husky_out="$({
  env -i HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/usr/bin:/bin" \
    MISE_DATA_DIR="$EXTERNAL/mise" MISE_INSTALLS_DIR="$EXTERNAL/installs" \
    MISE_SHIMS_DIR="$EXTERNAL/direct-shims" \
    RECORD_DIR="$RECORD_DIR" /bin/sh -c '
      . "$HOME/.config/husky/init.sh"
      printf "active=%s\n" "${DOTFILES_MISE_ACTIVE-unset}"
      printf "fnm=%s\n" "${CONTRACT_FNM_BOOTSTRAPPED-unset}"
      printf "data=%s\n" "${MISE_DATA_DIR-unset}"
      printf "directories=%s|%s|%s\n" "${MISE_DATA_DIR-unset}" "${MISE_INSTALLS_DIR-unset}" "${MISE_SHIMS_DIR-unset}"
      printf "path=%s\n" "$PATH"
    '
} 2>"$husky_err")"
husky_status=$?
set -e
assert_equals "$husky_status" '0' 'Husky POSIX bootstrap exits zero'
assert_equals "$(wc -c <"$husky_err" | tr -d ' ')" '0' \
  'Husky POSIX bootstrap stays silent'
grep -Fxq 'active=1' <<<"$husky_out" || fail 'Husky did not select applied Mise state'
pass 'Husky selects applied Mise state'
grep -Fxq 'fnm=1' <<<"$husky_out" || fail 'Husky did not run the retained fnm fallback first'
pass 'Husky runs the retained fnm fallback before Mise selection'
assert_equals "$(grep '^data=' <<<"$husky_out")" \
  "data=$HOME_CANONICAL/.local/share/mise" \
  'Husky exports the canonical Mise data root'
assert_equals "$(grep '^directories=' <<<"$husky_out")" \
  "directories=$HOME_CANONICAL/.local/share/mise|$HOME_CANONICAL/.local/share/mise/installs|$HOME_CANONICAL/.local/share/mise/shims" \
  'Husky exports the canonical Mise installs and shims directories'
[[ "$(grep '^path=' <<<"$husky_out")" == "path=$HOME_CANONICAL/.local/share/mise/shims:"* ]] ||
  fail 'Husky does not give applied Mise shims precedence'
pass 'Husky gives applied Mise shims precedence'
if [[ -e "$RECORD_DIR/mise-calls" ]]; then
  fail 'Husky invoked interactive Mise activation'
fi
pass 'Husky uses shims without interactive Mise activation'

# Exercise the public verifier with a small test-owned toolchain adapter. Other
# machine checks intentionally fail in this isolated HOME; this slice observes
# only the three new checks and their distinct repair paths.
VERIFY_DOTFILES="$TEST_ROOT/verify-dotfiles"
HOSTILE_DOTFILES="$TEST_ROOT/hostile-dotfiles"
mkdir -p "$VERIFY_DOTFILES/bin/dotfiles" "$VERIFY_DOTFILES/config/mise" \
  "$VERIFY_DOTFILES/config/node" "$HOSTILE_DOTFILES/config/mise"
sed "s#/opt/homebrew#${EMPTY_PREFIX}#g" "$REPO_ROOT/verify_install.sh" \
  >"$VERIFY_DOTFILES/verify_install.sh"
cp "$REPO_ROOT/config/mise/bootstrap.sh" "$VERIFY_DOTFILES/config/mise/bootstrap.sh"
cp "$REPO_ROOT/config/node/version" "$VERIFY_DOTFILES/config/node/version"
chmod +x "$VERIFY_DOTFILES/verify_install.sh"
cat >"$HOSTILE_DOTFILES/config/mise/bootstrap.sh" <<'STUB'
#!/bin/sh
: >"$HOME/hostile-dotfiles-used"
STUB

cat >"$VERIFY_DOTFILES/bin/dotfiles/toolchain" <<'STUB'
#!/bin/sh
if [ "$(cat "$(dirname "$0")/../../verifier-state")" = ready ]; then
  cat <<'JSON'
{"status":"ready","tools":[{"name":"node","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"bun","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"python","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"bd","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"npm","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true,"owning_node_runtime":{"status":"observed","tool":"node","effective_version":"26.9.0","executable_path":"/fixture/node","npm_effective_version":"11.19.1","npm_executable_path":"/fixture/npm","mise_routed_npm_path":"/fixture/npm","matches_declared_parent":true}}]}
JSON
  exit 2
fi
cat <<'JSON'
{"status":"not_ready","tools":[{"name":"node","selected_owner":"mise","observed_owner":"fnm","selected_owner_matches":false,"version_matches":true,"declaration_matches":true},{"name":"bun","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"python","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"bd","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true},{"name":"npm","selected_owner":"mise","observed_owner":"mise","selected_owner_matches":true,"version_matches":true,"declaration_matches":true}]}
JSON
exit 1
STUB
chmod +x "$VERIFY_DOTFILES/bin/dotfiles/toolchain"

run_verifier() {
  local verifier_path="$1"
  set +e
  verifier_out="$(env -i HOME="$HOME_FIXTURE" DOTFILES="$HOSTILE_DOTFILES" \
    DOTFILES_PROFILE=desktop PATH="$verifier_path" \
    "$VERIFY_DOTFILES/verify_install.sh" --quiet 2>&1)"
  verifier_status=$?
  set -e
}

printf '%s\n' ready >"$VERIFY_DOTFILES/verifier-state"
run_verifier "$FAKE_BIN:/usr/bin:/bin"
assert_equals "$verifier_status" '1' \
  'isolated verifier retains unrelated incomplete-host failures'
if [[ -e "$HOME_FIXTURE/hostile-dotfiles-used" ]]; then
  fail 'verifier accepted hostile inherited DOTFILES redirection'
fi
pass 'verifier derives its repository root from its canonical script location'
if grep -Fq 'Mise applied selection' <<<"$verifier_out"; then
  fail 'verifier rejected a valid applied selection'
fi
pass 'verifier accepts a valid applied selection through the shared bootstrap'
if grep -Fq 'Mise effective toolchain ownership' <<<"$verifier_out"; then
  fail 'verifier rejected ready effective Mise ownership'
fi
pass 'verifier accepts ready effective Mise ownership'

rm "$HOME_FIXTURE/.dotfiles_state/toolchain/current"
run_verifier "$FAKE_BIN:/usr/bin:/bin"
grep -Fq 'Mise applied selection' <<<"$verifier_out" ||
  fail 'verifier did not name the invalid current selection'
pass 'verifier names an invalid current selection separately'
grep -Fq 'toolchain update --apply --json' <<<"$verifier_out" ||
  fail 'invalid current guidance omitted the public apply repair'
pass 'invalid current guidance names the public apply repair'
ln -s "revisions/$REVISION_ID" "$HOME_FIXTURE/.dotfiles_state/toolchain/current"

mv "$FAKE_BIN/mise" "$FAKE_BIN/mise.unavailable"
run_verifier "$FAKE_BIN:/usr/bin:/bin"
grep -Fq 'declared package owner is unavailable' <<<"$verifier_out" ||
  fail 'verifier did not give missing Mise its package-owner repair'
pass 'verifier gives missing Mise a distinct package-owner repair'
mv "$FAKE_BIN/mise.unavailable" "$FAKE_BIN/mise"

printf '%s\n' drift >"$VERIFY_DOTFILES/verifier-state"
run_verifier "$FAKE_BIN:/usr/bin:/bin"
grep -Fq 'Mise effective toolchain ownership' <<<"$verifier_out" ||
  fail 'verifier did not name effective owner drift'
pass 'verifier names effective owner drift separately'
grep -Fq 'update --apply --retry --json' <<<"$verifier_out" ||
  fail 'effective owner drift guidance omitted bounded retry'
pass 'effective owner drift guidance names bounded apply retry'

expected_assertions=132
[[ "$assertion_count" -eq "$expected_assertions" ]] ||
  fail "expected $expected_assertions assertions, observed $assertion_count"
printf '1..%d\n' "$assertion_count"
