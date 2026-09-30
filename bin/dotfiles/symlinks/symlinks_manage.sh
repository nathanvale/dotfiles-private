#!/bin/bash
# symlinks_manage.sh - Create and manage dotfiles symlinks
#
# Usage:
#   symlinks_manage.sh --link      Create all symlinks
#   symlinks_manage.sh --unlink    Remove all symlinks
#   symlinks_manage.sh --status    Show current symlink status
#   symlinks_manage.sh --status --machine
#                                  Emit machine-readable status for every mapping
#   symlinks_manage.sh --restore MANIFEST
#   symlinks_manage.sh --dry-run   Preview what would be done (with --link or --unlink)
#   symlinks_manage.sh --force     Replace existing files/dirs without prompting
#
# This script is portable - it auto-detects the dotfiles location.

set -e

# Auto-detect dotfiles directory (3 levels up from this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOTFILES="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# VS Code user directory (macOS)
VSCODE_USER="${HOME}/Library/Application Support/Code/User"

# Source logging utilities
source "$DOTFILES/bin/colour_log.sh"

get_profile() {
	if [[ -n "${DOTFILES_PROFILE:-}" ]]; then
		echo "$DOTFILES_PROFILE"
	elif [[ -r "$HOME/.dotfiles_state/profile" ]]; then
		cat "$HOME/.dotfiles_state/profile"
	else
		echo "desktop"
	fi
}

PROFILE="$(get_profile)"
if [[ "$PROFILE" != "desktop" && "$PROFILE" != "server" ]]; then
	log "$ERROR" "Invalid dotfiles profile: $PROFILE"
	exit 1
fi

# Shared symlinks are safe and useful on every machine. App integrations that
# only exist on an interactive Mac belong in desktop_symlinks.
common_symlinks=(
	# Shell configuration
	"${HOME}/.zshenv|${DOTFILES}/.zshenv"
	"${HOME}/.zshrc|${DOTFILES}/.zshrc"
	"${HOME}/.zprofile|${DOTFILES}/.zprofile"

	# Git configuration
	"${HOME}/.gitconfig|${DOTFILES}/.gitconfig"
	"${HOME}/.gitignore_global|${DOTFILES}/.gitignore_global"
	"${HOME}/.gitmessage|${DOTFILES}/.gitmessage"

	# Bun package-manager configuration
	"${HOME}/.bunfig.toml|${DOTFILES}/config/bun/bunfig.toml"

	# XDG config directory (symlinks entire .config)
	"${HOME}/.config|${DOTFILES}/config"

	# Bin directories
	"${HOME}/bin|${DOTFILES}/bin"
	"${HOME}/Scripts|${DOTFILES}/Scripts"

	# Tmux (doesn't follow XDG, needs explicit symlink)
	"${HOME}/.tmux.conf|${DOTFILES}/config/tmux/tmux.conf"

	# Agent startup instructions
	"${HOME}/.codex/AGENTS.md|${DOTFILES}/config/agents/AGENTS.md"
	"${HOME}/.codex/hooks.json|${DOTFILES}/config/agents/codex/hooks.json"
	"${HOME}/.claude/CLAUDE.md|${DOTFILES}/config/agents/claude/CLAUDE.md"
	"${HOME}/.claude/settings.json|${DOTFILES}/config/agents/claude/settings.json"
	"${HOME}/.claude/hooks|${DOTFILES}/config/agents/claude/hooks"
)

desktop_symlinks=(
	# VS Code
	"${VSCODE_USER}/settings.json|${DOTFILES}/config/vscode/settings.json"
	"${VSCODE_USER}/tasks.json|${DOTFILES}/config/vscode/tasks.json"
	"${VSCODE_USER}/keybindings.json|${DOTFILES}/config/vscode/keybindings.json"
	"${VSCODE_USER}/prompts|${DOTFILES}/config/vscode/prompts"
	"${VSCODE_USER}/mcp.json|${DOTFILES}/config/vscode/mcp.json"

	# SuperWhisper (app stores recordings/modes here)
	"${HOME}/Documents/superwhisper|${DOTFILES}/config/superwhisper"

	# launchd user agents (loaded from ~/Library/LaunchAgents, not XDG)
	"${HOME}/Library/LaunchAgents/com.nathanvale.raycast-restart.plist|${DOTFILES}/config/launchd/com.nathanvale.raycast-restart.plist"
)

server_symlinks=(
	# LM Studio API recovery for the headless inference server
	"${HOME}/.local/bin/lm-studio-ensure.sh|${DOTFILES}/bin/system/lm-studio-ensure.sh"
	"${HOME}/Library/LaunchAgents/com.nathanvale.lm-studio-ensure.plist|${DOTFILES}/config/launchd/com.nathanvale.lm-studio-ensure.plist"
)

symlinks=("${common_symlinks[@]}")
if [[ "$PROFILE" == "desktop" ]]; then
	symlinks+=("${desktop_symlinks[@]}")
else
	symlinks+=("${server_symlinks[@]}")
fi

# Flags
DRY_RUN=false
FORCE=false
RESTORE_MANIFEST=""
MACHINE_STATUS=false
MANIFEST_VERSION="1"
manifest_fields=(version expected_source destination previous_object_type backup_path restore_command)

usage() {
	echo "Usage: $0 [OPTIONS] COMMAND"
	echo ""
	echo "Commands:"
	echo "  -l, --link      Create symlinks"
	echo "  -u, --unlink    Remove symlinks"
	echo "  -s, --status    Show current symlink status"
	echo "      --machine   Emit machine-readable status (with --status)"
	echo "      --restore MANIFEST"
	echo "                   Restore one backed-up real file or directory"
	echo ""
	echo "Options:"
	echo "  -f, --force     Replace existing files/dirs without prompting"
	echo "  -n, --dry-run   Preview changes without making them"
	echo "  -h, --help      Show this help message"
	echo ""
	echo "Dotfiles location: $DOTFILES"
	echo "Machine profile:  $PROFILE"
	exit 1
}

is_representable_absolute_path() {
	local path="$1"
	[[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]]
}

path_is_within() {
	local path="$1"
	local root="$2"
	[[ "$path" == "$root" || "$path" == "$root/"* ]]
}

object_type() {
	local path="$1"
	if [[ -L "$path" ]]; then
		echo "symlink"
	elif [[ -f "$path" ]]; then
		echo "file"
	elif [[ -d "$path" ]]; then
		echo "directory"
	else
		echo "unknown"
	fi
}

darwin_atomic_operation() {
	local operation="$1"
	shift

	if [[ ! -x /usr/bin/python3 ]]; then
		log "$ERROR" "Atomic restore requires macOS /usr/bin/python3 for renamex_np"
		return 1
	fi
	if ! /usr/bin/python3 - "$operation" "$@" <<'PY'
import ctypes
import os
import stat
import sys
import tempfile

operation, *arguments = sys.argv[1:]

libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
renamex_np = libsystem.renamex_np
renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
renamex_np.restype = ctypes.c_int

# Darwin sys/stdio.h: RENAME_EXCL | RENAME_NOFOLLOW_ANY.
flags = 0x00000004 | 0x00000010
manifest_output_marker = "__dotfiles_manifest_eof_7f3e8d4a__"

def exclusive_rename(source_path, destination_path):
    if renamex_np(os.fsencode(source_path), os.fsencode(destination_path), flags) == 0:
        return
    error_number = ctypes.get_errno()
    raise OSError(error_number or 1, os.strerror(error_number))

def exclusive_rename_or_exit(source_path, destination_path):
    try:
        exclusive_rename(source_path, destination_path)
    except OSError as error:
        print(f"renamex_np failed: {error.strerror}", file=sys.stderr)
        sys.exit(error.errno or 1)

def object_type(status):
    if stat.S_ISREG(status.st_mode):
        return "file"
    if stat.S_ISDIR(status.st_mode):
        return "directory"
    if stat.S_ISLNK(status.st_mode):
        return "symlink"
    return "unknown"

def matches_identity(path, expected_type, expected_device, expected_inode, expected_target=None):
    status = os.lstat(path)
    if (
        object_type(status) != expected_type
        or (status.st_dev, status.st_ino) != (int(expected_device), int(expected_inode))
    ):
        return False
    return expected_target is None or os.readlink(path) == expected_target

def claim_and_remove(path, claim_path, expected_type, expected_device, expected_inode, expected_target=None):
    if not matches_identity(path, expected_type, expected_device, expected_inode, expected_target):
        print("object is not the expected owned replacement", file=sys.stderr)
        sys.exit(65)
    claim_directory = tempfile.mkdtemp(prefix=".dotfiles-claim-", dir=os.path.dirname(path))
    private_claim_path = os.path.join(claim_directory, "object")
    exclusive_rename_or_exit(path, private_claim_path)
    # A copied-test seam can obstruct reversal after a foreign claim.
    if not matches_identity(private_claim_path, expected_type, expected_device, expected_inode, expected_target):
        try:
            exclusive_rename(private_claim_path, path)
        except OSError:
            print(f"claimed foreign object retained for recovery: {private_claim_path}", file=sys.stderr)
            sys.exit(65)
        try:
            os.rmdir(claim_directory)
        except OSError:
            print(f"empty private claim directory retained for recovery: {claim_directory}", file=sys.stderr)
            sys.exit(65)
        print("claimed foreign object restored to source", file=sys.stderr)
        sys.exit(65)
    # The private, mode-0700 directory prevents another identity from racing
    # this final unlink. A copied-test seam can perturb before this recheck.
    if not matches_identity(private_claim_path, expected_type, expected_device, expected_inode, expected_target):
        print(f"claimed object changed at deletion boundary; foreign object retained for recovery: {private_claim_path}", file=sys.stderr)
        sys.exit(65)
    os.unlink(private_claim_path)
    os.rmdir(claim_directory)

def fd_matches_path(file_descriptor, path):
    descriptor_status = os.fstat(file_descriptor)
    try:
        path_status = os.lstat(path)
    except FileNotFoundError:
        return False
    return (
        stat.S_ISREG(descriptor_status.st_mode)
        and stat.S_ISREG(path_status.st_mode)
        and (descriptor_status.st_dev, descriptor_status.st_ino)
        == (path_status.st_dev, path_status.st_ino)
    )

def remove_owned_private_path(path, expected_device, expected_inode):
    if matches_identity(path, "file", expected_device, expected_inode):
        os.unlink(path)

def publish_manifest_from_descriptor(manifest_path, manifest_contents):
    private_directory = tempfile.mkdtemp(prefix=".dotfiles-manifest-", dir=os.path.dirname(manifest_path))
    os.chmod(private_directory, 0o700)
    temporary_manifest = os.path.join(private_directory, "manifest")
    descriptor = None
    expected_device = None
    expected_inode = None
    try:
        descriptor = os.open(
            temporary_manifest,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        descriptor_status = os.fstat(descriptor)
        if not stat.S_ISREG(descriptor_status.st_mode):
            print("temporary manifest is not a regular file", file=sys.stderr)
            sys.exit(65)
        expected_device, expected_inode = descriptor_status.st_dev, descriptor_status.st_ino
        os.fchmod(descriptor, 0o600)
        # A copied-test seam can swap this private pathname after fd ownership.
        payload = manifest_contents.encode("utf-8")
        written = 0
        while written < len(payload):
            written += os.write(descriptor, payload[written:])
        os.fsync(descriptor)
        if not fd_matches_path(descriptor, temporary_manifest):
            print(
                f"temporary manifest identity changed; foreign object retained: {temporary_manifest}",
                file=sys.stderr,
            )
            sys.exit(65)
        os.close(descriptor)
        descriptor = None
        exclusive_rename(temporary_manifest, manifest_path)
        if not matches_identity(manifest_path, "file", expected_device, expected_inode):
            print(f"published manifest changed; recovery manifest retained: {manifest_path}", file=sys.stderr)
            sys.exit(65)
        os.rmdir(private_directory)
        print(f"file\t{expected_device}\t{expected_inode}")
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        if expected_device is not None and expected_inode is not None:
            try:
                remove_owned_private_path(temporary_manifest, expected_device, expected_inode)
            except OSError:
                pass
        try:
            os.rmdir(private_directory)
        except OSError:
            pass
        print(f"manifest publication failed: {error.strerror}", file=sys.stderr)
        sys.exit(error.errno or 1)

def create_and_publish_replacement(target, destination_path):
    private_directory = tempfile.mkdtemp(prefix=".dotfiles-replacement-", dir=os.path.dirname(destination_path))
    os.chmod(private_directory, 0o700)
    staged_replacement = os.path.join(private_directory, "replacement")
    expected_device = None
    expected_inode = None
    try:
        os.symlink(target, staged_replacement)
        # A copied-test seam can exercise creation and publication races.
        staged_status = os.lstat(staged_replacement)
        if not stat.S_ISLNK(staged_status.st_mode):
            print("private replacement is not a symlink", file=sys.stderr)
            sys.exit(65)
        expected_device, expected_inode = staged_status.st_dev, staged_status.st_ino
        exclusive_rename(staged_replacement, destination_path)
        if not matches_identity(destination_path, "symlink", expected_device, expected_inode):
            print(f"published replacement changed; foreign destination retained: {destination_path}", file=sys.stderr)
            sys.exit(65)
        os.rmdir(private_directory)
        print(f"symlink\t{expected_device}\t{expected_inode}")
    except OSError as error:
        if expected_device is not None and expected_inode is not None:
            try:
                if matches_identity(staged_replacement, "symlink", expected_device, expected_inode):
                    os.unlink(staged_replacement)
            except OSError:
                pass
        try:
            os.rmdir(private_directory)
        except OSError:
            pass
        print(f"replacement publication failed: {error.strerror}", file=sys.stderr)
        sys.exit(error.errno or 1)

def read_manifest_from_descriptor(manifest_path):
    descriptor = None
    try:
        descriptor = os.open(manifest_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        descriptor_status = os.fstat(descriptor)
        if not stat.S_ISREG(descriptor_status.st_mode) or stat.S_IMODE(descriptor_status.st_mode) != 0o600:
            print("manifest descriptor is not a mode-0600 regular file", file=sys.stderr)
            sys.exit(65)
        # A copied-test seam can swap the public pathname after fd ownership.
        chunks = []
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        manifest_contents = b"".join(chunks)
        if b"\0" in manifest_contents:
            print("manifest contains an unrepresentable byte", file=sys.stderr)
            sys.exit(65)
        sys.stdout.buffer.write(manifest_contents + manifest_output_marker.encode("ascii"))
    except OSError as error:
        print(f"manifest read failed: {error.strerror}", file=sys.stderr)
        sys.exit(error.errno or 1)
    finally:
        if descriptor is not None:
            os.close(descriptor)

if operation == "snapshot" and len(arguments) == 1:
    status = os.lstat(arguments[0])
    print(f"{object_type(status)}\t{status.st_dev}\t{status.st_ino}")
elif operation == "move-expected-identity" and len(arguments) == 5:
    source_path, destination_path, expected_type, expected_device, expected_inode = arguments
    if not matches_identity(source_path, expected_type, expected_device, expected_inode):
        print("source is not the approved object", file=sys.stderr)
        sys.exit(65)
    exclusive_rename_or_exit(source_path, destination_path)
    if not matches_identity(destination_path, expected_type, expected_device, expected_inode):
        try:
            exclusive_rename(destination_path, source_path)
        except OSError:
            print("mismatched moved object could not be preserved at source", file=sys.stderr)
            sys.exit(65)
        print("moved object changed before post-move verification", file=sys.stderr)
        sys.exit(65)
elif operation == "publish-manifest" and len(arguments) == 2:
    manifest_path, manifest_contents = arguments
    publish_manifest_from_descriptor(manifest_path, manifest_contents)
elif operation == "create-publish-symlink" and len(arguments) == 2:
    target, destination_path = arguments
    create_and_publish_replacement(target, destination_path)
elif operation == "read-manifest" and len(arguments) == 1:
    read_manifest_from_descriptor(arguments[0])
elif operation == "claim-symlink" and len(arguments) == 5:
    destination_path, claim_path, expected_target, expected_device, expected_inode = arguments
    claim_and_remove(destination_path, claim_path, "symlink", expected_device, expected_inode, expected_target)
elif operation == "claim-object" and len(arguments) == 5:
    path, claim_path, expected_type, expected_device, expected_inode = arguments
    claim_and_remove(path, claim_path, expected_type, expected_device, expected_inode)
else:
    print("invalid atomic operation", file=sys.stderr)
    sys.exit(64)
PY
	then
		log "$ERROR" "Darwin atomic operation failed: $operation"
		return 1
	fi
}

snapshot_object() {
	darwin_atomic_operation snapshot "$1"
}

move_expected_object() {
	darwin_atomic_operation move-expected-identity "$1" "$2" "$3" "$4" "$5"
}

next_claim_path() {
	local path="$1"
	local purpose="$2"
	local parent_dir base_name timestamp candidate counter=0
	parent_dir="$(physical_parent_dir "$path")" || return 1
	base_name="$(basename "$path")"
	timestamp="$(date +%Y%m%d%H%M%S)"
	while :; do
		candidate="$parent_dir/.${base_name}.dotfiles-${purpose}-claim.${timestamp}.$$.${counter}"
		if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
			printf '%s\n' "$candidate"
			return 0
		fi
		counter=$((counter + 1))
	done
}

remove_expected_managed_symlink() {
	local destination="$1"
	local expected_target="$2"
	local expected_device="$3"
	local expected_inode="$4"
	local destination_parent destination_physical claim_path
	destination_parent="$(physical_parent_dir "$destination")" || return 1
	destination_physical="$destination_parent/$(basename "$destination")"
	claim_path="$(next_claim_path "$destination" restore)" || return 1
	darwin_atomic_operation claim-symlink "$destination_physical" "$claim_path" "$expected_target" "$expected_device" "$expected_inode"
}

remove_expected_object() {
	local path="$1"
	local expected_type="$2"
	local expected_device="$3"
	local expected_inode="$4"
	local claim_path
	claim_path="$(next_claim_path "$path" cleanup)" || return 1
	darwin_atomic_operation claim-object "$path" "$claim_path" "$expected_type" "$expected_device" "$expected_inode"
}

managed_mapping_matches() {
	local expected_source="$1"
	local destination="$2"
	local entry entry_destination entry_source

	for entry in "${symlinks[@]}"; do
		entry_destination="${entry%%|*}"
		entry_source="${entry##*|}"
		if [[ "$entry_destination" == "$destination" && "$entry_source" == "$expected_source" ]]; then
			return 0
		fi
	done

	return 1
}

physical_parent_dir() {
	local path="$1"
	local parent_dir
	parent_dir="$(dirname "$path")"
	(cd "$parent_dir" && pwd -P)
}

next_replacement_paths() {
	local destination="$1"
	local parent_dir base_name timestamp candidate counter=0
	parent_dir="$(physical_parent_dir "$destination")" || return 1
	base_name="$(basename "$destination")"
	timestamp="$(date +%Y%m%d%H%M%S)"

	while :; do
		candidate="$parent_dir/${base_name}.dotfiles-backup.${timestamp}.$$.${counter}"
		if [[ ! -e "$candidate" && ! -L "$candidate" && ! -e "${candidate}.manifest" && ! -L "${candidate}.manifest" ]]; then
			printf '%s\n%s\n' "$candidate" "${candidate}.manifest"
			return 0
		fi
		counter=$((counter + 1))
	done
}

shell_quoted_restore_command() {
	local manifest_path="$1"
	local script_path quoted_script quoted_manifest
	script_path="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
	printf -v quoted_script '%q' "$script_path"
	printf -v quoted_manifest '%q' "$manifest_path"
	printf '%s --restore %s' "$quoted_script" "$quoted_manifest"
}

publish_manifest() {
	local manifest_path="$1"
	local expected_source="$2"
	local destination="$3"
	local previous_type="$4"
	local backup_path="$5"
	local restore_command manifest_contents manifest_field
	restore_command="$(shell_quoted_restore_command "$manifest_path")"
	manifest_contents=""
	for manifest_field in "${manifest_fields[@]}"; do
		case "$manifest_field" in
		version) printf -v manifest_contents '%s%s=%s\n' "$manifest_contents" "$manifest_field" "$MANIFEST_VERSION" ;;
		expected_source) printf -v manifest_contents '%s%s=%s\n' "$manifest_contents" "$manifest_field" "$expected_source" ;;
		destination) printf -v manifest_contents '%s%s=%s\n' "$manifest_contents" "$manifest_field" "$destination" ;;
		previous_object_type) printf -v manifest_contents '%s%s=%s\n' "$manifest_contents" "$manifest_field" "$previous_type" ;;
		backup_path) printf -v manifest_contents '%s%s=%s\n' "$manifest_contents" "$manifest_field" "$backup_path" ;;
		restore_command) printf -v manifest_contents '%s%s=%s\n' "$manifest_contents" "$manifest_field" "$restore_command" ;;
		esac
	done
	darwin_atomic_operation publish-manifest "$manifest_path" "$manifest_contents"
}

create_published_replacement() {
	local target="$1"
	local destination="$2"
	darwin_atomic_operation create-publish-symlink "$target" "$destination"
}

read_manifest_contents() {
	darwin_atomic_operation read-manifest "$1"
}

restore_backup_to_absent_destination() {
	local destination="$1"
	local backup_path="$2"
	local expected_type="$3"
	local destination_parent destination_physical backup_snapshot backup_type backup_device backup_inode

	if [[ -e "$destination" || -L "$destination" ]]; then
		log "$ERROR" "Rollback refused obstructed destination: $destination"
		return 1
	fi

	if [[ ! -e "$backup_path" || -L "$backup_path" ]]; then
		log "$ERROR" "Rollback backup is missing or unsafe: $backup_path"
		return 1
	fi
	destination_parent="$(physical_parent_dir "$destination")" || {
		log "$ERROR" "Rollback could not resolve destination parent: $destination"
		return 1
	}
	destination_physical="$destination_parent/$(basename "$destination")"
	backup_snapshot="$(snapshot_object "$backup_path")" || {
		log "$ERROR" "Rollback could not identify backup object: $backup_path"
		return 1
	}
	IFS=$'\t' read -r backup_type backup_device backup_inode <<<"$backup_snapshot"
	if [[ "$backup_type" != "$expected_type" || ! "$backup_device" =~ ^[0-9]+$ || ! "$backup_inode" =~ ^[0-9]+$ ]]; then
		log "$ERROR" "Rollback backup identity changed: $backup_path"
		return 1
	fi
	move_expected_object "$backup_path" "$destination_physical" "$backup_type" "$backup_device" "$backup_inode" || {
		log "$ERROR" "Rollback could not restore backup without replacing: $backup_path"
		return 1
	}
	if [[ -e "$backup_path" || -L "$backup_path" || "$(object_type "$destination")" != "$expected_type" ]]; then
		log "$ERROR" "Rollback restored an unexpected object type: $destination"
		return 1
	fi
	log "$WARNING" "Restored original $expected_type after replacement failure: $destination"
}

rollback_verified_link() {
	local destination="$1"
	local backup_path="$2"
	local expected_type="$3"
	local expected_target="$4"
	local replacement_device="$5"
	local replacement_inode="$6"

	# A zero-exit link command reached final verification, so this bounded
	# rollback may claim and remove only the exact attempted replacement link.
	remove_expected_managed_symlink "$destination" "$expected_target" "$replacement_device" "$replacement_inode" || {
		log "$ERROR" "Rollback could not atomically remove the attempted replacement symlink: $destination"
		return 1
	}
	restore_backup_to_absent_destination "$destination" "$backup_path" "$expected_type"
}

replace_real_object() {
	local target="$1"
	local destination="$2"
	local source_snapshot="$3"
	local previous_type source_device source_inode backup_path manifest_path manifest_snapshot paths
	local replacement_snapshot replacement_type replacement_device replacement_inode staged_target
	IFS=$'\t' read -r previous_type source_device source_inode <<<"$source_snapshot"
	if [[ ( "$previous_type" != "file" && "$previous_type" != "directory" ) || ! "$source_device" =~ ^[0-9]+$ || ! "$source_inode" =~ ^[0-9]+$ ]]; then
		log "$ERROR" "Refusing unsupported existing object identity at: $destination"
		return 1
	fi
	if ! is_representable_absolute_path "$target" || ! is_representable_absolute_path "$destination"; then
		log "$ERROR" "Refusing path that cannot be represented safely"
		return 1
	fi
	paths="$(next_replacement_paths "$destination")" || {
		log "$ERROR" "Cannot create an adjacent backup path for: $destination"
		return 1
	}
	backup_path="${paths%%$'\n'*}"
	manifest_path="${paths##*$'\n'}"
	if path_is_within "$backup_path" "$DOTFILES"; then
		log "$ERROR" "Refusing backup inside the dotfiles repository: $backup_path"
		return 1
	fi

	if $DRY_RUN; then
		log "$INFO" "[DRY-RUN] Would move $previous_type to backup: $backup_path"
		log "$INFO" "[DRY-RUN] Would publish mode-0600 manifest: $manifest_path"
		log "$INFO" "[DRY-RUN] Would create and verify: $destination -> $target"
		return 0
	fi

	local destination_parent destination_physical
	destination_parent="$(physical_parent_dir "$destination")" || {
		log "$ERROR" "Could not resolve existing object parent: $destination"
		return 1
	}
	destination_physical="$destination_parent/$(basename "$destination")"
	# Publish the exact public recovery route before moving the approved object.
	# If publication fails, the original object is still in its original place.
	manifest_snapshot="$(publish_manifest "$manifest_path" "$target" "$destination" "$previous_type" "$backup_path")" || {
		log "$ERROR" "Could not publish replacement manifest: $manifest_path"
		return 1
	}
	if ! move_expected_object "$destination_physical" "$backup_path" "$previous_type" "$source_device" "$source_inode"; then
		log "$ERROR" "Could not move existing object to backup: $destination"
		IFS=$'\t' read -r _manifest_type _manifest_device _manifest_inode <<<"$manifest_snapshot"
		remove_expected_object "$manifest_path" "$_manifest_type" "$_manifest_device" "$_manifest_inode" ||
			log "$ERROR" "Could not safely remove unused manifest: $manifest_path"
		return 1
	fi
	replacement_snapshot="$(create_published_replacement "$target" "$destination_physical")" || {
		log "$ERROR" "Could not create and publish replacement symlink: $destination"
		restore_backup_to_absent_destination "$destination" "$backup_path" "$previous_type" || true
		return 1
	}
	IFS=$'\t' read -r replacement_type replacement_device replacement_inode <<<"$replacement_snapshot"
	if [[ "$replacement_type" != "symlink" || ! "$replacement_device" =~ ^[0-9]+$ || ! "$replacement_inode" =~ ^[0-9]+$ ]]; then
		log "$ERROR" "Published replacement is not a safe symlink: $destination"
		restore_backup_to_absent_destination "$destination" "$backup_path" "$previous_type" || true
		return 1
	fi
	if [[ ! -L "$destination" || "$(readlink "$destination")" != "$target" ]]; then
		log "$ERROR" "Replacement symlink verification failed: $destination"
		if [[ "$replacement_type" != "symlink" || ! "$replacement_device" =~ ^[0-9]+$ || ! "$replacement_inode" =~ ^[0-9]+$ ]]; then
			log "$ERROR" "Replacement cannot be proven to be the attempted symlink: $destination"
			restore_backup_to_absent_destination "$destination" "$backup_path" "$previous_type" || true
			return 1
		fi
		staged_target="$(readlink "$destination" 2>/dev/null || true)"
		rollback_verified_link "$destination" "$backup_path" "$previous_type" "$staged_target" "$replacement_device" "$replacement_inode" || true
		return 1
	fi
	log "$INFO" "Backed up original $previous_type to: $backup_path"
	log "$INFO" "Published recovery manifest: $manifest_path"
	log "$INFO" "Restore with: $(shell_quoted_restore_command "$manifest_path")"
	log "$INFO" "Replaced: $destination -> $target"
}

restore_manifest() {
	local manifest_path="$1"
	local manifest_contents manifest_output_marker='__dotfiles_manifest_eof_7f3e8d4a__' line key value
	local version="" expected_source="" destination="" previous_type="" backup_path="" restore_command=""
	local expected_command backup_parent destination_parent manifest_parent destination_snapshot destination_type destination_device destination_inode destination_is_absent=false
	local manifest_field_index=0 expected_field

	if ! is_representable_absolute_path "$manifest_path"; then
		log "$ERROR" "Refusing missing, symlinked, or unsafe manifest: $manifest_path"
		return 1
	fi
	manifest_parent="$(physical_parent_dir "$manifest_path")" || {
		log "$ERROR" "Cannot resolve manifest parent: $manifest_path"
		return 1
	}
	manifest_path="$manifest_parent/$(basename "$manifest_path")"
	manifest_contents="$(read_manifest_contents "$manifest_path")" || {
		log "$ERROR" "Refusing missing, symlinked, or unsafe manifest: $manifest_path"
		return 1
	}
	if [[ "$manifest_contents" != *"$manifest_output_marker" ]]; then
		log "$ERROR" "Refusing manifest with an incomplete descriptor read: $manifest_path"
		return 1
	fi
	manifest_contents="${manifest_contents%"$manifest_output_marker"}"
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" == *=* ]] || {
			log "$ERROR" "Refusing malformed manifest field"
			return 1
		}
		key="${line%%=*}"
		value="${line#*=}"
		[[ -n "$value" ]] || {
			log "$ERROR" "Refusing empty manifest field: $key"
			return 1
		}
		expected_field="${manifest_fields[$manifest_field_index]:-}"
		if [[ "$key" != "$expected_field" ]]; then
			log "$ERROR" "Refusing unknown, duplicate, or out-of-order manifest field: $key"
			return 1
		fi
		case "$expected_field" in
		version) version="$value" ;;
		expected_source) expected_source="$value" ;;
		destination) destination="$value" ;;
		previous_object_type) previous_type="$value" ;;
		backup_path) backup_path="$value" ;;
		restore_command) restore_command="$value" ;;
		esac
		manifest_field_index=$((manifest_field_index + 1))
	done < <(printf '%s' "$manifest_contents")

	if [[ "$manifest_field_index" -ne "${#manifest_fields[@]}" ]]; then
		log "$ERROR" "Refusing incomplete manifest: $manifest_path"
		return 1
	fi
	if [[ "$version" != "$MANIFEST_VERSION" || ( "$previous_type" != "file" && "$previous_type" != "directory" ) ]]; then
		log "$ERROR" "Refusing unsupported manifest version or object type"
		return 1
	fi
	if ! is_representable_absolute_path "$expected_source" || ! is_representable_absolute_path "$destination" || ! is_representable_absolute_path "$backup_path"; then
		log "$ERROR" "Refusing manifest path that cannot be represented safely"
		return 1
	fi
	if ! managed_mapping_matches "$expected_source" "$destination"; then
		log "$ERROR" "Refusing manifest with a mismatched managed symlink mapping"
		return 1
	fi
	backup_parent="$(physical_parent_dir "$backup_path")" || return 1
	destination_parent="$(physical_parent_dir "$destination")" || return 1
	if [[ "$backup_parent" != "$destination_parent" || "$backup_path" != "$destination_parent/$(basename "$destination").dotfiles-backup."* || "$manifest_path" != "${backup_path}.manifest" ]] || path_is_within "$backup_path" "$DOTFILES"; then
		log "$ERROR" "Refusing manifest with an unsafe backup location"
		return 1
	fi
	expected_command="$(shell_quoted_restore_command "$manifest_path")"
	if [[ "$restore_command" != "$expected_command" ]]; then
		log "$ERROR" "Refusing manifest with an unexpected restore command"
		return 1
	fi
	if [[ -L "$backup_path" || ! -e "$backup_path" || "$(object_type "$backup_path")" != "$previous_type" ]]; then
		log "$ERROR" "Refusing missing, symlinked, or mismatched backup: $backup_path"
		return 1
	fi
	if [[ ! -e "$destination" && ! -L "$destination" ]]; then
		destination_is_absent=true
	else
		if [[ ! -L "$destination" || "$(readlink "$destination")" != "$expected_source" ]]; then
			log "$ERROR" "Refusing destination that is not the expected managed symlink: $destination"
			return 1
		fi
		destination_snapshot="$(snapshot_object "$destination")" || {
			log "$ERROR" "Could not identify managed replacement symlink: $destination"
			return 1
		}
		IFS=$'\t' read -r destination_type destination_device destination_inode <<<"$destination_snapshot"
		if [[ "$destination_type" != "symlink" || ! "$destination_device" =~ ^[0-9]+$ || ! "$destination_inode" =~ ^[0-9]+$ ]]; then
			log "$ERROR" "Refusing destination with an unsafe replacement identity: $destination"
			return 1
		fi
	fi
	if $DRY_RUN; then
		if ! $destination_is_absent; then
			log "$INFO" "[DRY-RUN] Would remove managed symlink: $destination"
		fi
		log "$INFO" "[DRY-RUN] Would restore backup: $backup_path"
		return 0
	fi
	if ! $destination_is_absent; then
		if ! remove_expected_managed_symlink "$destination" "$expected_source" "$destination_device" "$destination_inode"; then
			log "$ERROR" "Could not atomically remove expected managed replacement symlink: $destination"
			return 1
		fi
	fi
	# A copied-test seam can obstruct the absent destination after claim.
	if ! restore_backup_to_absent_destination "$destination" "$backup_path" "$previous_type"; then
		log "$ERROR" "Could not restore backup without replacing: $backup_path"
		return 1
	fi
	log "$INFO" "Restored original $previous_type: $destination"
	log "$INFO" "Recovery manifest retained: $manifest_path"
}

require_canonical_activation_checkout() {
	local git_dir common_dir
	git -C "$DOTFILES" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
	git_dir="$(git -C "$DOTFILES" rev-parse --absolute-git-dir 2>/dev/null)" || {
		log "$ERROR" "Cannot classify the activation checkout: $DOTFILES"
		exit 1
	}
	common_dir="$(git -C "$DOTFILES" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
		log "$ERROR" "Cannot classify the activation checkout: $DOTFILES"
		exit 1
	}

	if [[ "$git_dir" != "$common_dir" ]]; then
		log "$ERROR" "Activation from a linked worktree is blocked: $DOTFILES"
		log "$ERROR" "Review in the worktree, then activate from $HOME/code/dotfiles after the change is accepted."
		exit 1
	fi
}

# Create parent directory if it doesn't exist
ensure_parent_dir() {
	local path="$1"
	local parent_dir
	parent_dir="$(dirname "$path")"

	if [[ ! -d "$parent_dir" ]]; then
		if $DRY_RUN; then
			log "$INFO" "[DRY-RUN] Would create directory: $parent_dir"
		else
			mkdir -p "$parent_dir"
			log "$INFO" "Created directory: $parent_dir"
		fi
	fi
}

# Create symlink if it doesn't already exist or is incorrect
create_symlink() {
	local target=$1
	local link_name=$2
	local replacement_snapshot
	local previous_target
	local replacement_error

	# Check if target exists in dotfiles
	if [[ ! -e "$target" ]]; then
		log "$WARNING" "Target does not exist: $target (skipping)"
		return
	fi

	# Ensure parent directory exists
	ensure_parent_dir "$link_name"

	if [[ -L "$link_name" ]]; then
		if [[ "$(readlink "$link_name")" == "$target" ]]; then
			log "$INFO" "Already correct: $link_name"
		else
			if $DRY_RUN; then
				log "$WARNING" "[DRY-RUN] Would update: $link_name -> $target"
			else
				previous_target="$(readlink "$link_name")"

				# Never direct ln at a symlink-to-directory: BSD ln follows that
				# destination and creates a child beneath the former referent.
				if ! rm "$link_name"; then
					log "$ERROR" "Rejected update; could not remove symlink: $link_name"
					return 1
				fi

				if ! ln -s "$target" "$link_name"; then
					replacement_error="could not create intended symlink"
				elif [[ ! -L "$link_name" ]] || [[ "$(readlink "$link_name")" != "$target" ]]; then
					replacement_error="replacement verification failed"
				else
					log "$INFO" "Updated: $link_name -> $target"
					return
				fi

				# Only remove a replacement symlink. A non-link created by a failed
				# command is left intact rather than widening this slice into file or
				# directory replacement.
				if [[ -L "$link_name" ]] && ! rm "$link_name"; then
					log "$ERROR" "Rejected update; could not remove replacement symlink: $link_name"
					return 1
				fi
				if [[ -e "$link_name" ]]; then
					log "$ERROR" "Rejected update; replacement is not a symlink and prior link cannot be restored: $link_name"
					return 1
				fi

				if ln -s -- "$previous_target" "$link_name" && [[ -L "$link_name" ]] && [[ "$(readlink "$link_name")" == "$previous_target" ]]; then
					log "$ERROR" "Rejected update; $replacement_error; restored previous symlink: $link_name -> $previous_target"
				else
					log "$ERROR" "Rejected update; $replacement_error; failed to restore previous symlink: $link_name -> $previous_target"
				fi
				return 1
			fi
		fi
	elif [[ -e "$link_name" ]]; then
		log "$WARNING" "Exists but not a symlink: $link_name"
		replacement_snapshot="$(snapshot_object "$link_name")" || {
			log "$ERROR" "Could not identify existing object for replacement: $link_name"
			return 1
		}
		if $DRY_RUN; then
			replace_real_object "$target" "$link_name" "$replacement_snapshot"
		elif $FORCE; then
			replace_real_object "$target" "$link_name" "$replacement_snapshot"
		elif [[ -t 0 ]]; then
			read -p "Back up and replace with symlink? [y/N] " -n 1 -r
			echo
			if [[ $REPLY =~ ^[Yy]$ ]]; then
				replace_real_object "$target" "$link_name" "$replacement_snapshot"
			else
				log "$INFO" "Skipped: $link_name"
			fi
		else
			# Non-interactive mode without --force: skip
			log "$WARNING" "Skipped (non-interactive, use --force to replace): $link_name"
		fi
	else
		if $DRY_RUN; then
			log "$INFO" "[DRY-RUN] Would create: $link_name -> $target"
		else
			ln -s "$target" "$link_name"
			log "$INFO" "Created: $link_name -> $target"
		fi
	fi
}

# Remove symlink if it exists
remove_symlink() {
	local link_name=$1

	if [[ -L "$link_name" ]]; then
		if $DRY_RUN; then
			log "$INFO" "[DRY-RUN] Would remove: $link_name"
		else
			rm "$link_name"
			log "$INFO" "Removed: $link_name"
		fi
	elif [[ -e "$link_name" ]]; then
		log "$WARNING" "Not a symlink (skipping): $link_name"
	else
		log "$INFO" "Does not exist: $link_name"
	fi
}

# Show status of all symlinks
show_status() {
	echo ""
	echo "Dotfiles: $DOTFILES"
	echo "Profile:  $PROFILE"
	echo ""
	printf "%-50s %-10s %s\n" "LINK" "STATUS" "TARGET"
	printf "%-50s %-10s %s\n" "----" "------" "------"

	for entry in "${symlinks[@]}"; do
		local link_name="${entry%%|*}"
		local target="${entry##*|}"
		local status
		local actual_target=""

		# Shorten paths for display
		local display_link="${link_name/#$HOME/~}"

		if [[ -L "$link_name" ]]; then
			actual_target="$(readlink "$link_name")"
			if [[ "$actual_target" == "$target" ]]; then
				status="OK"
			else
				status="WRONG"
			fi
		elif [[ -e "$link_name" ]]; then
			status="EXISTS"
			actual_target="(not a symlink)"
		else
			status="MISSING"
			actual_target="-"
		fi

		# Color the status
		case $status in
		OK) printf "%-50s \033[0;32m%-10s\033[0m %s\n" "$display_link" "$status" "${actual_target/#$DOTFILES/\$DOTFILES}" ;;
		WRONG) printf "%-50s \033[0;33m%-10s\033[0m %s\n" "$display_link" "$status" "${actual_target/#$HOME/~}" ;;
		EXISTS) printf "%-50s \033[0;33m%-10s\033[0m %s\n" "$display_link" "$status" "$actual_target" ;;
		MISSING) printf "%-50s \033[0;31m%-10s\033[0m %s\n" "$display_link" "$status" "$actual_target" ;;
		esac
	done
	echo ""
}

machine_status_path_is_safe() {
	local path="$1"
	[[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* ]]
}

machine_status_requirement() {
	local link_name="$1"
	if [[ "$link_name" == "$HOME/.tmux.conf" ]]; then
		printf 'optional\n'
	else
		printf 'required\n'
	fi
}

emit_machine_status_record() {
	local scope="$1"
	local entry="$2"
	local link_name="${entry%%|*}"
	local target="${entry##*|}"
	local requirement actual_target object status
	local readlink_sentinel='__dotfiles_machine_status_readlink_eof_7f3d2c9a__'
	local actual_target_with_sentinel

	requirement="$(machine_status_requirement "$link_name")"
	if ! machine_status_path_is_safe "$link_name" || ! machine_status_path_is_safe "$target"; then
		echo "Cannot represent managed symlink path safely: $link_name" >&2
		return 1
	fi
	if [[ "$scope" != "common" && "$scope" != "$PROFILE" ]]; then
		printf 'DOTFILES_SYMLINK_RECORD\toptional\t%s\t%s\t%s\t-\tnot-applicable\tnot-applicable\n' \
			"$scope" "$link_name" "$target"
		return 0
	fi

	if [[ -L "$link_name" ]]; then
		if ! actual_target_with_sentinel="$(readlink -n "$link_name" 2>/dev/null && printf '%s' "$readlink_sentinel")"; then
			echo "Cannot read managed symlink target safely: $link_name" >&2
			return 1
		fi
		if [[ "$actual_target_with_sentinel" != *"$readlink_sentinel" ]]; then
			echo "Cannot read managed symlink target safely: $link_name" >&2
			return 1
		fi
		actual_target="${actual_target_with_sentinel%"$readlink_sentinel"}"
		if ! machine_status_path_is_safe "$actual_target"; then
			echo "Cannot represent managed symlink target safely: $link_name" >&2
			return 1
		fi
		object="symlink"
		if [[ ! -e "$link_name" ]]; then
			status="dangling"
		elif [[ "$actual_target" != "$target" ]]; then
			status="wrong-target"
		elif [[ ! -e "$target" ]]; then
			status="dangling"
		else
			status="ok"
		fi
	elif [[ -e "$link_name" ]]; then
		actual_target="-"
		object="$(object_type "$link_name")"
		status="nonlink"
	else
		actual_target="-"
		object="missing"
		status="missing"
	fi

	printf 'DOTFILES_SYMLINK_RECORD\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
		"$requirement" "$scope" "$link_name" "$target" "$actual_target" "$object" "$status"
}

show_machine_status() {
	local records
	local entry
	records=$(( ${#common_symlinks[@]} + ${#desktop_symlinks[@]} + ${#server_symlinks[@]} ))
	printf 'DOTFILES_SYMLINK_STATUS version=1 profile=%s records=%s\n' "$PROFILE" "$records"
	for entry in "${common_symlinks[@]}"; do
		emit_machine_status_record common "$entry" || return 1
	done
	for entry in "${desktop_symlinks[@]}"; do
		emit_machine_status_record desktop "$entry" || return 1
	done
	for entry in "${server_symlinks[@]}"; do
		emit_machine_status_record server "$entry" || return 1
	done
}

# Run symlink creation
run_symlink_creation() {
	log "$INFO" "Creating symlinks..."
	if $DRY_RUN; then
		log "$WARNING" "DRY-RUN mode - no changes will be made"
	fi
	echo ""

	for entry in "${symlinks[@]}"; do
		local link_name="${entry%%|*}"
		local target="${entry##*|}"
		create_symlink "$target" "$link_name"
	done

	# Generate gh hosts.yml from personal fragment if not already present
	# Work install.sh will replace this with a merged version on work machines
	local gh_personal="$DOTFILES/config/gh/hosts.yml.personal"
	local gh_hosts="$DOTFILES/config/gh/hosts.yml"
	if [[ -f "$gh_personal" && ! -e "$gh_hosts" ]]; then
		if $DRY_RUN; then
			log "$INFO" "[DRY-RUN] Would generate: config/gh/hosts.yml (from personal fragment)"
		else
			cp "$gh_personal" "$gh_hosts"
			log "$INFO" "Generated: config/gh/hosts.yml (from personal fragment)"
		fi
	fi

	echo ""
	if $DRY_RUN; then
		log "$INFO" "Dry run complete. Run without --dry-run to apply changes."
	else
		log "$INFO" "Symlink creation complete."
	fi
}

# Run symlink removal
run_symlink_removal() {
	log "$INFO" "Removing symlinks..."
	if $DRY_RUN; then
		log "$WARNING" "DRY-RUN mode - no changes will be made"
	fi
	echo ""

	for entry in "${symlinks[@]}"; do
		local link_name="${entry%%|*}"
		remove_symlink "$link_name"
	done

	echo ""
	if $DRY_RUN; then
		log "$INFO" "Dry run complete. Run without --dry-run to apply changes."
	else
		log "$INFO" "Symlink removal complete."
	fi
}

# Parse arguments
if [[ $# -eq 0 ]]; then
	usage
fi

COMMAND=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	-l | --link)
		COMMAND="link"
		shift
		;;
	-u | --unlink)
		COMMAND="unlink"
		shift
		;;
	-s | --status)
		COMMAND="status"
		shift
		;;
	--machine)
		MACHINE_STATUS=true
		shift
		;;
	--restore)
		if [[ $# -lt 2 ]]; then
			log "$ERROR" "--restore requires a manifest path"
			usage
		fi
		COMMAND="restore"
		RESTORE_MANIFEST="$2"
		shift 2
		;;
	-n | --dry-run)
		DRY_RUN=true
		shift
		;;
	-f | --force)
		FORCE=true
		shift
		;;
	-h | --help)
		usage
		;;
	*)
		log "$ERROR" "Unknown option: $1"
		usage
		;;
	esac
done

if $MACHINE_STATUS && [[ "$COMMAND" != "status" ]]; then
	log "$ERROR" "--machine requires --status"
	usage
fi

if [[ "$COMMAND" == "link" || "$COMMAND" == "unlink" || "$COMMAND" == "restore" ]] && ! $DRY_RUN; then
	require_canonical_activation_checkout
fi

# Execute command
case "$COMMAND" in
link)
	run_symlink_creation
	;;
unlink)
	run_symlink_removal
	;;
status)
	if $MACHINE_STATUS; then
		show_machine_status
	else
		show_status
	fi
	;;
restore)
	restore_manifest "$RESTORE_MANIFEST"
	;;
"")
	log "$ERROR" "No command specified"
	usage
	;;
esac
