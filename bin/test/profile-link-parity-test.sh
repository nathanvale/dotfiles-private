#!/usr/bin/env bash

# Public-process profile and managed-link contract. The real verifier and
# symlink manager run from copied fixtures with a disposable HOME. The fixture
# discovers source paths through the manager's public status output. Profile
# package expectations come from the shared Brewfile requirement table and are
# checked through both public Homebrew Bundle and verifier processes.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

MANAGER_SOURCE="$REPO_ROOT/bin/dotfiles/symlinks/symlinks_manage.sh"
COLOUR_SOURCE="$REPO_ROOT/bin/colour_log.sh"
VERIFIER_SOURCE="$REPO_ROOT/verify_install.sh"
NODE_VERSION_SOURCE="$REPO_ROOT/config/node/version"
BREWFILE_SOURCE="$REPO_ROOT/config/brew/Brewfile"
PROFILE_REQUIREMENTS_SOURCE="$REPO_ROOT/config/brew/profile-requirements.tsv"

EXPECTED_RECORDS=25
EXPECTED_COMMON_RECORDS=16
EXPECTED_DESKTOP_RECORDS=7
EXPECTED_SERVER_RECORDS=2

assertion_count=0
RUN_OUTPUT=""
RUN_EXIT=0

pass() {
	assertion_count=$((assertion_count + 1))
	printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
	printf 'not ok %d - %s\n' "$((assertion_count + 1))" "$1" >&2
	exit 1
}

assert_equals() {
	local actual="$1"
	local expected="$2"
	local label="$3"
	if [[ "$actual" == "$expected" ]]; then
		pass "$label"
	else
		printf '# expected: %q\n# actual:   %q\n' "$expected" "$actual" >&2
		fail "$label"
	fi
}

assert_contains() {
	local actual="$1"
	local expected="$2"
	local label="$3"
	if /usr/bin/grep -Fq -- "$expected" <<<"$actual"; then
		pass "$label"
	else
		printf '# missing: %q\n' "$expected" >&2
		fail "$label"
	fi
}

assert_not_contains() {
	local actual="$1"
	local unexpected="$2"
	local label="$3"
	if ! /usr/bin/grep -Fq -- "$unexpected" <<<"$actual"; then
		pass "$label"
	else
		printf '# unexpected: %q\n' "$unexpected" >&2
		fail "$label"
	fi
}

assert_not_equals() {
	local actual="$1"
	local unexpected="$2"
	local label="$3"
	if [[ "$actual" != "$unexpected" ]]; then
		pass "$label"
	else
		fail "$label"
	fi
}

assert_exact_line() {
	local actual="$1"
	local expected="$2"
	local label="$3"
	if /usr/bin/grep -Fxq -- "$expected" <<<"$actual"; then
		pass "$label"
	else
		printf '# missing exact line: %q\n' "$expected" >&2
		fail "$label"
	fi
}

profile_requirement_rows() {
	local profile="$1"
	local phase="$2"
	awk -F '\t' -v profile="$profile" -v phase="$phase" '
		/^[[:space:]]*#/ || NF == 0 { next }
		$8 != phase { next }
		$1 == "all" || $1 == profile || $9 == "skip" { print }
	' "$PROFILE_REQUIREMENTS_SOURCE"
}

active_profile_package_rows() {
	local profile="$1"
	awk -F '\t' -v profile="$profile" '
		/^[[:space:]]*#/ || NF == 0 { next }
		($1 == "all" || $1 == profile) && ($3 == "cask" || $3 == "brew") { print }
	' "$PROFILE_REQUIREMENTS_SOURCE"
}

assert_profile_package_parity() {
	local profile="$1"
	local bundle_casks bundle_formulae phase_summary expected_total observed_total
	local scope severity package_type package label check_kind check_value phase inactive

	bundle_casks="$(cd "$TEST_ROOT" && env -i HOME="$fixture/home" HOMEBREW_DOTFILES_PROFILE="$profile" \
		HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 PATH=/opt/homebrew/bin:/usr/bin:/bin \
		brew bundle list --file="$fixture/dotfiles/config/brew/Brewfile" --cask)"
	bundle_formulae="$(cd "$TEST_ROOT" && env -i HOME="$fixture/home" HOMEBREW_DOTFILES_PROFILE="$profile" \
		HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 PATH=/opt/homebrew/bin:/usr/bin:/bin \
		brew bundle list --file="$fixture/dotfiles/config/brew/Brewfile" --formula)"

	while IFS=$'\t' read -r scope severity package_type package label check_kind check_value phase inactive; do
		case "$package_type" in
			cask)
				assert_exact_line "$bundle_casks" "$package" \
					"$profile Brewfile exposes the manifest cask for $label"
				;;
			brew)
				assert_exact_line "$bundle_formulae" "$package" \
					"$profile Brewfile exposes the manifest formula for $label"
				;;
		esac
	done < <(active_profile_package_rows "$profile")

	while IFS=$'\t' read -r scope severity package_type package label check_kind check_value phase inactive; do
		assert_contains "$RUN_OUTPUT" "$label" \
			"$profile verifier emits the manifest-owned $label requirement"
		if [[ "$scope" != all && "$scope" != "$profile" ]]; then
			assert_contains "$RUN_OUTPUT" "$label (not applicable)" \
				"$profile verifier marks the inactive manifest-owned $label row"
		fi
	done < <(profile_requirement_rows "$profile" applications)

	phase_summary="$(grep -F 'Phase 5: Applications:' <<<"$RUN_OUTPUT" | tail -n 1)"
	expected_total="$(profile_requirement_rows "$profile" applications | awk 'NF { count += 1 } END { print count + 0 }')"
	observed_total="$(sed -E 's/.*: [0-9]+\/([0-9]+) passed.*/\1/' <<<"$phase_summary")"
	assert_equals "$observed_total" "$expected_total" \
		"$profile verifier Phase 5 count is exactly the manifest application inventory"

	if [[ "$profile" == server ]]; then
		while IFS=$'\t' read -r scope severity package_type package label check_kind check_value phase inactive; do
			assert_contains "$RUN_OUTPUT" "$label" \
				"$profile verifier emits the manifest-owned $label prerequisite"
		done < <(profile_requirement_rows "$profile" server)
	fi
}

assert_invalid_manifest_row() {
	local kind="$1"
	local invalid_root="$TEST_ROOT/invalid-manifest-$kind"
	local invalid_brew_dir="$invalid_root/dotfiles/config/brew"
	local invalid_table="$invalid_brew_dir/profile-requirements.tsv"
	local fixture_dotfiles
	local brew_output="$invalid_root/brew.out"
	local brew_error="$invalid_root/brew.err"
	local brew_exit
	fixture_dotfiles="$(CDPATH='' cd "$fixture/dotfiles" && pwd -P)"

	mkdir -p "$invalid_brew_dir"
	cp "$BREWFILE_SOURCE" "$invalid_brew_dir/Brewfile"
	/usr/bin/python3 - "$PROFILE_REQUIREMENTS_SOURCE" "$invalid_table" "$kind" <<'PY'
import sys

source, target, kind = sys.argv[1:]
text = open(source, encoding="utf-8").read()
replacements = {
    "scope": ("all\trequired\tcask", "portable\trequired\tcask"),
    "package_type": ("all\trequired\tcask", "all\trequired\tpackage"),
    "check_kind": ("\tapp\t", "\tunknown\t"),
}
old, new = replacements[kind]
if old not in text:
    raise SystemExit(f"manifest mutation seam missing for {kind}")
text = text.replace(old, new, 1)
open(target, "w", encoding="utf-8").write(text)
PY

	set +e
	(cd "$TEST_ROOT" && env -i HOME="$fixture/home" HOMEBREW_DOTFILES_PROFILE=desktop \
		HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 PATH=/opt/homebrew/bin:/usr/bin:/bin \
		brew bundle list --file="$invalid_brew_dir/Brewfile" --cask \
		>"$brew_output" 2>"$brew_error")
	brew_exit=$?
	set -e
	assert_not_equals "$brew_exit" 0 "$kind malformed manifest rejects Brewfile evaluation"
	assert_contains "$(<"$brew_error")" 'invalid profile requirement row' \
		"$kind malformed manifest reports the Brewfile schema error"

	cp "$invalid_table" "$fixture/dotfiles/config/brew/profile-requirements.tsv"
	run_verifier "$fixture" desktop
	assert_not_equals "$RUN_EXIT" 0 "$kind malformed manifest rejects verifier execution"
	assert_contains "$RUN_OUTPUT" 'Profile package requirements manifest' \
		"$kind malformed manifest names the verifier schema failure"
	assert_contains "$RUN_OUTPUT" "Repair: $fixture_dotfiles/config/brew/profile-requirements.tsv" \
		"$kind malformed manifest names the profile table repair path"
	cp "$PROFILE_REQUIREMENTS_SOURCE" "$fixture/dotfiles/config/brew/profile-requirements.tsv"
}

assert_valid_profile_env() {
	local value="$1"
	local label="$2"
	local out_file="$TEST_ROOT/valid-profile-$label.out"
	local err_file="$TEST_ROOT/valid-profile-$label.err"
	local run_exit

	set +e
	(cd "$TEST_ROOT" && env -i HOME="$fixture/home" HOMEBREW_DOTFILES_PROFILE="$value" \
		HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 PATH=/opt/homebrew/bin:/usr/bin:/bin \
		brew bundle list --file="$fixture/dotfiles/config/brew/Brewfile" --cask \
		>"$out_file" 2>"$err_file")
	run_exit=$?
	set -e
	assert_equals "$run_exit" 0 "$label HOMEBREW_DOTFILES_PROFILE remains valid after profile validation"
}

assert_invalid_profile_env() {
	local value="$1"
	local label="$2"
	local out_file="$TEST_ROOT/invalid-profile-$label.out"
	local err_file="$TEST_ROOT/invalid-profile-$label.err"
	local run_exit

	set +e
	(cd "$TEST_ROOT" && env -i HOME="$fixture/home" HOMEBREW_DOTFILES_PROFILE="$value" \
		HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 PATH=/opt/homebrew/bin:/usr/bin:/bin \
		brew bundle list --file="$fixture/dotfiles/config/brew/Brewfile" --cask \
		>"$out_file" 2>"$err_file")
	run_exit=$?
	set -e
	assert_not_equals "$run_exit" 0 "$label HOMEBREW_DOTFILES_PROFILE rejects Brewfile evaluation before any package action"
	assert_contains "$(<"$err_file")" 'invalid HOMEBREW_DOTFILES_PROFILE' \
		"$label HOMEBREW_DOTFILES_PROFILE reports the invalid profile error"
}

make_verifier_fixture() {
	local name="$1"
	local fixture="$TEST_ROOT/$name"
	local dotfiles="$fixture/dotfiles"

	mkdir -p "$dotfiles/bin/dotfiles/symlinks" "$dotfiles/config/node" "$dotfiles/config/brew"
	cp "$MANAGER_SOURCE" "$dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh"
	cp "$COLOUR_SOURCE" "$dotfiles/bin/colour_log.sh"
	cp "$VERIFIER_SOURCE" "$dotfiles/verify_install.sh"
	cp "$NODE_VERSION_SOURCE" "$dotfiles/config/node/version"
	cp "$BREWFILE_SOURCE" "$dotfiles/config/brew/Brewfile"
	cp "$PROFILE_REQUIREMENTS_SOURCE" "$dotfiles/config/brew/profile-requirements.tsv"
	chmod 700 "$dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh" "$dotfiles/verify_install.sh"

	printf '%s\n' "$fixture"
}

manager_output() {
	local fixture="$1"
	local profile="$2"
	local home="$3"
	local manager="$fixture/dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh"

	HOME="$home" DOTFILES_PROFILE="$profile" PATH=/usr/bin:/bin \
		"$manager" --status --machine
}

prepare_links() {
	local fixture="$1"
	local profile="$2"
	local home="$fixture/home"
	local dotfiles="$fixture/dotfiles"
	local manager="$dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh"
	local records="$fixture/records.tsv"
	local marker _requirement _scope destination expected _actual _object _status

	mkdir -p "$home/.dotfiles_state"
	printf '%s\n' "$profile" >"$home/.dotfiles_state/profile"
	manager_output "$fixture" "$profile" "$home" >"$records"

	while IFS=$'\t' read -r marker _requirement _scope destination expected _actual _object _status; do
		[[ "$marker" == DOTFILES_SYMLINK_RECORD ]] || continue
		mkdir -p "$expected"
		mkdir -p "$(dirname "$destination")"
		if [[ ! -e "$destination" && ! -L "$destination" ]]; then
			ln -s "$expected" "$destination"
		fi
	done < <(tail -n +2 "$records")
	manager_output "$fixture" "$profile" "$home" >"$records"
	cat "$records"
}

run_verifier() {
	local fixture="$1"
	local profile="$2"
	local home="$fixture/home"
	local verifier="$fixture/dotfiles/verify_install.sh"

	set +e
	RUN_OUTPUT="$(env -i HOME="$home" PATH=/usr/bin:/bin DOTFILES_PROFILE="$profile" \
		"$verifier" --verbose --machine-summary 2>&1)"
	RUN_EXIT=$?
	set -e
	RUN_OUTPUT="$(sed -E $'s/\033\\[[0-9;]*[[:alpha:]]//g' <<<"$RUN_OUTPUT")"
}

assert_manager_shape() {
	local fixture="$1"
	local profile="$2"
	local output="$3"
	local header rows common desktop server active_ok inactive expected_active expected_inactive

	header="$(sed -n '1p' <<<"$output")"
	rows="$(sed '1d' <<<"$output")"
	assert_equals "$header" "DOTFILES_SYMLINK_STATUS version=1 profile=$profile records=$EXPECTED_RECORDS" \
		"$profile machine status declares the complete mapping count"
	assert_equals "$(awk -F '\t' 'NF { count += 1 } END { print count + 0 }' <<<"$rows")" "$EXPECTED_RECORDS" \
		"$profile machine status emits one row per managed destination"
	common="$(awk -F '\t' '$3 == "common" { count += 1 } END { print count + 0 }' <<<"$rows")"
	desktop="$(awk -F '\t' '$3 == "desktop" { count += 1 } END { print count + 0 }' <<<"$rows")"
	server="$(awk -F '\t' '$3 == "server" { count += 1 } END { print count + 0 }' <<<"$rows")"
	assert_equals "$common" "$EXPECTED_COMMON_RECORDS" "$profile status includes every common mapping"
	assert_equals "$desktop" "$EXPECTED_DESKTOP_RECORDS" "$profile status includes every desktop mapping"
	assert_equals "$server" "$EXPECTED_SERVER_RECORDS" "$profile status includes every server mapping"
	active_ok="$(awk -F '\t' -v profile="$profile" '$1 == "DOTFILES_SYMLINK_RECORD" && ($3 == "common" || $3 == profile) && $8 == "ok" { count += 1 } END { print count + 0 }' <<<"$rows")"
	inactive="$(awk -F '\t' -v profile="$profile" '$1 == "DOTFILES_SYMLINK_RECORD" && $3 != "common" && $3 != profile && $8 == "not-applicable" && $7 == "not-applicable" { count += 1 } END { print count + 0 }' <<<"$rows")"
	if [[ "$profile" == desktop ]]; then
		expected_active=$((EXPECTED_COMMON_RECORDS + EXPECTED_DESKTOP_RECORDS))
		expected_inactive=$EXPECTED_SERVER_RECORDS
	else
		expected_active=$((EXPECTED_COMMON_RECORDS + EXPECTED_SERVER_RECORDS))
		expected_inactive=$EXPECTED_DESKTOP_RECORDS
	fi
	assert_equals "$active_ok" "$expected_active" \
		"$profile status marks every active fixture link healthy"
	assert_equals "$inactive" "$expected_inactive" \
		"$profile status marks inactive profile links explicitly not applicable"
}

fixture="$TEST_ROOT/manager-matrix"
mkdir -p "$fixture/home"
make_verifier_fixture manager-matrix >/dev/null
fixture="$TEST_ROOT/manager-matrix"
desktop_records="$(prepare_links "$fixture" desktop)"
assert_manager_shape "$fixture" desktop "$desktop_records"
pass 'desktop manager process emits machine-readable all-profile status'

server_records="$(manager_output "$fixture" server "$fixture/home")"
assert_manager_shape "$fixture" server "$server_records"
pass 'server manager process emits machine-readable all-profile status'

common_destination="$(awk -F '\t' '$1 == "DOTFILES_SYMLINK_RECORD" && $3 == "common" { print $4; exit }' <<<"$desktop_records")"
common_expected="$(awk -F '\t' '$1 == "DOTFILES_SYMLINK_RECORD" && $3 == "common" { print $5; exit }' <<<"$desktop_records")"
mkdir -p "$fixture/unrelated"

newline_target="$common_expected"$'\n'
mkdir "$newline_target"
rm "$common_destination"
ln -s "$newline_target" "$common_destination"
/usr/bin/python3 - "$common_destination" "$common_expected" <<'PY'
import os
import sys

link, expected = sys.argv[1:]
actual = os.readlink(link)
if actual != expected + "\n" or not os.path.isdir(actual):
    raise SystemExit("newline target fixture was not created exactly")
PY
set +e
newline_manager_output="$(manager_output "$fixture" desktop "$fixture/home" 2>&1)"
newline_manager_exit=$?
set -e
assert_not_equals "$newline_manager_exit" 0 'manager rejects a managed symlink target with a trailing newline'
run_verifier "$fixture" desktop
assert_not_equals "$RUN_EXIT" 0 'verifier fails closed when the manager rejects an unsafe symlink target'
assert_contains "$RUN_OUTPUT" '✗ Managed symlink status contract' 'verifier reports the unsafe symlink status contract failure'
rm "$common_destination"
rmdir "$newline_target"
ln -s "$common_expected" "$common_destination"

rm "$common_destination"
ln -s "$fixture/unrelated" "$common_destination"
wrong_target_records="$(manager_output "$fixture" desktop "$fixture/home")"
wrong_target_status="$(awk -F '\t' -v destination="$common_destination" '$4 == destination { print $8; exit }' <<<"$wrong_target_records")"
assert_equals "$wrong_target_status" wrong-target 'wrong-target managed link has a distinct machine status'
rm "$common_destination"
ln -s "$common_expected" "$common_destination"

rm "$common_destination"
ln -s "$fixture/missing-target" "$common_destination"
dangling_records="$(manager_output "$fixture" desktop "$fixture/home")"
dangling_status="$(awk -F '\t' -v destination="$common_destination" '$4 == destination { print $8; exit }' <<<"$dangling_records")"
assert_equals "$dangling_status" dangling 'dangling managed link has a distinct machine status'
rm "$common_destination"
ln -s "$common_expected" "$common_destination"

rm "$common_destination"
mkdir "$common_destination"
nonlink_records="$(manager_output "$fixture" desktop "$fixture/home")"
nonlink_status="$(awk -F '\t' -v destination="$common_destination" '$4 == destination { print $8; exit }' <<<"$nonlink_records")"
assert_equals "$nonlink_status" nonlink 'real-directory replacement has a distinct machine status'
rmdir "$common_destination"
ln -s "$common_expected" "$common_destination"

rm "$common_destination"
missing_records="$(manager_output "$fixture" desktop "$fixture/home")"
missing_status="$(awk -F '\t' -v destination="$common_destination" '$4 == destination { print $8 }' <<<"$missing_records")"
assert_equals "$missing_status" missing 'missing managed link has a distinct machine status'
ln -s "$common_expected" "$common_destination"

run_verifier "$fixture" desktop
assert_not_contains "$RUN_OUTPUT" '✗ Managed symlink status contract' 'desktop verifier accepts the manager status contract'
assert_contains "$RUN_OUTPUT" 'DOTFILES_VERIFY_SUMMARY version=1' 'desktop verifier emits its stable completion record'
assert_profile_package_parity desktop

server_home="$fixture/home"
mkdir -p "$server_home/.lmstudio/bin"
printf '#!/bin/sh\nexit 0\n' >"$server_home/.lmstudio/bin/lms"
chmod 700 "$server_home/.lmstudio/bin/lms"
run_verifier "$fixture" server
assert_not_contains "$RUN_OUTPUT" '✗ Managed symlink status contract' 'server verifier accepts the manager status contract'
assert_profile_package_parity server

for invalid_manifest_kind in scope package_type check_kind; do
	assert_invalid_manifest_row "$invalid_manifest_kind"
done

# HOMEBREW_DOTFILES_PROFILE must be exactly desktop or server before any
# tap/brew/cask directive runs, and a typo must be rejected before any
# package action. Homebrew's own HOMEBREW_ env forwarding treats an
# explicitly empty value the same as unset (verified against the real brew
# process below), so it must keep resolving to the desktop default rather
# than being rejected as invalid.
assert_valid_profile_env desktop 'desktop'
assert_valid_profile_env server 'server'
assert_valid_profile_env '' 'empty'
assert_equals "$(<"$TEST_ROOT/valid-profile-empty.out")" "$(<"$TEST_ROOT/valid-profile-desktop.out")" \
	'empty HOMEBREW_DOTFILES_PROFILE is treated as unset and defaults to desktop packages'
assert_invalid_profile_env dsktop 'typo'

# Link identity and usable server recovery objects are separate obligations.
recovery_source="$fixture/dotfiles/bin/system/lm-studio-ensure.sh"
agent_source="$fixture/dotfiles/config/launchd/com.nathanvale.lm-studio-ensure.plist"
rmdir "$recovery_source"
printf '#!/bin/sh\nexit 0\n' >"$recovery_source"
chmod 600 "$recovery_source"
run_verifier "$fixture" server
assert_contains "$RUN_OUTPUT" '✗ LM Studio recovery script' 'server rejects a correct link to a non-executable recovery script'
assert_contains "$RUN_OUTPUT" '✗ LM Studio recovery agent' 'server rejects a correct link to a directory instead of a recovery plist'
chmod 700 "$recovery_source"
rmdir "$agent_source"
printf '<plist version="1.0"><dict/></plist>\n' >"$agent_source"
run_verifier "$fixture" server
assert_contains "$RUN_OUTPUT" '✓ LM Studio recovery script' 'server accepts the executable recovery script at the exact managed link'
assert_contains "$RUN_OUTPUT" '✓ LM Studio recovery agent' 'server accepts the regular recovery plist at the exact managed link'

rm "$common_destination"
ln -s "$fixture/unrelated" "$common_destination"
run_verifier "$fixture" desktop
assert_not_equals "$RUN_EXIT" 0 'verifier fails when a required managed link points to the wrong target'
assert_contains "$RUN_OUTPUT" "✗ Managed symlink: $common_destination" 'verifier fails the specific wrong-target managed destination'
rm "$common_destination"
ln -s "$common_expected" "$common_destination"

malformed="$TEST_ROOT/malformed"
malformed_dotfiles="$malformed/dotfiles"
malformed_home="$malformed/home"
mkdir -p "$malformed_dotfiles/config/node" "$malformed_dotfiles/bin/dotfiles/symlinks" "$malformed_home"
cp "$VERIFIER_SOURCE" "$malformed_dotfiles/verify_install.sh"
cp "$NODE_VERSION_SOURCE" "$malformed_dotfiles/config/node/version"
cat >"$malformed_dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh" <<'EOF'
#!/usr/bin/env bash
printf 'DOTFILES_SYMLINK_STATUS version=1 profile=%s records=1\n' "${DOTFILES_PROFILE:-desktop}"
EOF
chmod 700 "$malformed_dotfiles/verify_install.sh" "$malformed_dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh"
set +e
RUN_OUTPUT="$(env -i HOME="$malformed_home" PATH=/usr/bin:/bin DOTFILES_PROFILE=desktop \
	"$malformed_dotfiles/verify_install.sh" --verbose --machine-summary 2>&1)"
RUN_EXIT=$?
set -e
assert_not_equals "$RUN_EXIT" 0 'verifier fails closed when the manager status output is malformed'
assert_contains "$RUN_OUTPUT" 'Managed symlink status contract' 'malformed manager output names the repair contract'
assert_contains "$RUN_OUTPUT" 'DOTFILES_VERIFY_SUMMARY version=1 status=failed' 'malformed manager output remains a failed completion record'

[[ "$assertion_count" -eq 87 ]] || fail "expected 87 assertions, observed $assertion_count"
printf '1..%d\n' "$assertion_count"
