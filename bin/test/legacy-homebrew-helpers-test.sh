#!/usr/bin/env bash
# Public process regression for the retired legacy Homebrew helpers.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/legacy-homebrew-helpers-test.XXXXXX")"
TEST_ROOT="$(CDPATH='' cd "$TEST_ROOT" && pwd -P)"
FIXTURE_REPO="$TEST_ROOT/repository"
FAKE_BIN="$TEST_ROOT/fake-bin"
CALL_LOG="$TEST_ROOT/call-log"
EXPECTED_ASSERTIONS=94
assertion_count=0

cleanup() {
	set +e
	rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

pass() {
	assertion_count=$((assertion_count + 1))
	printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
	assertion_count=$((assertion_count + 1))
	printf 'not ok %d - %s\n' "$assertion_count" "$1"
	exit 1
}

assert_equals() {
	local actual="$1"
	local expected="$2"
	local description="$3"

	if [[ "$actual" == "$expected" ]]; then
		pass "$description"
	else
		printf '# expected: %q\n# actual:   %q\n' "$expected" "$actual"
		fail "$description"
	fi
}

assert_not_equals() {
	local actual="$1"
	local unexpected="$2"
	local description="$3"

	if [[ "$actual" != "$unexpected" ]]; then
		pass "$description"
	else
		printf '# unexpected: %q\n' "$unexpected"
		fail "$description"
	fi
}

assert_contains() {
	local haystack="$1"
	local needle="$2"
	local description="$3"

	if /usr/bin/grep -Fq -- "$needle" <<<"$haystack"; then
		pass "$description"
	else
		printf '# missing: %q\n# in:      %q\n' "$needle" "$haystack"
		fail "$description"
	fi
}

assert_empty() {
	local actual="$1"
	local description="$2"

	if [[ -z "$actual" ]]; then
		pass "$description"
	else
		printf '# unexpected bytes: %q\n' "$actual"
		fail "$description"
	fi
}

assert_path_absent() {
	local path="$1"
	local description="$2"

	if [[ ! -e "$path" && ! -L "$path" ]]; then
		pass "$description"
	else
		printf '# unexpected path: %q\n' "$path"
		fail "$description"
	fi
}

assert_dir_empty() {
	local dir="$1"
	local description="$2"
	local entries

	entries="$(find "$dir" -mindepth 1 2>/dev/null)"
	if [[ -z "$entries" ]]; then
		pass "$description"
	else
		printf '# unexpected entries: %q\n' "$entries"
		fail "$description"
	fi
}

mkdir -p "$FIXTURE_REPO/bin/dev/homebrew" "$FAKE_BIN"
cp "$REPO_ROOT/bin/dev/homebrew/brew_install.sh" "$FIXTURE_REPO/bin/dev/homebrew/"
cp "$REPO_ROOT/bin/dev/homebrew/brew_remote_bundle.sh" "$FIXTURE_REPO/bin/dev/homebrew/"
cp "$REPO_ROOT/bin/dev/homebrew/brew_uninstall.sh" "$FIXTURE_REPO/bin/dev/homebrew/"

cat >"$FAKE_BIN/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >>"$CALL_LOG"
exit 99
EOF
chmod 700 "$FAKE_BIN/curl"

cat >"$FAKE_BIN/brew" <<EOF
#!/usr/bin/env bash
printf 'brew %s\n' "\$*" >>"$CALL_LOG"
exit 99
EOF
chmod 700 "$FAKE_BIN/brew"

assert_path_absent "$FIXTURE_REPO/.git" 'fixture repository is not a Git checkout'

last_status=0
last_stdout=""
last_stderr=""

run_helper() {
	local script="$1"
	local arg="$2"
	local home="$3"
	local tmp="$4"
	local out_file="$TEST_ROOT/stdout.tmp"
	local err_file="$TEST_ROOT/stderr.tmp"

	set +e
	env -i \
		HOME="$home" \
		TMPDIR="$tmp" \
		DOTFILES_PROFILE="${arg#--}" \
		PATH="$FAKE_BIN:/usr/bin:/bin" \
		TERM=dumb \
		"$script" "$arg" </dev/null >"$out_file" 2>"$err_file"
	last_status=$?
	set -e
	last_stdout="$(<"$out_file")"
	last_stderr="$(<"$err_file")"
	rm -f "$out_file" "$err_file"
}

check_no_mutation_scenario() {
	local script_path="$1"
	local script_label="$2"
	local arg="$3"
	local message_needle="$4"

	local home tmp
	home="$(mktemp -d "$TEST_ROOT/home.XXXXXX")"
	tmp="$(mktemp -d "$TEST_ROOT/tmp.XXXXXX")"
	rm -f "$CALL_LOG"

	run_helper "$script_path" "$arg" "$home" "$tmp"

	assert_not_equals "$last_status" '0' "$script_label $arg exits nonzero"
	assert_equals "$last_status" '1' "$script_label $arg exits with status 1"
	assert_contains "$last_stderr" "$message_needle" "$script_label $arg reports the canonical replacement route"
	assert_contains "$last_stderr" 'retired' "$script_label $arg names itself retired"
	assert_empty "$last_stdout" "$script_label $arg writes no stdout"
	assert_path_absent "$CALL_LOG" "$script_label $arg calls neither curl nor brew"
	assert_dir_empty "$home" "$script_label $arg leaves HOME untouched"
	assert_dir_empty "$tmp" "$script_label $arg creates no temporary file"
}

check_standalone_outside_repository() {
	local script_name="$1"
	local script_label="$2"
	local message_needle="$3"

	local standalone_dir home tmp
	standalone_dir="$(mktemp -d "$TEST_ROOT/standalone.XXXXXX")"
	cp "$REPO_ROOT/bin/dev/homebrew/$script_name" "$standalone_dir/$script_name"
	chmod +x "$standalone_dir/$script_name"
	home="$(mktemp -d "$TEST_ROOT/standalone-home.XXXXXX")"
	tmp="$(mktemp -d "$TEST_ROOT/standalone-tmp.XXXXXX")"
	rm -f "$CALL_LOG"

	assert_path_absent "$standalone_dir/colour_log.sh" "$script_label standalone copy has no colocated logger"
	assert_path_absent "$standalone_dir/bin" "$script_label standalone copy has no repository bin/ hierarchy"

	run_helper "$standalone_dir/$script_name" '--desktop' "$home" "$tmp"

	assert_not_equals "$last_status" '0' "$script_label copied outside the repository exits nonzero"
	assert_contains "$last_stderr" "$message_needle" "$script_label copied outside the repository reports the canonical replacement route"
	assert_contains "$last_stderr" 'retired' "$script_label copied outside the repository names itself retired"
	assert_empty "$last_stdout" "$script_label copied outside the repository writes no stdout"
	assert_path_absent "$CALL_LOG" "$script_label copied outside the repository calls neither curl nor brew"
}

for scenario_arg in --desktop --server --totally-unsupported-profile; do
	check_no_mutation_scenario \
		"$FIXTURE_REPO/bin/dev/homebrew/brew_install.sh" \
		'brew_install.sh' "$scenario_arg" './setup.sh --desktop'

	check_no_mutation_scenario \
		"$FIXTURE_REPO/bin/dev/homebrew/brew_remote_bundle.sh" \
		'brew_remote_bundle.sh' "$scenario_arg" 'brew bundle --file=config/brew/Brewfile'

	check_no_mutation_scenario \
		"$FIXTURE_REPO/bin/dev/homebrew/brew_uninstall.sh" \
		'brew_uninstall.sh' "$scenario_arg" 'raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh'
done

check_standalone_outside_repository \
	'brew_install.sh' 'brew_install.sh' './setup.sh --desktop'

check_standalone_outside_repository \
	'brew_remote_bundle.sh' 'brew_remote_bundle.sh' 'brew bundle --file=config/brew/Brewfile'

check_standalone_outside_repository \
	'brew_uninstall.sh' 'brew_uninstall.sh' 'raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh'

[[ "$assertion_count" -eq "$EXPECTED_ASSERTIONS" ]] ||
	fail "assertion count drifted: expected $EXPECTED_ASSERTIONS, got $assertion_count"
printf '1..%d\n' "$assertion_count"
