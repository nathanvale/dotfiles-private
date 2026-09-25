#!/usr/bin/env bash
# Public process regression for safe managed-symlink replacement.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/symlinks-manage-test.XXXXXX")"
TEST_ROOT="$(CDPATH='' cd "$TEST_ROOT" && pwd -P)"
FIXTURE_REPO="$TEST_ROOT/repository"
FAKE_BIN="$TEST_ROOT/fake-bin"
CLI="$FIXTURE_REPO/bin/dotfiles/symlinks/symlinks_manage.sh"
EXPECTED_ASSERTIONS=22
DASHED_RAW_TARGET='-prior-raw-target'
assertion_count=0
wrong_home="$TEST_ROOT/wrong-home"
wrong_former="$wrong_home/former-directory"
dangling_home="$TEST_ROOT/dangling-home"
correct_home="$TEST_ROOT/correct-home"
missing_home="$TEST_ROOT/missing-home"
creation_failure_home="$TEST_ROOT/creation-failure-home"
creation_failure_former="$creation_failure_home/former-directory"
creation_failure_log="$TEST_ROOT/creation-failure-ln.log"
lying_home="$TEST_ROOT/lying-home"
lying_former="$lying_home/former-directory"
lying_log="$TEST_ROOT/lying-ln.log"

cleanup() {
	set +e
	rm -f -- \
		"$wrong_home/.config" "$wrong_home/bin" "$wrong_former/sentinel" \
		"$dangling_home/.config" "$dangling_home/bin" "$correct_home/.config" "$correct_home/bin" \
		"$missing_home/.config" "$missing_home/bin" \
		"$creation_failure_home/.config" "$creation_failure_home/bin" "$creation_failure_log" \
		"$lying_home/.config" "$lying_home/bin" "$lying_former/sentinel" "$lying_log" \
		"$TEST_ROOT/wrong-ln.log" "$TEST_ROOT/dangling-ln.log" "$TEST_ROOT/correct-ln.log" \
		"$TEST_ROOT/missing-ln.log" "$FAKE_BIN/ln" \
		"$FIXTURE_REPO/bin/dotfiles/symlinks/symlinks_manage.sh" "$FIXTURE_REPO/bin/colour_log.sh"
	rmdir -- \
		"$wrong_former" "$wrong_home" "$dangling_home" "$correct_home" "$missing_home" \
		"$creation_failure_former" "$creation_failure_home" \
		"$lying_former" "$lying_home" "$FAKE_BIN" "$FIXTURE_REPO/config" \
		"$FIXTURE_REPO/bin/dotfiles/symlinks" "$FIXTURE_REPO/bin/dotfiles" "$FIXTURE_REPO/bin" \
		"$FIXTURE_REPO" "$TEST_ROOT" 2>/dev/null
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
		printf '# missing: %q\n' "$needle"
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

mkdir -p "$FIXTURE_REPO/bin/dotfiles/symlinks" "$FIXTURE_REPO/config" "$FAKE_BIN"
cp "$REPO_ROOT/bin/dotfiles/symlinks/symlinks_manage.sh" "$FIXTURE_REPO/bin/dotfiles/symlinks/"
cp "$REPO_ROOT/bin/colour_log.sh" "$FIXTURE_REPO/bin/"

cat >"$FAKE_BIN/ln" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

arguments=("$@")
shift
if [[ "${1:-}" == '--' ]]; then
	shift
fi
target="${1:?expected symlink target}"
link_name="${!#:?expected symlink destination}"

if [[ "$target" == "${SYMLINKS_TEST_INTENDED_TARGET:-}" && "$link_name" == "${HOME}/.config" ]]; then
	case "${SYMLINKS_TEST_LN_MODE:-pass}" in
	fail)
		printf 'intended-creation-failure\n' >>"${SYMLINKS_TEST_LN_LOG:?}"
		exit 71
		;;
	lie)
		printf 'lying-creation\n' >>"${SYMLINKS_TEST_LN_LOG:?}"
		/bin/ln -s "${SYMLINKS_TEST_LIE_TARGET:?}" "$link_name"
		exit 0
		;;
	esac
fi

exec /bin/ln "${arguments[@]}"
EOF
chmod 700 "$FAKE_BIN/ln"

last_status=0
last_output=""

run_link() {
	local home="$1"
	local mode="$2"
	local ln_log="$3"

	set +e
	last_output="$(env -i \
		HOME="$home" \
		DOTFILES_PROFILE=server \
		PATH="$FAKE_BIN:/usr/bin:/bin" \
		TERM=dumb \
		SYMLINKS_TEST_LN_MODE="$mode" \
		SYMLINKS_TEST_LN_LOG="$ln_log" \
		SYMLINKS_TEST_INTENDED_TARGET="$FIXTURE_REPO/config" \
		SYMLINKS_TEST_LIE_TARGET="$home/lying-target" \
		"$CLI" --link </dev/null 2>&1)"
	last_status=$?
	set -e
}

assert_path_absent "$FIXTURE_REPO/.git" 'fixture repository is not a Git checkout'

mkdir -p "$wrong_former"
printf 'former-sentinel-bytes' >"$wrong_former/sentinel"
/bin/ln -s 'former-directory' "$wrong_home/.config"
run_link "$wrong_home" pass "$TEST_ROOT/wrong-ln.log"
assert_equals "$last_status" '0' 'wrong directory symlink replacement exits zero'
assert_equals "$(readlink "$wrong_home/.config")" "$FIXTURE_REPO/config" 'wrong directory symlink receives the literal intended target'
assert_equals "$(<"$wrong_former/sentinel")" 'former-sentinel-bytes' 'wrong directory symlink preserves former referent bytes'
assert_path_absent "$wrong_former/config" 'wrong directory symlink creates no child under former referent'
assert_contains "$last_output" "Updated: $wrong_home/.config -> $FIXTURE_REPO/config" 'wrong directory symlink reports the safe update'

mkdir -p "$dangling_home"
/bin/ln -s 'missing-former-directory' "$dangling_home/.config"
run_link "$dangling_home" pass "$TEST_ROOT/dangling-ln.log"
assert_equals "$last_status" '0' 'dangling wrong symlink replacement exits zero'
assert_equals "$(readlink "$dangling_home/.config")" "$FIXTURE_REPO/config" 'dangling wrong symlink receives the literal intended target'

mkdir -p "$correct_home"
/bin/ln -s "$FIXTURE_REPO/config" "$correct_home/.config"
run_link "$correct_home" pass "$TEST_ROOT/correct-ln.log"
assert_equals "$last_status" '0' 'already-correct symlink run exits zero'
assert_equals "$(readlink "$correct_home/.config")" "$FIXTURE_REPO/config" 'already-correct symlink retains its literal target'
assert_contains "$last_output" "Already correct: $correct_home/.config" 'already-correct symlink is retained'

mkdir -p "$missing_home"
run_link "$missing_home" pass "$TEST_ROOT/missing-ln.log"
assert_equals "$last_status" '0' 'missing symlink creation exits zero'
assert_equals "$(readlink "$missing_home/.config")" "$FIXTURE_REPO/config" 'missing symlink receives the literal intended target'

mkdir -p "$creation_failure_former"
/bin/ln -s -- "$DASHED_RAW_TARGET" "$creation_failure_home/.config"
run_link "$creation_failure_home" fail "$creation_failure_log"
assert_not_equals "$last_status" '0' 'intended creation failure exits nonzero'
assert_equals "$(readlink "$creation_failure_home/.config")" "$DASHED_RAW_TARGET" 'intended creation failure restores the exact dashed raw target'
assert_equals "$(<"$creation_failure_log")" 'intended-creation-failure' 'intended creation failure reaches the injected creation fault'
assert_contains "$last_output" 'could not create intended symlink; restored previous symlink' 'intended creation failure reports restored rejection'

mkdir -p "$lying_former"
printf 'lying-former-sentinel-bytes' >"$lying_former/sentinel"
/bin/ln -s 'former-directory' "$lying_home/.config"
run_link "$lying_home" lie "$lying_log"
assert_not_equals "$last_status" '0' 'lying link creation exits nonzero after verification'
assert_equals "$(readlink "$lying_home/.config")" 'former-directory' 'lying link creation restores the prior raw target'
assert_equals "$(<"$lying_log")" 'lying-creation' 'lying link creation reaches the zero-exit injected fault'
assert_contains "$last_output" 'replacement verification failed; restored previous symlink' 'lying link creation reports verification rejection and restoration'
assert_equals "$(<"$lying_former/sentinel")" 'lying-former-sentinel-bytes' 'lying link creation preserves former referent bytes'

[[ "$assertion_count" -eq "$EXPECTED_ASSERTIONS" ]] ||
	fail "assertion count drifted: expected $EXPECTED_ASSERTIONS, got $assertion_count"
printf '1..%d\n' "$assertion_count"
