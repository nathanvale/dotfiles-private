#!/usr/bin/env bash
# Public process contract for the read-only toolchain status and preview commands.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CLI="$REPO_ROOT/bin/dotfiles/toolchain"
TEST_ROOT="$(mktemp -d)"
HOME_ROOT="$TEST_ROOT/home"
mkdir -p "$HOME_ROOT"
HOME_CANONICAL="$(CDPATH='' cd -P "$HOME_ROOT" && pwd)"
FAKE_BIN="$TEST_ROOT/bin"
MISE_BIN="$TEST_ROOT/mise-bin"
READY_BIN="$TEST_ROOT/ready-bin"
SHIM_DATA="$HOME_CANONICAL/.local/share/mise"
SHIM_BIN="$SHIM_DATA/shims"
HOSTILE_MISE_DATA="$TEST_ROOT/hostile-mise-data"
HOSTILE_SHIM_BIN="$HOSTILE_MISE_DATA/shims"
PYENV_DATA="$TEST_ROOT/pyenv-data"
PYENV_SHIM="$PYENV_DATA/shims"
LEDGER="$TEST_ROOT/external-command-ledger"
MISE_ENV_LEDGER="$TEST_ROOT/mise-env-ledger"
ORACLE="$TEST_ROOT/oracle.tsv"
PREVIEW_REPO="$TEST_ROOT/preview-repo"
PREVIEW_CLI="$PREVIEW_REPO/bin/dotfiles/toolchain"
BROKEN_REPO="$TEST_ROOT/broken-repo"
SPECIAL_REPO="$TEST_ROOT/"$'source\n\t"\\'
VERIFY_REPO="$TEST_ROOT/verify-repo"
assertion_count=0

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { assertion_count=$((assertion_count + 1)); printf 'ok %d - %s\n' "$assertion_count" "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
assert_equals() { [[ "$1" == "$2" ]] || fail "$3 (expected [$1], got [$2])"; pass "$3"; }
assert_contains() { grep -Fq -- "$2" <<<"$1" || fail "$3 (missing [$2])"; pass "$3"; }

# Independent oracle. These literals are test-owned and never imported from the
# manifest or Mise declaration under test.
cat >"$ORACLE" <<'EOF'
# tool|version|selected_owner|qualification|fixture_observed_owner
node|26.9.0|mise|source_declared|mise
bun|1.4.0|mise|source_declared|mise
python|3.11.9|mise|source_declared|mise
bd|1.3.0|mise|source_declared|mise
git|2.50.1|system|unqualified|unknown
npm|11.19.1|mise|source_declared|mise
EOF

oracle() {
	local tool="$1" column="$2"
	awk -F '|' -v tool="$tool" -v column="$column" '$1 == tool { print $column; exit }' "$ORACLE"
}

run_cli_in_path() {
	local test_path="$1"
	shift
	local output status
	set +e
	output="$(HOME="$HOME_ROOT" PATH="$test_path:/usr/bin:/bin" \
		MISE_TEST_NODE_PATH="${MISE_TEST_NODE_PATH:-}" MISE_TEST_NPM_PATH="${MISE_TEST_NPM_PATH:-}" \
		MISE_TEST_RESULT_DIR="${MISE_TEST_RESULT_DIR:-}" \
		"$@" 2>"$TEST_ROOT/stderr")"
	status=$?
	set -e
	printf '%s\n%s\n' "$status" "$output"
}

run_cli() { run_cli_in_path "$MISE_BIN:$FAKE_BIN" "$@"; }

run_verifier() {
	local output status
	set +e
	output="$(DOTFILES="$VERIFY_REPO" DOTFILES_PROFILE=desktop PATH="$MISE_BIN:$FAKE_BIN:/opt/homebrew/bin:/usr/bin:/bin" "$VERIFY_REPO/verify_install.sh" --quiet 2>&1)"
	status=$?
	set -e
	printf '%s\n%s\n' "$status" "$output"
}

repo_snapshot() {
	(
		cd "$PREVIEW_REPO"
		git rev-parse --verify HEAD
		git branch --show-current
		git diff --cached --binary
		git status --porcelain=v1
		git stash list
		find . -print | LC_ALL=C sort | while IFS= read -r path; do
			if [[ -L "$path" ]]; then
				printf 'symlink|%s|%s|%s\n' "$path" "$(stat -f '%p' "$path")" "$(readlink "$path")"
			elif [[ -d "$path" ]]; then
				printf 'directory|%s|%s\n' "$path" "$(stat -f '%p' "$path")"
			elif [[ -f "$path" ]]; then
				printf 'file|%s|%s|%s\n' "$path" "$(stat -f '%p' "$path")" "$(shasum "$path")"
			fi
		done
	) | shasum | awk '{print $1}'
}

mkdir -p "$FAKE_BIN" "$MISE_BIN"
cat >"$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
printf 'node %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf 'v%s\n' "$ORACLE_NODE_VERSION"
EOF
cat >"$FAKE_BIN/bun" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
printf 'bun %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf '%s\n' "${BUN_TEST_VERSION:-$ORACLE_BUN_VERSION}"
EOF
cat >"$FAKE_BIN/python" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
printf 'python %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf 'Python %s\n' "$ORACLE_PYTHON_VERSION"
EOF
cat >"$FAKE_BIN/bd" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
printf 'bd %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf 'bd version %s (fixture)\n' "$ORACLE_BD_VERSION"
EOF
cat >"$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
printf 'git %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf 'git version %s (fixture)\n' "$ORACLE_GIT_VERSION"
EOF
cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
printf 'npm %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf '%s\n' "$ORACLE_NPM_VERSION"
EOF
cat >"$FAKE_BIN/brew" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--prefix' ]] || exit 97
printf 'brew %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf '%s\n' "$BREW_TEST_PREFIX"
[[ "${BREW_TEST_PREFIX_FAIL:-false}" == true ]] && exit 1
EOF
cat >"$MISE_BIN/mise" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == 'which' && ( "$2" == node || "$2" == bun || "$2" == python || "$2" == bd || "$2" == npm ) ]] || exit 97
printf 'mise %s %s\n' "$1" "$2" >>"$TOOLCHAIN_COMMAND_LEDGER"
printf '%s|%s|%s\n' "${MISE_DATA_DIR:-unset}" "${MISE_INSTALLS_DIR:-unset}" "${MISE_SHIMS_DIR:-unset}" >>"$TOOLCHAIN_MISE_ENV_LEDGER"
if [[ "${MISE_TEST_WHICH_FAIL:-false}" == true ]]; then
  [[ -n "${MISE_TEST_FAIL_OUTPUT:-}" ]] && printf '%s\n' "$MISE_TEST_FAIL_OUTPUT"
  exit 1
fi
if [[ "$2" == node && -n "${MISE_TEST_NODE_PATH:-}" ]]; then
  printf '%s\n' "$MISE_TEST_NODE_PATH"
elif [[ "$2" == npm && -n "${MISE_TEST_NPM_PATH:-}" ]]; then
  printf '%s\n' "$MISE_TEST_NPM_PATH"
elif [[ -n "${MISE_TEST_PATH:-}" ]]; then
  printf '%s\n' "$MISE_TEST_PATH"
elif [[ -n "${MISE_TEST_RESULT_DIR:-}" ]]; then
  printf '%s/%s\n' "$MISE_TEST_RESULT_DIR" "$2"
else
  printf '%s/%s\n' "$MISE_TEST_BIN" "$2"
fi
EOF
cat >"$FAKE_BIN/pyenv" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == 'which python' ]] || exit 97
printf 'pyenv %s\n' "$*" >>"$TOOLCHAIN_COMMAND_LEDGER"
[[ "${PYENV_TEST_WHICH_FAIL:-false}" == true ]] && exit 1
printf '%s\n' "${PYENV_TEST_PATH:-$PYENV_TEST_BIN}"
EOF
chmod +x "$FAKE_BIN/node" "$FAKE_BIN/bun" "$FAKE_BIN/python" "$FAKE_BIN/bd" "$FAKE_BIN/git" "$FAKE_BIN/npm" "$FAKE_BIN/brew" "$FAKE_BIN/pyenv" "$MISE_BIN/mise"
mkdir -p "$HOME_ROOT" "$SHIM_BIN" "$HOSTILE_SHIM_BIN"
cp "$FAKE_BIN/node" "$SHIM_BIN/node"
cp "$FAKE_BIN/bun" "$SHIM_BIN/bun"
cp "$FAKE_BIN/python" "$SHIM_BIN/python"
cp "$FAKE_BIN/bd" "$SHIM_BIN/bd"
cp "$FAKE_BIN/npm" "$SHIM_BIN/npm"
chmod +x "$SHIM_BIN/node" "$SHIM_BIN/bun" "$SHIM_BIN/python" "$SHIM_BIN/bd" "$SHIM_BIN/npm"
cp "$FAKE_BIN/node" "$HOSTILE_SHIM_BIN/node"
chmod +x "$HOSTILE_SHIM_BIN/node"
mkdir -p "$PYENV_SHIM"
cp "$FAKE_BIN/python" "$PYENV_SHIM/python"
chmod +x "$PYENV_SHIM/python"

export TOOLCHAIN_COMMAND_LEDGER="$LEDGER"
export TOOLCHAIN_MISE_ENV_LEDGER="$MISE_ENV_LEDGER"
export MISE_DATA_DIR="$HOSTILE_MISE_DATA"
export MISE_INSTALLS_DIR="$TEST_ROOT/hostile-mise-installs"
export MISE_SHIMS_DIR="$TEST_ROOT/hostile-mise-shims"
export MISE_TEST_BIN="$FAKE_BIN"
export MISE_TEST_NODE_PATH=''
export MISE_TEST_NPM_PATH=''
export PYENV_TEST_BIN="$FAKE_BIN/python"
export BREW_TEST_PREFIX="$TEST_ROOT/not-homebrew"
ORACLE_NODE_VERSION="$(oracle node 2)"
ORACLE_BUN_VERSION="$(oracle bun 2)"
ORACLE_PYTHON_VERSION="$(oracle python 2)"
ORACLE_BD_VERSION="$(oracle bd 2)"
ORACLE_GIT_VERSION="$(oracle git 2)"
ORACLE_NPM_VERSION="$(oracle npm 2)"
export ORACLE_NODE_VERSION ORACLE_BUN_VERSION ORACLE_PYTHON_VERSION ORACLE_BD_VERSION ORACLE_GIT_VERSION ORACLE_NPM_VERSION

mkdir -p "$PREVIEW_REPO/bin/dotfiles" "$PREVIEW_REPO/config/toolchain" "$PREVIEW_REPO/config/mise"
cp "$CLI" "$PREVIEW_CLI"
cp "$REPO_ROOT/config/toolchain/versions.tsv" "$PREVIEW_REPO/config/toolchain/versions.tsv"
cp "$REPO_ROOT/config/mise/source.toml" "$PREVIEW_REPO/config/mise/source.toml"
chmod +x "$PREVIEW_CLI"
git -C "$PREVIEW_REPO" init --quiet
printf 'tracked original\n' >"$PREVIEW_REPO/unrelated-tracked-file"
git -C "$PREVIEW_REPO" add bin/dotfiles/toolchain config/toolchain/versions.tsv config/mise/source.toml unrelated-tracked-file
git -C "$PREVIEW_REPO" -c user.name='toolchain test' -c user.email='toolchain-test@example.invalid' commit --quiet -m 'test fixture'
printf 'tracked modified\n' >"$PREVIEW_REPO/unrelated-tracked-file"
printf 'unrelated dirty input\n' >"$PREVIEW_REPO/unrelated-untracked-file"
ln -s unrelated-untracked-file "$PREVIEW_REPO/unrelated-link"
mkdir "$PREVIEW_REPO/unrelated-empty-directory"

mkdir -p "$VERIFY_REPO/bin/dotfiles" "$VERIFY_REPO/config/toolchain" "$VERIFY_REPO/config/mise"
cp "$REPO_ROOT/verify_install.sh" "$VERIFY_REPO/verify_install.sh"
cp "$CLI" "$VERIFY_REPO/bin/dotfiles/toolchain"
cp "$REPO_ROOT/config/toolchain/versions.tsv" "$VERIFY_REPO/config/toolchain/versions.tsv"
cp "$REPO_ROOT/config/mise/source.toml" "$VERIFY_REPO/config/mise/source.toml"
chmod +x "$VERIFY_REPO/verify_install.sh" "$VERIFY_REPO/bin/dotfiles/toolchain"

help_output="$($CLI --help)"
assert_contains "$help_output" 'toolchain status [--json]' 'help discovers status JSON mode'
assert_contains "$help_output" 'toolchain update --preview [--json]' 'help discovers read-only update preview'

: >"$LEDGER"
result="$(run_cli "$CLI" status --json)"
status="$(sed -n '1p' <<<"$result")"
json="$(sed -n '2,$p' <<<"$result")"
assert_equals '1' "$status" 'arbitrary fake Git path does not satisfy selected system ownership'
assert_equals 'not_ready' "$(jq -r '.status' <<<"$json")" 'status distinguishes selected-owner mismatch'
assert_equals 'not_qualified' "$(jq -r '.exact_reconstruction' <<<"$json")" 'source declarations do not claim exact reconstruction'
for tool in node bun python bd git npm; do
	assert_equals "$(oracle "$tool" 2)" "$(jq -r --arg tool "$tool" '.tools[] | select(.name == $tool) | .expected_version' <<<"$json")" "$tool expected version comes from the independent oracle"
	assert_equals 'true' "$(jq -r --arg tool "$tool" '.tools[] | select(.name == $tool) | .version_matches' <<<"$json")" "$tool matching version is proved against the independent oracle"
done
assert_equals "$(oracle node 3)" "$(jq -r '.tools[] | select(.name == "node") | .selected_owner' <<<"$json")" 'Node selected owner comes from the independent oracle'
assert_equals "$(oracle node 5)" "$(jq -r '.tools[] | select(.name == "node") | .observed_owner' <<<"$json")" 'Node observed owner is Mise'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "node") | .selected_owner_matches' <<<"$json")" 'Node effective path satisfies selected Mise owner'
assert_equals "$(oracle node 4)" "$(jq -r '.tools[] | select(.name == "node") | .qualification' <<<"$json")" 'Node reports source-declared qualification'
assert_equals "$(oracle python 5)" "$(jq -r '.tools[] | select(.name == "python") | .observed_owner' <<<"$json")" 'Python observed owner is Mise'
assert_equals "$(oracle python 2)" "$(jq -r '.tools[] | select(.name == "python") | .effective_version' <<<"$json")" 'Python reports its exact effective version'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "python") | .declaration_matches' <<<"$json")" 'Python matches its Mise declaration'
assert_equals 'node' "$(jq -r '.tools[] | select(.name == "npm") | .parent_tool' <<<"$json")" 'npm declares Node as its declared parent'
assert_equals "$(oracle npm 5)" "$(jq -r '.tools[] | select(.name == "npm") | .observed_owner' <<<"$json")" 'npm observed owner is Mise'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "npm") | .declaration_matches' <<<"$json")" 'npm matches its separate Mise declaration'
assert_equals 'node' "$(jq -r '.tools[] | select(.name == "npm") | .declared_parent.tool' <<<"$json")" 'npm declared parent identifies Node'
assert_equals "$(oracle node 2)" "$(jq -r '.tools[] | select(.name == "npm") | .declared_parent.declared_version' <<<"$json")" 'npm declared parent reports the declared Node version'
assert_equals "$(oracle node 3)" "$(jq -r '.tools[] | select(.name == "npm") | .declared_parent.selected_owner' <<<"$json")" 'npm declared parent reports the selected Node owner'
assert_equals 'observed' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.status' <<<"$json")" 'npm reports an observed owning Node runtime'
assert_equals 'node' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.tool' <<<"$json")" 'npm observed runtime identifies Node'
assert_equals "$(oracle node 2)" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.effective_version' <<<"$json")" 'npm observed runtime reports the Node executable version'
assert_equals "$FAKE_BIN/node" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.executable_path' <<<"$json")" 'npm observed runtime reports the Node executable path'
assert_equals "$(oracle npm 2)" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.npm_effective_version' <<<"$json")" 'npm observed runtime reports the Node-bundled npm version'
assert_equals "$FAKE_BIN/npm" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.npm_executable_path' <<<"$json")" 'npm observed runtime reports the npm executable path'
assert_equals "$FAKE_BIN/npm" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.mise_routed_npm_path' <<<"$json")" 'npm observed runtime reports Mise routing to the Node sibling'
assert_equals 'same_mise_install_bin' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.relationship' <<<"$json")" 'npm ownership is proved by one observed Mise installation bin'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.matches_declared_parent' <<<"$json")" 'npm observed Node runtime matches its declared parent'
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "git") | .observed_owner' <<<"$json")" 'arbitrary fake Git path is not observed as system Git'
assert_equals 'false' "$(jq -r '.tools[] | select(.name == "git") | .selected_owner_matches' <<<"$json")" 'system selected owner requires the system executable path'
assert_equals '0' "$(wc -c <"$TEST_ROOT/stderr" | tr -d ' ')" 'status JSON keeps ordinary diagnostics off stderr'
CANONICAL_MISE_DATA="$(CDPATH='' cd -P "$HOME_ROOT" && pwd)/.local/share/mise"
CANONICAL_MISE_CUSTODY="$CANONICAL_MISE_DATA|$CANONICAL_MISE_DATA/installs|$CANONICAL_MISE_DATA/shims"
assert_equals '1' "$(awk -v expected="$CANONICAL_MISE_CUSTODY" 'NF && $0 != expected { bad=1 } END { if (bad || NR == 0) print 0; else print 1 }' "$MISE_ENV_LEDGER")" 'status replaces every hostile Mise directory override on every ownership probe'

# A fully ready selection still returns 2 while the source-only declaration is
# not qualified. Keep system Git out of the fixture PATH so this row proves the
# command's distinct ready-but-unqualified exit contract.
mkdir -p "$READY_BIN"
for tool in node bun python bd npm; do
	cp "$FAKE_BIN/$tool" "$READY_BIN/$tool"
done
chmod +x "$READY_BIN/node" "$READY_BIN/bun" "$READY_BIN/python" "$READY_BIN/bd" "$READY_BIN/npm"
ready_result="$(MISE_TEST_RESULT_DIR="$READY_BIN" run_cli_in_path "$MISE_BIN:$READY_BIN" "$CLI" status --json)"
ready_status="$(sed -n '1p' <<<"$ready_result")"
ready_json="$(sed -n '2,$p' <<<"$ready_result")"
assert_equals '2' "$ready_status" 'ready but source-only status preserves the qualification exit'
assert_equals 'ready' "$(jq -r '.status' <<<"$ready_json")" 'ready status is distinct from its qualification state'
assert_equals 'not_qualified' "$(jq -r '.exact_reconstruction' <<<"$ready_json")" 'ready status retains the unqualified reconstruction state'
for tool in node bun python bd npm; do
	assert_equals "$READY_BIN/$tool" "$(jq -r --arg tool "$tool" '.tools[] | select(.name == $tool) | .executable_path' <<<"$ready_json")" "$tool ready status reports its selected executable path"
	assert_equals "$(oracle "$tool" 2)" "$(jq -r --arg tool "$tool" '.tools[] | select(.name == $tool) | .effective_version' <<<"$ready_json")" "$tool ready status reports its declared version"
done
assert_equals '/usr/bin/git' "$(jq -r '.tools[] | select(.name == "git") | .executable_path' <<<"$ready_json")" 'ready status reports the selected system Git path'
assert_equals 'system' "$(jq -r '.tools[] | select(.name == "git") | .observed_owner' <<<"$ready_json")" 'ready status observes system Git ownership'

SPLIT_NODE_BIN="$TEST_ROOT/split-node/bin"
SPLIT_NPM_BIN="$TEST_ROOT/split-npm/bin"
mkdir -p "$SPLIT_NODE_BIN" "$SPLIT_NPM_BIN"
cp "$FAKE_BIN/node" "$SPLIT_NODE_BIN/node"
cp "$FAKE_BIN/npm" "$SPLIT_NODE_BIN/npm"
cp "$FAKE_BIN/npm" "$SPLIT_NPM_BIN/npm"
export MISE_TEST_NODE_PATH="$SPLIT_NODE_BIN/node"
export MISE_TEST_NPM_PATH="$SPLIT_NPM_BIN/npm"
split_parent_result="$(run_cli_in_path "$MISE_BIN:$SHIM_BIN:$FAKE_BIN" "$CLI" status --json)"
export MISE_TEST_NODE_PATH=''
export MISE_TEST_NPM_PATH=''
split_parent_status="$(sed -n '1p' <<<"$split_parent_result")"
split_parent_json="$(sed -n '2,$p' <<<"$split_parent_result")"
assert_equals '1' "$split_parent_status" 'split npm and Node installations make status not ready'
assert_equals 'unobserved' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.status' <<<"$split_parent_json")" 'split installations do not claim observed npm ownership'
assert_equals "$SPLIT_NODE_BIN/node" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.executable_path' <<<"$split_parent_json")" 'failed ownership retains observed Node path evidence'
assert_equals "$SPLIT_NODE_BIN/npm" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.npm_executable_path' <<<"$split_parent_json")" 'failed ownership retains derived Node-sibling npm path evidence'
assert_equals "$SPLIT_NPM_BIN/npm" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.mise_routed_npm_path' <<<"$split_parent_json")" 'failed ownership retains stale standalone Mise npm routing evidence'
assert_equals 'false' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.matches_declared_parent' <<<"$split_parent_json")" 'split installations fail the declared-parent match'
assert_equals 'Repair npm and Node so Mise resolves both from one observed installation, then rerun this read-only command.' "$(jq -r '.next_action' <<<"$split_parent_json")" 'split ownership gives a specific repair action'

export MISE_TEST_NODE_PATH="$SPLIT_NODE_BIN/node"
export MISE_TEST_NPM_PATH="$SPLIT_NPM_BIN/npm"
stale_preview_result="$(run_cli_in_path "$MISE_BIN:$SHIM_BIN:$FAKE_BIN" "$CLI" update --preview --json)"
export MISE_TEST_NODE_PATH=''
export MISE_TEST_NPM_PATH=''
stale_preview_json="$(sed -n '2,$p' <<<"$stale_preview_result")"
assert_equals 'not_ready' "$(jq -r '.status' <<<"$stale_preview_json")" 'stale standalone npm routing makes preview not ready'
assert_equals 'install_or_select' "$(jq -r '.planned_actions[] | select(.tool == "npm") | .action' <<<"$stale_preview_json")" 'stale standalone npm routing is never previewed as no change'

export MISE_TEST_NODE_PATH="$TEST_ROOT/missing-node"
missing_parent_result="$(run_cli_in_path "$MISE_BIN:$SHIM_BIN:$FAKE_BIN" "$CLI" status --json)"
export MISE_TEST_NODE_PATH=''
missing_parent_json="$(sed -n '2,$p' <<<"$missing_parent_result")"
assert_equals 'unobserved' "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.status' <<<"$missing_parent_json")" 'missing owning Node executable is an honest unobserved failure'
assert_equals "$TEST_ROOT/missing-node" "$(jq -r '.tools[] | select(.name == "npm") | .owning_node_runtime.executable_path' <<<"$missing_parent_json")" 'missing owning Node failure retains its returned path evidence'

mismatch_result="$(BUN_TEST_VERSION=9.9.9 run_cli "$CLI" status --json)"
mismatch_status="$(sed -n '1p' <<<"$mismatch_result")"
mismatch_json="$(sed -n '2,$p' <<<"$mismatch_result")"
assert_equals '1' "$mismatch_status" 'version mismatch exits 1'
assert_equals 'false' "$(jq -r '.tools[] | select(.name == "bun") | .version_matches' <<<"$mismatch_json")" 'version mismatch is structured without scraping text'

missing_owner_result="$(run_cli_in_path "$FAKE_BIN" "$CLI" status --json)"
missing_owner_json="$(sed -n '2,$p' <<<"$missing_owner_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "node") | .observed_owner' <<<"$missing_owner_json")" 'missing Mise is observed as unknown ownership'
assert_equals 'false' "$(jq -r '.tools[] | select(.name == "node") | .selected_owner_matches' <<<"$missing_owner_json")" 'missing Mise fails selected-owner matching'

wrong_owner_result="$(MISE_TEST_PATH='/not-owned/node' run_cli "$CLI" status --json)"
wrong_owner_json="$(sed -n '2,$p' <<<"$wrong_owner_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "bun") | .observed_owner' <<<"$wrong_owner_json")" 'wrong Mise path is not falsely attributed'

shim_result="$(MISE_DATA_DIR="$HOSTILE_MISE_DATA" MISE_TEST_RESULT_DIR="$TEST_ROOT/mise-installs" run_cli_in_path "$MISE_BIN:$SHIM_BIN:$FAKE_BIN" "$CLI" status --json)"
shim_json="$(sed -n '2,$p' <<<"$shim_result")"
assert_equals 'mise' "$(jq -r '.tools[] | select(.name == "node") | .observed_owner' <<<"$shim_json")" 'valid Mise shim is observed as Mise-owned'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "bun") | .selected_owner_matches' <<<"$shim_json")" 'valid Mise shim satisfies selected ownership'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "python") | .selected_owner_matches' <<<"$shim_json")" 'valid Mise Python shim satisfies selected ownership'
assert_equals 'true' "$(jq -r '.tools[] | select(.name == "npm") | .selected_owner_matches' <<<"$shim_json")" 'valid Mise npm shim satisfies selected ownership'

hostile_shim_result="$(MISE_DATA_DIR="$HOSTILE_MISE_DATA" MISE_TEST_RESULT_DIR="$TEST_ROOT/mise-installs" run_cli_in_path "$MISE_BIN:$HOSTILE_SHIM_BIN:$FAKE_BIN" "$CLI" status --json)"
hostile_shim_json="$(sed -n '2,$p' <<<"$hostile_shim_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "node") | .observed_owner' <<<"$hostile_shim_json")" 'hostile inherited Mise data root cannot admit its shim'

failed_shim_result="$(MISE_DATA_DIR="$SHIM_DATA" MISE_TEST_WHICH_FAIL=true run_cli_in_path "$MISE_BIN:$SHIM_BIN:$FAKE_BIN" "$CLI" status --json)"
failed_shim_json="$(sed -n '2,$p' <<<"$failed_shim_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "node") | .observed_owner' <<<"$failed_shim_json")" 'path-shaped shim needs successful Mise resolution'

failed_mise_output_result="$(MISE_TEST_WHICH_FAIL=true MISE_TEST_FAIL_OUTPUT="$FAKE_BIN/node" run_cli "$CLI" status --json)"
failed_mise_output_json="$(sed -n '2,$p' <<<"$failed_mise_output_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "node") | .observed_owner' <<<"$failed_mise_output_json")" 'failed Mise probe stdout cannot establish direct ownership'

failed_brew_output_result="$(MISE_TEST_PATH='/not-owned/bun' BREW_TEST_PREFIX="$TEST_ROOT" BREW_TEST_PREFIX_FAIL=true run_cli "$CLI" status --json)"
failed_brew_output_json="$(sed -n '2,$p' <<<"$failed_brew_output_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "bun") | .observed_owner' <<<"$failed_brew_output_json")" 'failed Homebrew probe stdout cannot establish ownership'

: >"$LEDGER"
pyenv_direct_result="$(MISE_TEST_PATH='/not-owned/python' PYENV_TEST_PATH="$FAKE_BIN/python" run_cli "$CLI" status --json)"
pyenv_direct_json="$(sed -n '2,$p' <<<"$pyenv_direct_result")"
assert_equals 'pyenv' "$(jq -r '.tools[] | select(.name == "python") | .observed_owner' <<<"$pyenv_direct_json")" 'successful pyenv which directly owns Python'
assert_equals '1' "$(awk '$0 == "pyenv which python" { count++ } END { print count + 0 }' "$LEDGER")" 'direct pyenv ownership records one pyenv probe'

: >"$LEDGER"
pyenv_shim_result="$(MISE_TEST_PATH='/not-owned/python' PYENV_ROOT="$PYENV_DATA" PYENV_TEST_PATH="$TEST_ROOT/pyenv-installs/python" run_cli_in_path "$MISE_BIN:$PYENV_SHIM:$FAKE_BIN" "$CLI" status --json)"
pyenv_shim_json="$(sed -n '2,$p' <<<"$pyenv_shim_result")"
assert_equals 'pyenv' "$(jq -r '.tools[] | select(.name == "python") | .observed_owner' <<<"$pyenv_shim_json")" 'successful pyenv which admits its Python shim'
assert_equals '1' "$(awk '$0 == "pyenv which python" { count++ } END { print count + 0 }' "$LEDGER")" 'pyenv shim ownership records one pyenv probe'

: >"$LEDGER"
failed_pyenv_shim_result="$(MISE_TEST_PATH='/not-owned/python' PYENV_ROOT="$PYENV_DATA" PYENV_TEST_WHICH_FAIL=true run_cli_in_path "$MISE_BIN:$PYENV_SHIM:$FAKE_BIN" "$CLI" status --json)"
failed_pyenv_shim_json="$(sed -n '2,$p' <<<"$failed_pyenv_shim_result")"
assert_equals 'unknown' "$(jq -r '.tools[] | select(.name == "python") | .observed_owner' <<<"$failed_pyenv_shim_json")" 'path-shaped pyenv shim needs successful pyenv resolution'
assert_equals '1' "$(awk '$0 == "pyenv which python" { count++ } END { print count + 0 }' "$LEDGER")" 'rejected pyenv shim still records one failed pyenv probe'

: >"$LEDGER"
before_preview="$(repo_snapshot)"
preview_result="$(run_cli "$PREVIEW_CLI" update --preview --json)"
after_preview="$(repo_snapshot)"
preview_status="$(sed -n '1p' <<<"$preview_result")"
preview_json="$(sed -n '2,$p' <<<"$preview_result")"
assert_equals '1' "$preview_status" 'preview exits 1 while selected system Git is unresolved on the fixture'
assert_equals 'update_preview' "$(jq -r '.command' <<<"$preview_json")" 'preview has a structured command identity'
assert_equals 'true' "$(jq -r '.apply_available' <<<"$preview_json")" 'preview discovers available Mise apply support'
assert_equals 'no_change' "$(jq -r '.planned_actions[] | select(.tool == "node") | .action' <<<"$preview_json")" 'matching Node declaration and owner need no change'
assert_equals 'blocked_exact_owner' "$(jq -r '.planned_actions[] | select(.tool == "git") | .action' <<<"$preview_json")" 'preview exposes the Git ownership block'
assert_equals "$(CDPATH='' cd "$PREVIEW_REPO" && pwd -P)/config/mise/source.toml" "$(jq -r '.planned_actions[] | select(.tool == "bun") | .source_path' <<<"$preview_json")" 'preview names the affected Mise source'
assert_equals "$(CDPATH='' cd "$PREVIEW_REPO" && pwd -P)/config/mise/source.toml" "$(jq -r '.planned_actions[] | select(.tool == "bd") | .source_path' <<<"$preview_json")" 'preview names the Beads Mise source'
assert_equals "$(CDPATH='' cd "$PREVIEW_REPO" && pwd -P)/config/toolchain/versions.tsv" "$(jq -r '.planned_actions[] | select(.tool == "npm") | .source_path' <<<"$preview_json")" 'preview names the npm child-version source'
assert_equals "$before_preview" "$after_preview" 'preview preserves path types, modes, bytes, Git state, and unrelated fixture state'
assert_equals $'bd --version\nbrew --prefix\nbun --version\ngit --version\nmise which bd\nmise which bun\nmise which node\nmise which node\nmise which node\nmise which npm\nmise which npm\nmise which python\nnode --version\nnode --version\nnpm --version\nnpm --version\npython --version' "$(LC_ALL=C sort "$LEDGER")" 'preview invokes only permitted read operations, including Beads and explicit npm routing observation'

SPECIAL_REPO="$TEST_ROOT/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"$'source\n\t"\\'
cp -R "$PREVIEW_REPO" "$SPECIAL_REPO"
special_result="$(run_cli "$SPECIAL_REPO/bin/dotfiles/toolchain" update --preview --json)"
special_json="$(sed -n '2,$p' <<<"$special_result")"
assert_equals "$(CDPATH='' cd "$SPECIAL_REPO" && pwd -P)/config/mise/source.toml" "$(jq -r '.planned_actions[] | select(.tool == "node") | .source_path' <<<"$special_json")" 'JSON escapes newline tab quote and backslash source paths'
assert_equals '0' "$(jq -e . >/dev/null <<<"$special_json"; printf '%s' "$?")" 'more than 32 repeated path bytes remain parseable public JSON'
assert_equals '0' "$(wc -c <"$TEST_ROOT/stderr" | tr -d ' ')" 'repeated-byte public JSON keeps stderr empty'

manifest_error() {
	local repo="$1" expected_code="$2" label="$3" result status json
	result="$(run_cli "$repo/bin/dotfiles/toolchain" status --json)"
	status="$(sed -n '1p' <<<"$result")"
	json="$(sed -n '2,$p' <<<"$result")"
	assert_equals '65' "$status" "$label exits with configuration status"
	assert_equals 'error' "$(jq -r '.status' <<<"$json")" "$label returns structured JSON error"
	assert_equals "$expected_code" "$(jq -r '.error.code' <<<"$json")" "$label names its manifest error"
}

cp -R "$PREVIEW_REPO" "$BROKEN_REPO"
: >"$BROKEN_REPO/config/toolchain/versions.tsv"
manifest_error "$BROKEN_REPO" 'manifest_incomplete' 'empty manifest'

missing_repo="$TEST_ROOT/missing-repo"
cp -R "$PREVIEW_REPO" "$missing_repo"
awk -F '|' '$1 != "npm"' "$missing_repo/config/toolchain/versions.tsv" >"$missing_repo/config/toolchain/versions.next"
mv "$missing_repo/config/toolchain/versions.next" "$missing_repo/config/toolchain/versions.tsv"
manifest_error "$missing_repo" 'manifest_incomplete' 'missing required tool manifest'

duplicate_repo="$TEST_ROOT/duplicate-repo"
cp -R "$PREVIEW_REPO" "$duplicate_repo"
printf 'node|26.9.0|mise|source_declared|-\n' >>"$duplicate_repo/config/toolchain/versions.tsv"
manifest_error "$duplicate_repo" 'manifest_duplicate_tool' 'duplicate tool manifest'

unknown_repo="$TEST_ROOT/unknown-repo"
cp -R "$PREVIEW_REPO" "$unknown_repo"
printf 'unknown|0.0.0|mise|source_declared|-\n' >>"$unknown_repo/config/toolchain/versions.tsv"
manifest_error "$unknown_repo" 'manifest_unknown_tool' 'unknown tool manifest'

# fnm is retired as a configured Node owner (ADR 0012). A manifest that selects
# it again is refused before any process probe, so the retired owner cannot
# re-enter through versions.tsv.
fnm_owner_repo="$TEST_ROOT/fnm-owner-repo"
cp -R "$PREVIEW_REPO" "$fnm_owner_repo"
awk -F '|' 'BEGIN { OFS="|" } $1 == "node" { $3 = "fnm" } { print }' "$fnm_owner_repo/config/toolchain/versions.tsv" >"$fnm_owner_repo/config/toolchain/versions.next"
mv "$fnm_owner_repo/config/toolchain/versions.next" "$fnm_owner_repo/config/toolchain/versions.tsv"
: >"$LEDGER"
manifest_error "$fnm_owner_repo" 'manifest_invalid' 'retired fnm selected owner'
assert_equals '0' "$(wc -c <"$LEDGER" | tr -d ' ')" 'retired fnm selected owner is rejected before any process probe'

bad_npm_parent_repo="$TEST_ROOT/bad-npm-parent-repo"
cp -R "$PREVIEW_REPO" "$bad_npm_parent_repo"
awk -F '|' 'BEGIN { OFS="|" } $1 == "npm" { $5 = "bun" } { print }' "$bad_npm_parent_repo/config/toolchain/versions.tsv" >"$bad_npm_parent_repo/config/toolchain/versions.next"
mv "$bad_npm_parent_repo/config/toolchain/versions.next" "$bad_npm_parent_repo/config/toolchain/versions.tsv"
manifest_error "$bad_npm_parent_repo" 'manifest_invalid' 'npm parent relationship'

qualified_repo="$TEST_ROOT/qualified-repo"
cp -R "$PREVIEW_REPO" "$qualified_repo"
awk -F '|' 'BEGIN { OFS="|" } $1 == "node" { $4 = "qualified" } { print }' "$qualified_repo/config/toolchain/versions.tsv" >"$qualified_repo/config/toolchain/versions.next"
mv "$qualified_repo/config/toolchain/versions.next" "$qualified_repo/config/toolchain/versions.tsv"
manifest_error "$qualified_repo" 'manifest_invalid' 'qualified source-only manifest'

malformed_version_repo="$TEST_ROOT/malformed-version-repo"
cp -R "$PREVIEW_REPO" "$malformed_version_repo"
awk -F '|' 'BEGIN { OFS="|" } $1 == "node" { $2 = "24.20" } { print }' "$malformed_version_repo/config/toolchain/versions.tsv" >"$malformed_version_repo/config/toolchain/versions.next"
mv "$malformed_version_repo/config/toolchain/versions.next" "$malformed_version_repo/config/toolchain/versions.tsv"
: >"$LEDGER"
manifest_error "$malformed_version_repo" 'manifest_invalid' 'malformed exact version manifest'
assert_equals '0' "$(wc -c <"$LEDGER" | tr -d ' ')" 'malformed exact version is rejected before any process probe'

extra_field_repo="$TEST_ROOT/extra-field-repo"
cp -R "$PREVIEW_REPO" "$extra_field_repo"
awk '$0 ~ /^node\|/ { print $0 "|"; next } { print }' "$extra_field_repo/config/toolchain/versions.tsv" >"$extra_field_repo/config/toolchain/versions.next"
mv "$extra_field_repo/config/toolchain/versions.next" "$extra_field_repo/config/toolchain/versions.tsv"
: >"$LEDGER"
manifest_error "$extra_field_repo" 'manifest_invalid' 'extra empty manifest field'
assert_equals '0' "$(wc -c <"$LEDGER" | tr -d ' ')" 'extra empty manifest field is rejected before any process probe'

valid_version_result="$(run_cli "$PREVIEW_CLI" status --json)"
valid_version_status="$(sed -n '1p' <<<"$valid_version_result")"
valid_version_json="$(sed -n '2,$p' <<<"$valid_version_result")"
assert_equals '1' "$valid_version_status" 'valid three-part versions reach ordinary ownership checks'
assert_equals 'not_ready' "$(jq -r '.status' <<<"$valid_version_json")" 'valid three-part version control is not a manifest error'

awk '$0 == "node = \"26.9.0\"" { print "node = \"26.9.1\""; next } { print }' "$VERIFY_REPO/config/mise/source.toml" >"$VERIFY_REPO/config/mise/source.next.toml"
mv "$VERIFY_REPO/config/mise/source.next.toml" "$VERIFY_REPO/config/mise/source.toml"
verifier_result="$(run_verifier)"
verifier_status="$(sed -n '1p' <<<"$verifier_result")"
verifier_output="$(sed -n '2,$p' <<<"$verifier_result")"
assert_equals '1' "$verifier_status" 'isolated verifier fails a mismatched source declaration'
assert_contains "$verifier_output" 'Toolchain declaration manifest' 'verifier reports mismatched declaration health'
if grep -Fq 'Toolchain reconstruction qualification' <<<"$verifier_output"; then

	fail 'mismatched source declaration suppresses the misleading qualification warning'
fi
pass 'mismatched source declaration suppresses the misleading qualification warning'

cp "$REPO_ROOT/config/mise/source.toml" "$VERIFY_REPO/config/mise/source.toml"
: >"$LEDGER"
valid_verifier_result="$(run_verifier)"
valid_verifier_status="$(sed -n '1p' <<<"$valid_verifier_result")"
valid_verifier_output="$(sed -n '2,$p' <<<"$valid_verifier_result")"
assert_equals '1' "$valid_verifier_status" 'isolated verifier retains ordinary incomplete-host failures'
assert_contains "$valid_verifier_output" 'Toolchain reconstruction qualification' 'valid source declaration keeps its separate qualification warning'

status_extra_result="$(run_cli "$CLI" status --json extra)"
status_extra_status="$(sed -n '1p' <<<"$status_extra_result")"
status_extra_json="$(sed -n '2,$p' <<<"$status_extra_result")"
assert_equals '64' "$status_extra_status" 'status JSON parser error preserves usage exit'
assert_equals 'usage_error' "$(jq -r '.status' <<<"$status_extra_json")" 'status JSON parser error is structured'
assert_equals 'usage_invalid' "$(jq -r '.error.code' <<<"$status_extra_json")" 'status JSON parser error names invalid usage'
assert_contains "$(<"$TEST_ROOT/stderr")" 'unexpected arguments' 'status JSON parser error keeps diagnostics on stderr'

update_extra_result="$(run_cli "$CLI" update --preview --json extra)"
update_extra_status="$(sed -n '1p' <<<"$update_extra_result")"
update_extra_json="$(sed -n '2,$p' <<<"$update_extra_result")"
assert_equals '64' "$update_extra_status" 'preview JSON parser error preserves usage exit'
assert_equals 'usage_invalid' "$(jq -r '.error.code' <<<"$update_extra_json")" 'preview JSON parser error is structured'

apply_result="$(run_cli "$CLI" update)"
assert_equals '78' "$(sed -n '1p' <<<"$apply_result")" 'apply without preview is refused'
assert_contains "$(<"$TEST_ROOT/stderr")" 'requires --preview' 'apply refusal gives the preview repair path'

usage_result="$(run_cli "$CLI" unexpected)"
assert_equals '64' "$(sed -n '1p' <<<"$usage_result")" 'invalid command exits with usage status'
assert_contains "$(<"$TEST_ROOT/stderr")" 'Usage:' 'invalid command explains the repair path on stderr'

printf '1..%d\n' "$assertion_count"
