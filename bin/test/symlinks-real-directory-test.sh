#!/usr/bin/env bash

# Real managed-directory replacement contract. Each row executes a copied public
# script against a disposable HOME; expected paths, bytes, and manifest fields
# are test-owned literals rather than production helpers.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

UNSAFE_BASE_FIXTURE="$REPO_ROOT/bin/test/fixtures/symlinks-manage-destructive-base.sh"

assertion_count=0
RUN_OUTPUT=''
RUN_STATUS=0

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

assert_contains() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == *"$expected"* ]] || fail "$label (missing [$expected])"
  pass "$label"
}

assert_status() {
  local expected="$1" label="$2"
  [[ "$RUN_STATUS" -eq "$expected" ]] ||
    fail "$label (expected status $expected, got $RUN_STATUS; output: $RUN_OUTPUT)"
  pass "$label"
}

assert_directory_sentinel() {
  local directory="$1" sentinel="$2" label="$3"
  [[ -d "$directory" && ! -L "$directory" ]] || fail "$label (not a real directory)"
  cmp -s <(printf '%s' "$sentinel") "$directory/sentinel.bin" ||
    fail "$label (sentinel bytes changed)"
  pass "$label"
}

assert_file_bytes() {
  local file_path="$1" expected="$2" label="$3"
  [[ -f "$file_path" && ! -L "$file_path" ]] || fail "$label (not a regular file)"
  cmp -s <(printf '%s' "$expected") "$file_path" || fail "$label (bytes changed)"
  pass "$label"
}

make_fixture() {
  local name="$1" source_script="${2:-$REPO_ROOT/bin/dotfiles/symlinks/symlinks_manage.sh}"
  FIXTURE="$TEST_ROOT/$name"
  FIXTURE_REPO="$FIXTURE/repo"
  FIXTURE_HOME="$FIXTURE/home"
  FIXTURE_BIN="$FIXTURE/bin"
  FIXTURE_RECORDS="$FIXTURE/records"
  FIXTURE_SCRIPT="$FIXTURE_REPO/bin/dotfiles/symlinks/symlinks_manage.sh"
  TEST_MV_MODE=normal
  TEST_CONCURRENT_DESTINATION="$FIXTURE_HOME/.config"
  TEST_CONCURRENT_TARGET="$FIXTURE/outside-target"
  TEST_FIXTURE_ATOMIC_PHASE=''
  TEST_FIXTURE_ATOMIC_OBSTRUCTION=''
  TEST_FIXTURE_ATOMIC_SYMLINK_TARGET="$FIXTURE/outside-atomic-target"
	TEST_FIXTURE_SOURCE_HOLDER="$FIXTURE/original-before-source-swap"
	TEST_FIXTURE_CLAIM_RECORD="$FIXTURE/claim-path"
	TEST_FIXTURE_MANIFEST_RECORD="$FIXTURE/manifest-path"
  mkdir -p "$FIXTURE_REPO/bin/dotfiles/symlinks" "$FIXTURE_REPO/config" \
    "$FIXTURE_HOME" "$FIXTURE_BIN" "$FIXTURE_RECORDS"
  cp "$source_script" "$FIXTURE_SCRIPT"
  cp "$REPO_ROOT/bin/colour_log.sh" "$FIXTURE_REPO/bin/colour_log.sh"
  chmod +x "$FIXTURE_SCRIPT"

cat >"$FIXTURE_BIN/python3-wrapper" <<'STUB'
#!/bin/bash
operation="$2"
case "$operation" in
  snapshot) source="$3" ;;
  move-expected-identity) source="$3"; destination="$4" ;;
  claim-symlink) destination="$3" ;;
  claim-object) source="$3" ;;
  publish-manifest) destination="$3" ;;
  create-publish-symlink) source="$3"; destination="$4" ;;
  read-manifest) source="$3" ;;
  *) printf '%s\n' 'unknown fixture atomic operation' >&2; exit 64 ;;
esac

inject=false
case "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" in
  '') ;;
  backup) [[ "$operation" == move-expected-identity && "$destination" == *.dotfiles-backup.* && "$destination" != *.manifest* ]] && inject=true ;;
  manifest) [[ "$operation" == publish-manifest ]] && inject=true ;;
  restore) [[ "$operation" == claim-symlink ]] && inject=true ;;
  verification-rollback|replacement-wrong-target-with-rollback) [[ "$operation" == claim-symlink ]] && inject=true ;;
  source-swap) [[ "$operation" == move-expected-identity && "$destination" == *.dotfiles-backup.* && "$destination" != *.manifest* ]] && inject=true ;;
  manifest-fail) [[ "$operation" == publish-manifest ]] && exit 75 ;;
  manifest-fail-with-link) [[ "$operation" == publish-manifest ]] && exit 75 ;;
	move-internal-swap|claim-boundary|claim-pre-rename|claim-post-rename-obstruction|manifest-fd-swap|manifest-read-swap|restore-after-claim|replacement-create-fail|replacement-publication-foreign|replacement-wrong-target|replacement-wrong-target-with-rollback) ;;
  *) printf '%s\n' 'unknown fixture atomic phase' >&2; exit 64 ;;
esac
if $inject; then
  if [[ "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" == restore ]]; then
    /bin/rm "$destination"
  fi
	if [[ "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" == verification-rollback || "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" == replacement-wrong-target-with-rollback ]]; then
		/bin/rm "$destination"
		/bin/ln -s "$DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET" "$destination"
	fi
	if [[ "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" == source-swap ]]; then
		/bin/mv "$source" "$DOTFILES_FIXTURE_SOURCE_HOLDER"
		mkdir "$source"
		printf '%s' 'concurrent-source-directory-bytes' >"$source/sentinel.bin"
	fi
	case "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" in
	verification-rollback|source-swap) ;;
	*) case "${DOTFILES_FIXTURE_ATOMIC_OBSTRUCTION:-}" in
    directory)
      mkdir "$destination"
      printf '%s' 'concurrent-directory-bytes' >"$destination/concurrent.bin"
      ;;
    file) printf '%s' 'concurrent-file-bytes' >"$destination" ;;
    symlink) /bin/ln -s "$DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET" "$destination" ;;
    *) printf '%s\n' 'unknown fixture atomic obstruction' >&2; exit 64 ;;
	  esac ;;
	esac
fi
exec /usr/bin/python3 "$@"
STUB
  chmod +x "$FIXTURE_BIN/python3-wrapper"

  if [[ "$source_script" == "$REPO_ROOT/bin/dotfiles/symlinks/symlinks_manage.sh" ]]; then
    fixed_python_invocation='if ! /usr/bin/python3 - "$operation" "$@" <<'"'"'PY'"'"''
    fixture_python_invocation="if ! $FIXTURE_BIN/python3-wrapper - \"\$operation\" \"\$@\" <<'PY'"
    assert_equals "$(grep -Fc "$fixed_python_invocation" "$source_script" || true)" '1' 'source manager has one fixed atomic interpreter invocation'
    assert_equals "$(grep -Fc "$fixed_python_invocation" "$FIXTURE_SCRIPT" || true)" '1' 'fixture starts with one fixed atomic interpreter invocation'
    sed -i '' "s|$fixed_python_invocation|$fixture_python_invocation|" "$FIXTURE_SCRIPT"
    assert_equals "$(grep -Fc "$fixed_python_invocation" "$FIXTURE_SCRIPT" || true)" '0' 'fixture removes the fixed interpreter invocation once'
    assert_equals "$(grep -Fc "$fixture_python_invocation" "$FIXTURE_SCRIPT" || true)" '1' 'fixture installs one atomic interpreter wrapper invocation'
		move_seam='    exclusive_rename_or_exit(source_path, destination_path)'
		claim_seam='    # The private, mode-0700 directory prevents another identity from racing'
		postclaim_seam='    # A copied-test seam can obstruct reversal after a foreign claim.'
		replacement_create_seam='        os.symlink(target, staged_replacement)'
		replacement_stage_seam='        staged_status = os.lstat(staged_replacement)'
		manifest_fd_seam='        payload = manifest_contents.encode("utf-8")'
		manifest_read_seam='        chunks = []'
		restore_claim_seam=$'\t# A copied-test seam can obstruct the absent destination after claim.'
		assert_equals "$(grep -Fc "$move_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one post-identity move seam'
		assert_equals "$(grep -Fc "$claim_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one claim deletion seam'
		assert_equals "$(grep -Fc "$postclaim_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one post-claim reversal seam'
		assert_equals "$(grep -Fc "$replacement_create_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one private replacement creation seam'
		assert_equals "$(grep -Fc "$replacement_stage_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one private replacement publication seam'
		assert_equals "$(grep -Fc "$manifest_fd_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one descriptor-backed manifest seam'
		assert_equals "$(grep -Fc "$manifest_read_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one descriptor-backed manifest read seam'
		assert_equals "$(grep -Fc "$restore_claim_seam" "$FIXTURE_SCRIPT" || true)" '1' 'fixture finds one post-claim restore seam'
		/usr/bin/python3 - "$FIXTURE_SCRIPT" <<'PY'
import sys

path = sys.argv[1]
source = open(path).read()
marker = 'if operation == "snapshot"'
move_seam = '    exclusive_rename_or_exit(source_path, destination_path)'
claim_seam = '    # The private, mode-0700 directory prevents another identity from racing'
preclaim_seam = '    exclusive_rename_or_exit(path, private_claim_path)'
postclaim_seam = '    # A copied-test seam can obstruct reversal after a foreign claim.'
replacement_create_seam = '        os.symlink(target, staged_replacement)'
replacement_stage_seam = '        staged_status = os.lstat(staged_replacement)'
manifest_fd_seam = '        payload = manifest_contents.encode("utf-8")'
manifest_read_seam = '        chunks = []'
restore_claim_seam = '\t# A copied-test seam can obstruct the absent destination after claim.'
injection = '''def fixture_move_boundary(source_path, destination_path):
    phase = os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "")
    if phase == "move-internal-swap" and ".dotfiles-backup." in destination_path and not destination_path.endswith(".manifest"):
        os.rename(source_path, os.environ["DOTFILES_FIXTURE_SOURCE_HOLDER"])
        os.mkdir(source_path)
        with open(os.path.join(source_path, "sentinel.bin"), "wb") as stream:
            stream.write(b"internal-move-swap-bytes")

def fixture_claim_boundary(claim_path):
    if os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "") == "claim-boundary":
        os.rename(claim_path, claim_path + ".owned")
        os.symlink(os.environ["DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET"], claim_path)
        with open(os.environ["DOTFILES_FIXTURE_CLAIM_RECORD"], "w") as stream:
            stream.write(claim_path)

def fixture_preclaim_boundary(path):
    if os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "") in ("claim-pre-rename", "claim-post-rename-obstruction"):
        os.rename(path, path + ".owned")
        os.symlink(os.environ["DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET"], path)

def fixture_postclaim_boundary(path, private_claim_path):
    if os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "") == "claim-post-rename-obstruction":
        with open(path, "wb") as stream:
            stream.write(b"post-claim-obstruction-bytes")
        with open(os.environ["DOTFILES_FIXTURE_CLAIM_RECORD"], "w") as stream:
            stream.write(private_claim_path)

def fixture_replacement_creation_boundary(destination_path, target):
    if os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "") == "replacement-create-fail":
        raise OSError(5, "fixture replacement creation failure")

def fixture_replacement_publication_boundary(staged_replacement, destination_path, target):
    phase = os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "")
    if phase == "replacement-publication-foreign":
        os.symlink(target, destination_path)
    if phase in ("replacement-wrong-target", "replacement-wrong-target-with-rollback"):
        os.unlink(staged_replacement)
        os.symlink(os.environ["DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET"], staged_replacement)

def fixture_manifest_descriptor_boundary(temporary_manifest):
    if os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "") == "manifest-fd-swap":
        os.rename(temporary_manifest, temporary_manifest + ".owned")
        with open(temporary_manifest, "wb") as stream:
            stream.write(b"concurrent-temp-manifest-bytes")
        with open(os.environ["DOTFILES_FIXTURE_MANIFEST_RECORD"], "w") as stream:
            stream.write(temporary_manifest)

def fixture_manifest_read_boundary(manifest_path):
    if os.environ.get("DOTFILES_FIXTURE_ATOMIC_PHASE", "") == "manifest-read-swap":
        os.rename(manifest_path, manifest_path + ".owned")
        os.symlink(os.environ["DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET"], manifest_path)

'''
if source.count(marker) != 1 or source.count(move_seam) != 1 or source.count(claim_seam) != 1 or source.count(preclaim_seam) != 1 or source.count(postclaim_seam) != 1 or source.count(replacement_create_seam) != 1 or source.count(replacement_stage_seam) != 1 or source.count(manifest_fd_seam) != 1 or source.count(manifest_read_seam) != 1 or source.count(restore_claim_seam) != 1:
    raise SystemExit("fixture Python seam drifted")
source = source.replace(marker, injection + marker, 1)
source = source.replace(move_seam, '    fixture_move_boundary(source_path, destination_path)\n' + move_seam, 1)
source = source.replace(preclaim_seam, '    fixture_preclaim_boundary(path)\n' + preclaim_seam, 1)
source = source.replace(postclaim_seam, '    fixture_postclaim_boundary(path, private_claim_path)\n' + postclaim_seam, 1)
source = source.replace(claim_seam, '    fixture_claim_boundary(private_claim_path)\n' + claim_seam, 1)
source = source.replace(replacement_create_seam, '        fixture_replacement_creation_boundary(destination_path, target)\n' + replacement_create_seam, 1)
source = source.replace(replacement_stage_seam, '        fixture_replacement_publication_boundary(staged_replacement, destination_path, target)\n' + replacement_stage_seam, 1)
source = source.replace(manifest_fd_seam, '        fixture_manifest_descriptor_boundary(temporary_manifest)\n' + manifest_fd_seam, 1)
source = source.replace(manifest_read_seam, '        fixture_manifest_read_boundary(manifest_path)\n' + manifest_read_seam, 1)
fixture_restore_after_claim = '''\tif [[ "${DOTFILES_FIXTURE_ATOMIC_PHASE:-}" == "restore-after-claim" ]]; then
\t\tmkdir "$destination"
\t\tprintf '%s' 'concurrent-directory-bytes' >"$destination/concurrent.bin"
\tfi
'''
source = source.replace(restore_claim_seam, fixture_restore_after_claim + restore_claim_seam, 1)
open(path, "w").write(source)
PY
  fi
  git -C "$FIXTURE_REPO" init -q

  cat >"$FIXTURE_BIN/rm" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"$RM_RECORD"
for argument in "$@"; do
  case "$argument" in
    -r|-R|-rf|-fr|-rF|-Rf) exit 96 ;;
  esac
done
exec /bin/rm "$@"
STUB
  cat >"$FIXTURE_BIN/ln" <<'STUB'
#!/bin/bash
case "${LN_MODE:-normal}" in
  fail) exit 73 ;;
  fail-with-link)
    last_argument="${!#}"
    /bin/ln -s "$WRONG_TARGET" "$last_argument"
    exit 73
    ;;
	fail-with-exact-link)
		last_argument="${!#}"
		/bin/ln "$@"
		exit 73
		;;
  wrong)
    last_argument="${!#}"
    exec /bin/ln -s "$WRONG_TARGET" "$last_argument"
    ;;
  normal) exec /bin/ln "$@" ;;
  *) exit 74 ;;
esac
STUB
  cat >"$FIXTURE_BIN/mv" <<'STUB'
#!/bin/bash
last_argument="${!#}"
case "${MV_MODE:-normal}" in
  normal) exec /bin/mv "$@" ;;
  manifest-fail)
    [[ "$last_argument" == *.manifest ]] && exit 75
    exec /bin/mv "$@"
    ;;
  manifest-fail-with-link)
    if [[ "$last_argument" == *.manifest ]]; then
      /bin/ln -s "$CONCURRENT_TARGET" "$CONCURRENT_DESTINATION"
      exit 75
    fi
    exec /bin/mv "$@"
    ;;
  *) exit 76 ;;
esac
STUB
  chmod +x "$FIXTURE_BIN/rm" "$FIXTURE_BIN/ln" "$FIXTURE_BIN/mv"
}

seed_real_directory() {
  local sentinel="$1"
  mkdir -p "$FIXTURE_HOME/.config"
  printf '%s' "$sentinel" >"$FIXTURE_HOME/.config/sentinel.bin"
}

run_cli() {
  local mode="${1:-normal}"
  shift || true
  set +e
  RUN_OUTPUT="$(env -i HOME="$FIXTURE_HOME" DOTFILES_PROFILE=desktop \
    PATH="$FIXTURE_BIN:/usr/bin:/bin" RM_RECORD="$FIXTURE_RECORDS/rm-argv" \
    LN_MODE="$mode" WRONG_TARGET="$FIXTURE/outside-target" \
    MV_MODE="$TEST_MV_MODE" CONCURRENT_DESTINATION="$TEST_CONCURRENT_DESTINATION" \
    CONCURRENT_TARGET="$TEST_CONCURRENT_TARGET" \
    DOTFILES_FIXTURE_ATOMIC_PHASE="$TEST_FIXTURE_ATOMIC_PHASE" \
    DOTFILES_FIXTURE_ATOMIC_OBSTRUCTION="$TEST_FIXTURE_ATOMIC_OBSTRUCTION" \
    DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET="$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" \
		DOTFILES_FIXTURE_SOURCE_HOLDER="$TEST_FIXTURE_SOURCE_HOLDER" \
		DOTFILES_FIXTURE_CLAIM_RECORD="$TEST_FIXTURE_CLAIM_RECORD" \
		DOTFILES_FIXTURE_MANIFEST_RECORD="$TEST_FIXTURE_MANIFEST_RECORD" \
    /bin/bash "$FIXTURE_SCRIPT" "$@" 2>&1)"
  RUN_STATUS=$?
  set -e
}

run_interactive_link() {
  local answer="$1"
  set +e
  RUN_OUTPUT="$(env -i HOME="$FIXTURE_HOME" DOTFILES_PROFILE=desktop \
    PATH="$FIXTURE_BIN:/usr/bin:/bin" RM_RECORD="$FIXTURE_RECORDS/rm-argv" \
    LN_MODE=normal WRONG_TARGET="$FIXTURE/outside-target" ANSWER="$answer" \
    MV_MODE="$TEST_MV_MODE" CONCURRENT_DESTINATION="$TEST_CONCURRENT_DESTINATION" \
    CONCURRENT_TARGET="$TEST_CONCURRENT_TARGET" DOTFILES_FIXTURE_ATOMIC_PHASE="$TEST_FIXTURE_ATOMIC_PHASE" \
		DOTFILES_FIXTURE_ATOMIC_OBSTRUCTION="$TEST_FIXTURE_ATOMIC_OBSTRUCTION" DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET="$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" DOTFILES_FIXTURE_SOURCE_HOLDER="$TEST_FIXTURE_SOURCE_HOLDER" FIXTURE_SCRIPT="$FIXTURE_SCRIPT" /usr/bin/expect <<'EXPECT' 2>&1
set timeout 10
spawn /usr/bin/env -i HOME=$env(HOME) DOTFILES_PROFILE=$env(DOTFILES_PROFILE) PATH=$env(PATH) RM_RECORD=$env(RM_RECORD) LN_MODE=$env(LN_MODE) WRONG_TARGET=$env(WRONG_TARGET) MV_MODE=$env(MV_MODE) CONCURRENT_DESTINATION=$env(CONCURRENT_DESTINATION) CONCURRENT_TARGET=$env(CONCURRENT_TARGET) DOTFILES_FIXTURE_ATOMIC_PHASE=$env(DOTFILES_FIXTURE_ATOMIC_PHASE) DOTFILES_FIXTURE_ATOMIC_OBSTRUCTION=$env(DOTFILES_FIXTURE_ATOMIC_OBSTRUCTION) DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET=$env(DOTFILES_FIXTURE_ATOMIC_SYMLINK_TARGET) DOTFILES_FIXTURE_SOURCE_HOLDER=$env(DOTFILES_FIXTURE_SOURCE_HOLDER) /bin/bash -c {[[ -t 0 ]] || exit 70; printf 'PTY_STDIN=yes\n'; exec "$@"} _ /bin/bash $env(FIXTURE_SCRIPT) --link
expect {
  -re {replace with symlink\? \[y/N\] } { send -- "$env(ANSWER)\r"; exp_continue }
  eof {
    catch wait result
    exit [lindex $result 3]
  }
}
EXPECT
)"
  RUN_STATUS=$?
  set -e
}

manifest_for_home() {
  find "$FIXTURE_HOME" -type f -name '*.manifest' -print -quit
}

backup_for_home() {
  find "$FIXTURE_HOME" -mindepth 1 -type d -name '.config.dotfiles-backup.*' -print -quit
}

staged_replacement_for_home() {
  find "$FIXTURE_HOME" -type l -name '.*.dotfiles-replacement-stage.*' -print -quit
}

temporary_manifest_for_home() {
  find "$FIXTURE_HOME" -type f -path '*/.dotfiles-manifest-*/*' -print -quit
}

temporary_manifest_directory_for_home() {
  find "$FIXTURE_HOME" -type d -name '.dotfiles-manifest-*' -print -quit
}

private_claim_directory_for_home() {
  find "$FIXTURE_HOME" -type d -name '.dotfiles-claim-*' -print -quit
}

assert_no_recursive_rm() {
  local label="$1"
  [[ ! -e "$FIXTURE_RECORDS/rm-argv" ]] ||
    ! grep -Eq '(^| )-[^ ]*[rR]' "$FIXTURE_RECORDS/rm-argv" ||
    fail "$label (production attempted recursive rm)"
  pass "$label"
}

# Sensitivity control: a test-owned fixture preserves the old interactive
# rm -rf route without making public CI depend on excluded private history.
# These observations are the inverse of the GREEN assertions below.
make_fixture 'base-negative-control' "$UNSAFE_BASE_FIXTURE"
seed_real_directory 'base-sentinel-bytes'
# The base control must be allowed to demonstrate its destructive route. Every
# GREEN fixture keeps the observing rm wrapper installed.
/bin/rm "$FIXTURE_BIN/rm"
run_interactive_link 'y'
assert_status 0 'base interactive approval exits zero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'base negative control must replace the real directory with a symlink'
[[ ! -e "$FIXTURE_HOME/.config/sentinel.bin" ]] ||
  fail 'base negative control must remove the real directory sentinel'
pass 'base negative control removes the real directory sentinel'
assert_equals "$(manifest_for_home)" '' 'base negative control publishes no recovery manifest'
run_cli normal --restore "$FIXTURE_HOME/missing.manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'base negative control unexpectedly accepts public restore'
pass 'base negative control rejects the absent restore command'

make_fixture 'interactive-approval'
seed_real_directory 'interactive-sentinel-bytes'
run_interactive_link 'y'
assert_status 0 'interactive approval exits zero'
assert_contains "$RUN_OUTPUT" 'PTY_STDIN=yes' 'interactive approval proves pseudo-terminal stdin'
assert_contains "$RUN_OUTPUT" 'Back up and replace with symlink?' 'interactive approval shows recovery prompt'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'interactive approval creates a symlink'
pass 'interactive approval creates a symlink'
assert_equals "$(readlink "$FIXTURE_HOME/.config")" "$FIXTURE_REPO/config" 'interactive approval points to the literal managed source'
backup_path="$(backup_for_home)"
manifest_path="$(manifest_for_home)"
[[ -n "$backup_path" && -n "$manifest_path" ]] || fail 'interactive approval creates backup and manifest'
pass 'interactive approval creates backup and manifest'
assert_directory_sentinel "$backup_path" 'interactive-sentinel-bytes' 'interactive approval preserves backup sentinel bytes'
assert_equals "$(stat -f '%Lp' "$manifest_path")" '600' 'interactive manifest has mode 0600'
[[ ! -x "$manifest_path" ]] || fail 'interactive manifest must not be executable'
pass 'interactive manifest is non-executable'
physical_backup="$(cd "$(dirname "$backup_path")" && pwd -P)/$(basename "$backup_path")"
physical_manifest="$(cd "$(dirname "$manifest_path")" && pwd -P)/$(basename "$manifest_path")"
physical_script="$(cd "$(dirname "$FIXTURE_SCRIPT")" && pwd -P)/$(basename "$FIXTURE_SCRIPT")"
manifest_expected="version=1
expected_source=$FIXTURE_REPO/config
destination=$FIXTURE_HOME/.config
previous_object_type=directory
backup_path=$physical_backup
restore_command=$physical_script --restore $physical_manifest"
assert_equals "$(cat "$manifest_path")" "$manifest_expected" 'interactive manifest has literal versioned recovery fields'
assert_contains "$RUN_OUTPUT" "Restore with: $physical_script --restore $physical_manifest" 'interactive output prints the exact restore route'
assert_equals "$(temporary_manifest_directory_for_home)" '' 'interactive manifest publication leaves no owned temp directory'
assert_no_recursive_rm 'interactive replacement makes no recursive deletion call'
run_cli normal --restore "$manifest_path"
assert_status 0 'public restore exits zero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'interactive-sentinel-bytes' 'public restore preserves original sentinel bytes'
[[ ! -e "$backup_path" && ! -L "$backup_path" ]] || fail 'public restore consumes only the backup object'
pass 'public restore moves the backup back to its recorded destination'
[[ -f "$manifest_path" && ! -L "$manifest_path" ]] || fail 'public restore must retain the manifest'
pass 'public restore retains the manifest'
assert_contains "$RUN_OUTPUT" "Recovery manifest retained: $physical_manifest" 'public restore reports retained manifest'
assert_no_recursive_rm 'public restore makes no recursive deletion call'

make_fixture 'manifest-read-descriptor-swap'
seed_real_directory 'manifest-read-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'manifest read descriptor-swap setup exits zero'
manifest_read_swap_manifest="$(manifest_for_home)"
manifest_read_swap_backup="$(backup_for_home)"
[[ -n "$manifest_read_swap_manifest" && -n "$manifest_read_swap_backup" ]] || fail 'manifest read descriptor-swap setup creates recovery state'
pass 'manifest read descriptor-swap setup creates recovery state'
TEST_FIXTURE_ATOMIC_PHASE=manifest-read-swap
run_cli normal --restore "$manifest_read_swap_manifest"
assert_status 0 'manifest read descriptor swap restores from captured bytes'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'manifest-read-sentinel-bytes' 'manifest read descriptor swap restores original bytes'
[[ -L "$manifest_read_swap_manifest" ]] || fail 'manifest read descriptor swap preserves foreign manifest symlink'
pass 'manifest read descriptor swap preserves foreign manifest symlink'
assert_equals "$(readlink "$manifest_read_swap_manifest")" "$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" 'manifest read descriptor swap preserves foreign target'
[[ -f "${manifest_read_swap_manifest}.owned" ]] || fail 'manifest read descriptor swap retains captured manifest inode'
pass 'manifest read descriptor swap retains captured manifest inode'
[[ ! -e "$manifest_read_swap_backup" && ! -L "$manifest_read_swap_backup" ]] || fail 'manifest read descriptor swap consumes restored backup'
pass 'manifest read descriptor swap consumes restored backup'
assert_no_recursive_rm 'manifest read descriptor swap makes no recursive deletion call'

make_fixture 'interactive-refusal'
seed_real_directory 'refusal-sentinel-bytes'
run_interactive_link 'n'
assert_status 0 'interactive refusal exits zero'
assert_contains "$RUN_OUTPUT" 'PTY_STDIN=yes' 'interactive refusal proves pseudo-terminal stdin'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'refusal-sentinel-bytes' 'interactive refusal preserves original directory'
assert_equals "$(manifest_for_home)" '' 'interactive refusal creates no manifest'

make_fixture 'noninteractive-refusal'
seed_real_directory 'noninteractive-sentinel-bytes'
run_cli normal --link
assert_status 0 'noninteractive link without force exits zero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'noninteractive-sentinel-bytes' 'noninteractive link without force preserves original directory'
assert_equals "$(manifest_for_home)" '' 'noninteractive link without force creates no manifest'
assert_contains "$RUN_OUTPUT" 'Skipped (non-interactive, use --force to replace)' 'noninteractive refusal reports force requirement'

make_fixture 'dry-run'
seed_real_directory 'dry-run-sentinel-bytes'
run_cli normal --link --force --dry-run
assert_status 0 'dry-run force exits zero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'dry-run-sentinel-bytes' 'dry-run force preserves original directory'
assert_equals "$(manifest_for_home)" '' 'dry-run force creates no manifest'
assert_contains "$RUN_OUTPUT" '[DRY-RUN] Would move directory to backup:' 'dry-run force names planned backup'
assert_contains "$RUN_OUTPUT" '[DRY-RUN] Would publish mode-0600 manifest:' 'dry-run force names planned manifest publication'

make_fixture 'real-file-force'
printf '%s' 'managed-zshenv-source' >"$FIXTURE_REPO/.zshenv"
printf '%s' 'real-file-sentinel-bytes' >"$FIXTURE_HOME/.zshenv"
run_cli normal --link --force
assert_status 0 'real file force exits zero'
[[ -L "$FIXTURE_HOME/.zshenv" ]] || fail 'real file force creates a symlink'
pass 'real file force creates a symlink'
assert_equals "$(readlink "$FIXTURE_HOME/.zshenv")" "$FIXTURE_REPO/.zshenv" 'real file force points to literal source'
file_backup="$(find "$FIXTURE_HOME" -name '.zshenv.dotfiles-backup.*' ! -name '*.manifest' -print -quit)"
file_manifest="$(manifest_for_home)"
[[ -f "$file_backup" && ! -L "$file_backup" ]] || fail 'real file force creates a regular backup'
pass 'real file force creates a regular backup'
cmp -s <(printf '%s' 'real-file-sentinel-bytes') "$file_backup" || fail 'real file force preserves sentinel bytes'
pass 'real file force preserves sentinel bytes'
assert_contains "$(cat "$file_manifest")" 'previous_object_type=file' 'real file force manifest records file type'
run_cli normal --restore "$file_manifest"
assert_status 0 'real file public restore exits zero'
cmp -s <(printf '%s' 'real-file-sentinel-bytes') "$FIXTURE_HOME/.zshenv" || fail 'real file public restore preserves sentinel bytes'
pass 'real file public restore preserves sentinel bytes'

make_fixture 'force-approval'
seed_real_directory 'force-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'explicit force exits zero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'explicit force creates a symlink'
pass 'explicit force creates a symlink'
force_backup="$(backup_for_home)"
force_manifest="$(manifest_for_home)"
[[ -n "$force_backup" && -n "$force_manifest" ]] || fail 'explicit force creates backup and manifest'
pass 'explicit force creates backup and manifest'
assert_directory_sentinel "$force_backup" 'force-sentinel-bytes' 'explicit force preserves backup sentinel bytes'
assert_contains "$(cat "$force_manifest")" "destination=$FIXTURE_HOME/.config" 'explicit force manifest records destination'
assert_no_recursive_rm 'explicit force makes no recursive deletion call'

# Restore treats the manifest as data. Each refusal starts from the same valid
# manifest and independently observes that the backup and managed link remain.
force_manifest_bytes="$(cat "$force_manifest")"
restore_refusal() {
  local label="$1"
  run_cli normal --restore "$force_manifest"
  [[ "$RUN_STATUS" -ne 0 ]] || fail "$label must exit nonzero"
  pass "$label exits nonzero"
  [[ -L "$FIXTURE_HOME/.config" ]] || fail "$label must leave the managed link in place"
  pass "$label leaves the managed link in place"
  [[ -e "$force_backup" && ! -L "$force_backup" ]] || fail "$label must preserve the backup"
  pass "$label preserves the backup"
}
printf '%s\nunknown_field=literal' "$force_manifest_bytes" >"$force_manifest"
chmod 600 "$force_manifest"
restore_refusal 'unknown manifest field refusal'
printf '%s\nversion=1' "$force_manifest_bytes" >"$force_manifest"
chmod 600 "$force_manifest"
restore_refusal 'duplicate manifest field refusal'
printf '%s\nmalformed' "$force_manifest_bytes" >"$force_manifest"
chmod 600 "$force_manifest"
restore_refusal 'malformed manifest field refusal'
printf '%s\n\n' "$force_manifest_bytes" >"$force_manifest"
chmod 600 "$force_manifest"
restore_refusal 'trailing blank manifest record refusal'
printf '%s' "$force_manifest_bytes" | sed 's|^expected_source=.*$|expected_source=/unexpected-source|' >"$force_manifest"
chmod 600 "$force_manifest"
restore_refusal 'mismatched managed mapping refusal'
printf '%s' "$force_manifest_bytes" >"$force_manifest"
chmod 600 "$force_manifest"
/bin/mv "$force_backup" "$FIXTURE/outside-backup"
run_cli normal --restore "$force_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'missing backup refusal must exit nonzero'
pass 'missing backup refusal exits nonzero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'missing backup refusal must preserve managed link'
pass 'missing backup refusal preserves managed link'
/bin/mv "$FIXTURE/outside-backup" "$force_backup"
/bin/mv "$force_manifest" "$FIXTURE/outside-manifest"
/bin/ln -s "$FIXTURE/outside-manifest" "$force_manifest"
run_cli normal --restore "$force_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'symlinked manifest refusal must exit nonzero'
pass 'symlinked manifest refusal exits nonzero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'symlinked manifest refusal must preserve managed link'
pass 'symlinked manifest refusal preserves managed link'
/bin/rm "$force_manifest"
/bin/mv "$FIXTURE/outside-manifest" "$force_manifest"
/bin/rm "$FIXTURE_HOME/.config"
/bin/ln -s "$FIXTURE/outside-target" "$FIXTURE_HOME/.config"
run_cli normal --restore "$force_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'unexpected destination target refusal must exit nonzero'
pass 'unexpected destination target refusal exits nonzero'
[[ -e "$force_backup" ]] || fail 'unexpected destination target refusal must preserve backup'
pass 'unexpected destination target refusal preserves backup'
/bin/rm "$FIXTURE_HOME/.config"
/bin/ln -s "$FIXTURE_REPO/config" "$FIXTURE_HOME/.config"
/bin/rm "$FIXTURE_HOME/.config"
mkdir "$FIXTURE_HOME/.config"
run_cli normal --restore "$force_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'non-link destination refusal must exit nonzero'
pass 'non-link destination refusal exits nonzero'
assert_directory_sentinel "$force_backup" 'force-sentinel-bytes' 'non-link destination refusal preserves backup bytes'
/bin/rmdir "$FIXTURE_HOME/.config"
/bin/ln -s "$FIXTURE_REPO/config" "$FIXTURE_HOME/.config"
unsafe_manifest_suffix=$'unsafe\nmanifest'
unsafe_manifest_path="$FIXTURE_HOME/$unsafe_manifest_suffix"
printf '%s\n' 'literal unsafe-path manifest bytes' >"$unsafe_manifest_path"
chmod 600 "$unsafe_manifest_path"
[[ -f "$unsafe_manifest_path" && ! -L "$unsafe_manifest_path" ]] || fail 'unsafe-path fixture is a regular manifest file'
pass 'unsafe-path fixture is a regular manifest file'
run_cli normal --restore "$unsafe_manifest_path"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'unrepresentable manifest path refusal must exit nonzero'
pass 'unrepresentable manifest path refusal exits nonzero'
assert_contains "$RUN_OUTPUT" 'Refusing missing, symlinked, or unsafe manifest' 'unrepresentable manifest path reaches unsafe-path refusal'
assert_equals "$(readlink "$FIXTURE_HOME/.config")" "$FIXTURE_REPO/config" 'unrepresentable manifest path preserves managed link'
assert_directory_sentinel "$force_backup" 'force-sentinel-bytes' 'unrepresentable manifest path preserves backup bytes'

make_fixture 'atomic-backup-publication-obstruction'
seed_real_directory 'atomic-backup-publication-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=backup
TEST_FIXTURE_ATOMIC_OBSTRUCTION=file
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'atomic backup publication obstruction must exit nonzero'
pass 'atomic backup publication obstruction exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'atomic-backup-publication-sentinel-bytes' 'atomic backup publication obstruction preserves original bytes'
atomic_backup_obstruction="$(find "$FIXTURE_HOME" -type f -name '.config.dotfiles-backup.*' ! -name '*.manifest*' -print -quit)"
[[ -n "$atomic_backup_obstruction" ]] || fail 'atomic backup publication obstruction preserves race winner'
pass 'atomic backup publication obstruction preserves race winner'
assert_file_bytes "$atomic_backup_obstruction" 'concurrent-file-bytes' 'atomic backup publication obstruction bytes remain untouched'
assert_equals "$(manifest_for_home)" '' 'atomic backup publication obstruction publishes no manifest'
assert_no_recursive_rm 'atomic backup publication obstruction makes no recursive deletion call'

make_fixture 'atomic-manifest-publication-obstruction'
seed_real_directory 'atomic-manifest-publication-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=manifest
TEST_FIXTURE_ATOMIC_OBSTRUCTION=file
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'atomic manifest publication obstruction must exit nonzero'
pass 'atomic manifest publication obstruction exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'atomic-manifest-publication-sentinel-bytes' 'atomic manifest publication obstruction restores original bytes'
assert_equals "$(backup_for_home)" '' 'atomic manifest publication obstruction restores backup from absent destination'
atomic_manifest_obstruction="$(find "$FIXTURE_HOME" -type f -name '*.manifest' -print -quit)"
[[ -n "$atomic_manifest_obstruction" ]] || fail 'atomic manifest publication obstruction preserves race winner'
pass 'atomic manifest publication obstruction preserves race winner'
assert_file_bytes "$atomic_manifest_obstruction" 'concurrent-file-bytes' 'atomic manifest publication obstruction bytes remain untouched'
assert_equals "$(temporary_manifest_for_home)" '' 'atomic manifest publication obstruction cleans the owned temporary manifest'
assert_no_recursive_rm 'atomic manifest publication obstruction makes no recursive deletion call'
assert_equals "$(temporary_manifest_directory_for_home)" '' 'atomic manifest publication obstruction leaves no owned temp directory'

make_fixture 'manifest-publication-failure'
seed_real_directory 'manifest-publication-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=manifest-fail
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'ordinary manifest-publication failure must exit nonzero'
pass 'ordinary manifest-publication failure exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'manifest-publication-sentinel-bytes' 'ordinary manifest-publication failure restores original directory'
assert_equals "$(backup_for_home)" '' 'ordinary manifest-publication failure leaves no backup object'
assert_equals "$(temporary_manifest_for_home)" '' 'ordinary manifest-publication failure cleans the owned temporary manifest'
assert_equals "$(temporary_manifest_directory_for_home)" '' 'ordinary manifest-publication failure leaves no owned temp directory'
assert_no_recursive_rm 'ordinary manifest-publication failure makes no recursive deletion call'

make_fixture 'manifest-publication-obstruction'
seed_real_directory 'manifest-obstruction-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=manifest-fail-with-link
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'obstructed manifest-publication failure must exit nonzero'
pass 'obstructed manifest-publication failure exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'manifest-obstruction-sentinel-bytes' 'obstructed manifest-publication failure preserves original before backup publication'
assert_equals "$(backup_for_home)" '' 'obstructed manifest-publication failure leaves no unaddressable backup'
assert_equals "$(temporary_manifest_for_home)" '' 'obstructed manifest-publication failure cleans the owned temporary manifest'
assert_equals "$(temporary_manifest_directory_for_home)" '' 'obstructed manifest-publication failure leaves no owned temp directory'
assert_no_recursive_rm 'obstructed manifest-publication failure makes no recursive deletion call'

make_fixture 'same-type-source-swap'
seed_real_directory 'approved-source-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=source-swap
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'same-type source swap must exit nonzero'
pass 'same-type source swap exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'concurrent-source-directory-bytes' 'same-type source swap preserves concurrent directory bytes'
assert_directory_sentinel "$TEST_FIXTURE_SOURCE_HOLDER" 'approved-source-sentinel-bytes' 'same-type source swap preserves approved directory bytes'
assert_equals "$(backup_for_home)" '' 'same-type source swap does not back up the swapped directory'
assert_equals "$(manifest_for_home)" '' 'same-type source swap removes the unused manifest'
assert_no_recursive_rm 'same-type source swap makes no recursive deletion call'

make_fixture 'internal-move-boundary-swap'
seed_real_directory 'internal-move-approved-bytes'
TEST_FIXTURE_ATOMIC_PHASE=move-internal-swap
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'internal move boundary swap must exit nonzero'
pass 'internal move boundary swap exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'internal-move-swap-bytes' 'internal move boundary swap preserves swapped directory after reversal'
assert_directory_sentinel "$TEST_FIXTURE_SOURCE_HOLDER" 'internal-move-approved-bytes' 'internal move boundary swap preserves approved directory bytes'
assert_equals "$(backup_for_home)" '' 'internal move boundary swap leaves no foreign backup'
assert_equals "$(manifest_for_home)" '' 'internal move boundary swap removes unused manifest'
assert_no_recursive_rm 'internal move boundary swap makes no recursive deletion call'

make_fixture 'temporary-manifest-swap'
seed_real_directory 'temporary-manifest-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=manifest-fd-swap
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'temporary manifest swap must exit nonzero'
pass 'temporary manifest swap exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'temporary-manifest-sentinel-bytes' 'temporary manifest swap preserves original before backup publication'
assert_equals "$(backup_for_home)" '' 'temporary manifest swap leaves no backup object'
[[ -f "$TEST_FIXTURE_MANIFEST_RECORD" ]] || fail 'temporary manifest swap records the private foreign pathname'
pass 'temporary manifest swap records the private foreign pathname'
temp_manifest_race_winner="$(cat "$TEST_FIXTURE_MANIFEST_RECORD")"
assert_file_bytes "$temp_manifest_race_winner" 'concurrent-temp-manifest-bytes' 'temporary manifest swap race winner bytes remain untouched'
assert_equals "$(manifest_for_home)" '' 'temporary manifest swap publishes no swapped manifest'
physical_temp_manifest_race_winner="$(cd "$(dirname "$temp_manifest_race_winner")" && pwd -P)/$(basename "$temp_manifest_race_winner")"
temporary_manifest_layout_path="$(temporary_manifest_for_home)"
[[ "$physical_temp_manifest_race_winner" -ef "$temporary_manifest_layout_path" ]] || fail 'temporary manifest swap inspects the private helper layout'
pass 'temporary manifest swap inspects the private helper layout'
[[ -f "${temp_manifest_race_winner}.owned" ]] || fail 'temporary manifest swap retains the descriptor-owned manifest inode'
pass 'temporary manifest swap retains the descriptor-owned manifest inode'
assert_contains "$RUN_OUTPUT" "temporary manifest identity changed; foreign object retained: $temp_manifest_race_winner" 'temporary manifest swap reports the retained foreign pathname'
assert_no_recursive_rm 'temporary manifest swap makes no recursive deletion call'

make_fixture 'atomic-restore-directory-obstruction'
seed_real_directory 'atomic-directory-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'atomic directory-obstruction setup exits zero'
atomic_directory_manifest="$(manifest_for_home)"
atomic_directory_backup="$(backup_for_home)"
[[ -n "$atomic_directory_manifest" && -n "$atomic_directory_backup" ]] || fail 'atomic directory-obstruction setup creates manifest and backup'
pass 'atomic directory-obstruction setup creates manifest and backup'
TEST_FIXTURE_ATOMIC_PHASE=restore-after-claim
TEST_FIXTURE_ATOMIC_OBSTRUCTION=directory
run_cli normal --restore "$atomic_directory_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'atomic directory obstruction must exit nonzero'
pass 'atomic directory obstruction exits nonzero'
[[ -d "$FIXTURE_HOME/.config" && ! -L "$FIXTURE_HOME/.config" ]] || fail 'atomic directory obstruction remains a real directory'
pass 'atomic directory obstruction remains a real directory'
assert_file_bytes "$FIXTURE_HOME/.config/concurrent.bin" 'concurrent-directory-bytes' 'atomic directory obstruction bytes remain untouched'
assert_directory_sentinel "$atomic_directory_backup" 'atomic-directory-sentinel-bytes' 'atomic directory obstruction preserves backup bytes'
[[ -f "$atomic_directory_manifest" && ! -L "$atomic_directory_manifest" ]] || fail 'atomic directory obstruction retains the manifest after successful claim'
pass 'atomic directory obstruction retains the manifest after successful claim'
assert_contains "$RUN_OUTPUT" 'Rollback refused obstructed destination' 'atomic directory obstruction reaches backup restore after claim'
assert_no_recursive_rm 'atomic directory obstruction makes no recursive deletion call'
/bin/rm "$FIXTURE_HOME/.config/concurrent.bin"
/bin/rmdir "$FIXTURE_HOME/.config"
TEST_FIXTURE_ATOMIC_PHASE=''
run_cli normal --restore "$atomic_directory_manifest"
assert_status 0 'atomic directory obstruction retry restores from absent destination'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'atomic-directory-sentinel-bytes' 'atomic directory obstruction retry preserves backup bytes'
[[ ! -e "$atomic_directory_backup" && ! -L "$atomic_directory_backup" ]] || fail 'atomic directory obstruction retry consumes the backup'
pass 'atomic directory obstruction retry consumes the backup'

make_fixture 'atomic-restore-file-obstruction'
seed_real_directory 'atomic-file-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'atomic file-obstruction setup exits zero'
atomic_file_manifest="$(manifest_for_home)"
atomic_file_backup="$(backup_for_home)"
[[ -n "$atomic_file_manifest" && -n "$atomic_file_backup" ]] || fail 'atomic file-obstruction setup creates manifest and backup'
pass 'atomic file-obstruction setup creates manifest and backup'
TEST_FIXTURE_ATOMIC_PHASE=restore
TEST_FIXTURE_ATOMIC_OBSTRUCTION=file
run_cli normal --restore "$atomic_file_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'atomic file obstruction must exit nonzero'
pass 'atomic file obstruction exits nonzero'
assert_file_bytes "$FIXTURE_HOME/.config" 'concurrent-file-bytes' 'atomic file obstruction bytes remain untouched'
assert_directory_sentinel "$atomic_file_backup" 'atomic-file-sentinel-bytes' 'atomic file obstruction preserves backup bytes'
assert_no_recursive_rm 'atomic file obstruction makes no recursive deletion call'

make_fixture 'private-claim-deletion-boundary'
seed_real_directory 'private-claim-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'private claim boundary setup exits zero'
private_claim_manifest="$(manifest_for_home)"
private_claim_backup="$(backup_for_home)"
TEST_FIXTURE_ATOMIC_PHASE=claim-boundary
run_cli normal --restore "$private_claim_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'private claim boundary race must exit nonzero'
pass 'private claim boundary race exits nonzero'
[[ -f "$TEST_FIXTURE_CLAIM_RECORD" ]] || fail 'private claim boundary records the private claim path'
pass 'private claim boundary records the private claim path'
private_claim_path="$(cat "$TEST_FIXTURE_CLAIM_RECORD")"
[[ -L "$private_claim_path" ]] || fail 'private claim boundary retains foreign private-claim object'
pass 'private claim boundary retains foreign private-claim object'
assert_equals "$(readlink "$private_claim_path")" "$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" 'private claim boundary never deletes foreign object'
assert_contains "$RUN_OUTPUT" "foreign object retained for recovery: $private_claim_path" 'private claim boundary reports precise recovery path'
assert_directory_sentinel "$private_claim_backup" 'private-claim-sentinel-bytes' 'private claim boundary preserves backup bytes'
assert_no_recursive_rm 'private claim boundary makes no recursive deletion call'

make_fixture 'preclaim-foreign-reversal'
seed_real_directory 'preclaim-foreign-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'preclaim foreign reversal setup exits zero'
preclaim_backup="$(backup_for_home)"
preclaim_manifest="$(manifest_for_home)"
TEST_FIXTURE_ATOMIC_PHASE=claim-pre-rename
run_cli normal --restore "$preclaim_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'preclaim foreign reversal must exit nonzero'
pass 'preclaim foreign reversal exits nonzero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'preclaim foreign reversal restores the foreign object to source'
pass 'preclaim foreign reversal restores the foreign object to source'
assert_equals "$(readlink "$FIXTURE_HOME/.config")" "$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" 'preclaim foreign reversal preserves the foreign target'
assert_contains "$RUN_OUTPUT" 'claimed foreign object restored to source' 'preclaim foreign reversal reports the reversible claim'
assert_equals "$(private_claim_directory_for_home)" '' 'preclaim foreign reversal removes the empty private claim directory'
assert_directory_sentinel "$preclaim_backup" 'preclaim-foreign-sentinel-bytes' 'preclaim foreign reversal preserves backup bytes'
assert_no_recursive_rm 'preclaim foreign reversal makes no recursive deletion call'

make_fixture 'preclaim-foreign-reversal-obstructed'
seed_real_directory 'preclaim-obstructed-sentinel-bytes'
run_cli normal --link --force
assert_status 0 'preclaim obstruction setup exits zero'
preclaim_obstructed_backup="$(backup_for_home)"
preclaim_obstructed_manifest="$(manifest_for_home)"
TEST_FIXTURE_ATOMIC_PHASE=claim-post-rename-obstruction
run_cli normal --restore "$preclaim_obstructed_manifest"
[[ "$RUN_STATUS" -ne 0 ]] || fail 'preclaim obstruction must exit nonzero'
pass 'preclaim obstruction exits nonzero'
assert_file_bytes "$FIXTURE_HOME/.config" 'post-claim-obstruction-bytes' 'preclaim obstruction preserves source race winner bytes'
[[ -f "$TEST_FIXTURE_CLAIM_RECORD" ]] || fail 'preclaim obstruction records precise recovery path'
pass 'preclaim obstruction records precise recovery path'
preclaim_recovery_path="$(cat "$TEST_FIXTURE_CLAIM_RECORD")"
[[ -L "$preclaim_recovery_path" ]] || fail 'preclaim obstruction retains foreign object at recovery path'
pass 'preclaim obstruction retains foreign object at recovery path'
assert_equals "$(readlink "$preclaim_recovery_path")" "$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" 'preclaim obstruction never deletes claimed foreign object'
assert_contains "$RUN_OUTPUT" "claimed foreign object retained for recovery: $preclaim_recovery_path" 'preclaim obstruction reports precise recovery path'
assert_directory_sentinel "$preclaim_obstructed_backup" 'preclaim-obstructed-sentinel-bytes' 'preclaim obstruction preserves backup bytes'
assert_no_recursive_rm 'preclaim obstruction makes no recursive deletion call'

make_fixture 'creation-failure-rollback'
seed_real_directory 'creation-failure-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=replacement-create-fail
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'injected link-creation failure exits nonzero'
pass 'injected link-creation failure exits nonzero'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'creation-failure-sentinel-bytes' 'injected link-creation failure restores exact directory bytes'
assert_equals "$(backup_for_home)" '' 'injected link-creation failure leaves no backup object'
failure_manifest="$(manifest_for_home)"
[[ -f "$failure_manifest" ]] || fail 'injected link-creation failure retains recovery manifest'
pass 'injected link-creation failure retains recovery manifest'
assert_no_recursive_rm 'injected link-creation rollback makes no recursive deletion call'

make_fixture 'creation-failure-obstruction'
seed_real_directory 'creation-obstruction-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=replacement-publication-foreign
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'foreign exact-target publication winner must exit nonzero'
pass 'foreign exact-target publication winner exits nonzero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'foreign exact-target publication winner retains the foreign destination'
pass 'foreign exact-target publication winner retains the foreign destination'
assert_equals "$(readlink "$FIXTURE_HOME/.config")" "$FIXTURE_REPO/config" 'foreign exact-target publication winner preserves the exact foreign target'
foreign_publication_backup="$(backup_for_home)"
[[ -n "$foreign_publication_backup" ]] || fail 'foreign exact-target publication winner retains recoverable backup'
pass 'foreign exact-target publication winner retains recoverable backup'
assert_directory_sentinel "$foreign_publication_backup" 'creation-obstruction-sentinel-bytes' 'foreign exact-target publication winner preserves backup bytes'
assert_no_recursive_rm 'foreign exact-target publication winner makes no recursive deletion call'

make_fixture 'creation-failure-exact-stage'
seed_real_directory 'creation-exact-stage-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=replacement-wrong-target
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'owned wrong-target verification failure must exit nonzero'
pass 'owned wrong-target verification failure exits nonzero'
assert_contains "$RUN_OUTPUT" 'Replacement symlink verification failed' 'owned wrong-target injection reaches final verification'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'creation-exact-stage-sentinel-bytes' 'owned wrong-target verification failure restores original bytes'
assert_equals "$(backup_for_home)" '' 'owned wrong-target verification failure restores backup'
assert_no_recursive_rm 'owned wrong-target verification failure makes no recursive deletion call'

make_fixture 'verification-rollback-concurrent-symlink'
seed_real_directory 'verification-concurrent-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=replacement-wrong-target-with-rollback
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'concurrent verification rollback replacement must exit nonzero'
pass 'concurrent verification rollback replacement exits nonzero'
[[ -L "$FIXTURE_HOME/.config" ]] || fail 'concurrent verification rollback replacement retains concurrent symlink'
pass 'concurrent verification rollback replacement retains concurrent symlink'
assert_equals "$(readlink "$FIXTURE_HOME/.config")" "$TEST_FIXTURE_ATOMIC_SYMLINK_TARGET" 'concurrent verification rollback replacement leaves concurrent symlink untouched'
verification_concurrent_backup="$(backup_for_home)"
[[ -n "$verification_concurrent_backup" ]] || fail 'concurrent verification rollback replacement retains recoverable backup'
pass 'concurrent verification rollback replacement retains recoverable backup'
assert_directory_sentinel "$verification_concurrent_backup" 'verification-concurrent-sentinel-bytes' 'concurrent verification rollback replacement preserves backup bytes'
[[ -f "$(manifest_for_home)" ]] || fail 'concurrent verification rollback replacement retains the recovery manifest'
pass 'concurrent verification rollback replacement retains the recovery manifest'
assert_no_recursive_rm 'concurrent verification rollback replacement makes no recursive deletion call'

make_fixture 'wrong-link-verification-rollback'
seed_real_directory 'verification-failure-sentinel-bytes'
TEST_FIXTURE_ATOMIC_PHASE=replacement-wrong-target
run_cli normal --link --force
[[ "$RUN_STATUS" -ne 0 ]] || fail 'zero-exit wrong-link injection exits nonzero after verification'
pass 'zero-exit wrong-link injection exits nonzero after verification'
assert_contains "$RUN_OUTPUT" 'Replacement symlink verification failed' 'zero-exit wrong-link injection reaches final verification'
assert_directory_sentinel "$FIXTURE_HOME/.config" 'verification-failure-sentinel-bytes' 'zero-exit wrong-link injection restores exact directory bytes'
assert_equals "$(backup_for_home)" '' 'zero-exit wrong-link injection leaves no backup object'
assert_no_recursive_rm 'zero-exit wrong-link rollback makes no recursive deletion call'

printf '1..%d\n' "$assertion_count"
