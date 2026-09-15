#!/usr/bin/env bash
# setup.sh - Unified dotfiles installer with machine profiles
#
# 7-Phase Architecture:
#   Phase 0: Preflight     (~5s)   - Validate environment, check requirements
#   Phase 1: Foundation    (~2m)   - Xcode CLT + Homebrew + repo clone
#   Phase 2: AI Rescue     (~30s)  - Native Claude Code + managed Codex CLIs
#   Phase 3: Core Tools    (~3m)   - Essential CLI (git, zsh, tmux, etc.)
#   Phase 4: Toolchain     (~5m)   - Fallback runtimes + verified Mise apply
#   Phase 5: Applications  (~10m)  - GUI apps from Brewfile
#   Phase 6: Configuration (~2m)   - Symlinks + macOS preferences
#
# Usage (fresh Mac - one-liner):
#   curl -fsSL https://raw.githubusercontent.com/nathanvale/dotfiles-private/main/setup.sh | bash
#   curl -fsSL ... | bash -s -- --server   # Headless server profile
#   curl -fsSL ... | bash -s -- --desktop  # Desktop workstation profile
#
# Usage (from repo):
#   ./setup.sh [--desktop|--server]        # Full install (phases 0-6)
#   ./setup.sh --resume                    # Resume from checkpoint
#   ./setup.sh --start-phase N             # Start from phase N
#   ./setup.sh symlinks                    # Just create symlinks
#   ./setup.sh prefs                       # Just apply macOS preferences
#   ./setup.sh status                      # Show symlink status
#   ./setup.sh verify                      # Run verify_install.sh
#   ./setup.sh --help                      # Show help
#
# Profiles:
#   --desktop  Desktop workstation with GUI apps and development tools
#   --server   Headless server with containers and local inference tools

# Wrapper function pattern ensures entire script is parsed before execution
# This is critical for curl | bash safety
main() {
    set -euo pipefail

    # Configuration
    DOTFILES_REPO="git@github.com:nathanvale/dotfiles-private.git"
    DOTFILES_REPO_HTTPS="https://github.com/nathanvale/dotfiles-private.git"
    DOTFILES_DIR="$HOME/code/dotfiles"
    STATE_DIR="$HOME/.dotfiles_state"
    LOG_FILE="$STATE_DIR/setup.log"
    SETUP_LOCK_DIR="$STATE_DIR/setup.lock"
    SETUP_LOCK_RECOVERY_DIR="$STATE_DIR/.setup-lock-recovery"
    SETUP_LOCK_HELD=false
    SETUP_LOCK_CREATING=false
    SETUP_LOCK_TRANSITIONING=false
    SETUP_LOCK_PENDING_SIGNAL=""
    SETUP_LOCK_RECOVERY_HELD=false
    SETUP_LOCK_TOKEN=""
    SETUP_LOCK_RECOVERY_TOKEN=""
    SETUP_CHILD_PID=""
    SETUP_CHILD_PGID=""
    SETUP_CHILD_TREE_PIDS=""
    SETUP_CHILD_TTY_MODE=false
    SETUP_CHILD_STARTING=false
    SETUP_PENDING_SIGNAL=""
    SETUP_STALE_RECOVERY_ALLOWED=false

    setup_script_dir="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"

    # Colors
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    RESET='\033[0m'

    state_owner_uid() {
        local owner=""
        owner="$(stat -f '%u' "$STATE_DIR" 2>/dev/null || true)"
        if [[ ! "$owner" =~ ^[0-9]+$ ]]; then
            owner="$(stat -c '%u' "$STATE_DIR" 2>/dev/null || true)"
        fi
        printf '%s\n' "$owner"
    }

    validate_state_root() {
        local owner current_uid

        if [[ -L "$STATE_DIR" ]]; then
            reject_input "State directory is a symbolic link: $STATE_DIR"
        fi
        if [[ -e "$STATE_DIR" && ! -d "$STATE_DIR" ]]; then
            reject_input "State path is not a directory: $STATE_DIR"
        fi
        [[ -d "$STATE_DIR" ]] || return 0

        owner="$(state_owner_uid)"
        current_uid="$(id -u)"
        [[ "$owner" == "$current_uid" ]] ||
            reject_input "State directory is not owned by the current user: $STATE_DIR"
    }

    ensure_state_dir() {
        validate_state_root
        if [[ ! -e "$STATE_DIR" && ! -L "$STATE_DIR" ]]; then
            if ! mkdir -m 700 "$STATE_DIR" 2>/dev/null &&
                [[ ! -d "$STATE_DIR" || -L "$STATE_DIR" ]]; then
                printf '%s\n' "ERROR: Could not create the state directory: $STATE_DIR" >&2
                return 73
            fi
        fi
        validate_state_root
    }

    state_file_is_safe() {
        local file="$1"
        [[ ! -L "$file" && ( ! -e "$file" || -f "$file" ) ]]
    }

    atomic_publish_file() {
        local destination="$1"
        local temporary_file="$STATE_DIR/.setup-write-$$-$RANDOM"

        state_file_is_safe "$destination" || {
            printf '%s\n' "ERROR: State file is not a safe regular file: $destination" >&2
            return 73
        }
        if ! (umask 077; set -o noclobber; cat >"$temporary_file") 2>/dev/null; then
            printf '%s\n' "ERROR: Could not stage state publication: $destination" >&2
            return 73
        fi
        chmod 600 "$temporary_file" || return 73
        mv -f "$temporary_file" "$destination" || {
            printf '%s\n' "ERROR: Could not publish state file: $destination" >&2
            return 73
        }
        chmod 600 "$destination" || return 73
    }

    atomic_write_state_text() {
        local destination="$1"
        local content="$2"
        printf '%s\n' "$content" | atomic_publish_file "$destination"
    }

    atomic_append_history() {
        local destination="$STATE_DIR/history"
        local temporary_file="$STATE_DIR/.setup-history-$$-$RANDOM"

        state_file_is_safe "$destination" || {
            printf '%s\n' "ERROR: History file is not a safe regular file: $destination" >&2
            return 73
        }
        if ! (umask 077; set -o noclobber; : >"$temporary_file") 2>/dev/null; then
            printf '%s\n' "ERROR: Could not stage history publication" >&2
            return 73
        fi
        if [[ -f "$destination" ]] && ! cat "$destination" >"$temporary_file"; then
            printf '%s\n' "ERROR: Could not copy setup history" >&2
            return 73
        fi
        printf '%s\n' "$(date -Iseconds) - Phase $1 completed" >>"$temporary_file"
        chmod 600 "$temporary_file" || return 73
        mv -f "$temporary_file" "$destination" || {
            printf '%s\n' "ERROR: Could not publish setup history" >&2
            return 73
        }
        chmod 600 "$destination" || return 73
    }

    reject_input() {
        printf '%s\n' "ERROR: $1" >&2
        exit 2
    }

    # ========================================================================
    # Logging functions
    # ========================================================================
    log() {
        ensure_state_dir
        local msg="[$(date +%H:%M:%S)] $1"
        echo -e "${GREEN}$msg${RESET}"
        echo "$msg" >> "$LOG_FILE"
    }

    log_warn() {
        ensure_state_dir
        local msg="[$(date +%H:%M:%S)] WARNING: $1"
        echo -e "${YELLOW}$msg${RESET}"
        echo "$msg" >> "$LOG_FILE"
    }

    log_error() {
        ensure_state_dir
        local msg="[$(date +%H:%M:%S)] ERROR: $1"
        echo -e "${RED}$msg${RESET}"
        echo "$msg" >> "$LOG_FILE"
    }

    log_phase() {
        ensure_state_dir
        local msg="=== PHASE $1: $2 ==="
        echo -e "\n${CYAN}$msg${RESET}\n"
        echo "" >> "$LOG_FILE"
        echo "$msg" >> "$LOG_FILE"
    }

    log_section() {
        echo -e "\n${BLUE}==> $1${RESET}\n"
    }

    lock_dir_contains_only_owner() {
        local lock_dir="$1" owner="$2" entry count=0
        for entry in "$lock_dir"/* "$lock_dir"/.[!.]* "$lock_dir"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            [[ "$entry" == "$owner" ]] || return 1
            count=$((count + 1))
        done
        [[ "$count" -eq 1 ]]
    }

    lock_dir_is_empty() {
        local lock_dir="$1" entry
        for entry in "$lock_dir"/* "$lock_dir"/.[!.]* "$lock_dir"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            return 1
        done
        return 0
    }

    setup_lock_dir_contains_only_owner() {
        lock_dir_contains_only_owner "$SETUP_LOCK_DIR" "$1"
    }

    process_start_identity() {
        local pid="$1" identity=""

        if [[ -r "/proc/$pid/stat" ]]; then
            identity="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"
        fi
        if [[ -z "$identity" ]]; then
            identity="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' || true)"
        fi
        [[ -n "$identity" ]] || return 1
        printf '%s\n' "$identity"
    }

    read_setup_lock_record() {
        local lock_dir="$1"
        local owner_file="$lock_dir/owner"
        local pid token profile started start_identity extra

        SETUP_RECORD_PID=""
        SETUP_RECORD_TOKEN=""
        SETUP_RECORD_START_IDENTITY=""
        [[ -d "$lock_dir" && ! -L "$lock_dir" ]] || return 1
        [[ -f "$owner_file" && ! -L "$owner_file" ]] || return 1
        [[ "$(wc -l <"$owner_file" | tr -d ' ')" == 1 ]] || return 1
        IFS='|' read -r pid token profile started start_identity extra <"$owner_file"
        [[ -z "${extra:-}" ]] || return 1
        [[ "$pid" =~ ^[0-9]+$ && "$token" =~ ^[A-Za-z0-9-]+$ ]] || return 1
        [[ "$profile" == desktop || "$profile" == server ]] || return 1
        [[ "$started" =~ ^[0-9]+$ ]] || return 1
        if [[ -n "${start_identity:-}" ]]; then
            [[ "$start_identity" != *'|'* && "$start_identity" != *$'\n'* ]] || return 1
        fi
        SETUP_RECORD_PID="$pid"
        SETUP_RECORD_TOKEN="$token"
        SETUP_RECORD_START_IDENTITY="${start_identity:-}"
    }

    setup_owner_process_is_live() {
        local current_identity=""

        kill -0 "$SETUP_RECORD_PID" 2>/dev/null || return 1
        [[ -n "$SETUP_RECORD_START_IDENTITY" ]] || return 0
        current_identity="$(process_start_identity "$SETUP_RECORD_PID" 2>/dev/null || true)"
        [[ -z "$current_identity" || "$current_identity" == "$SETUP_RECORD_START_IDENTITY" ]]
    }

    recovery_marker_validate() {
        local marker_dir="$1"
        local marker_token="${marker_dir##*/}"
        local owner_file="$marker_dir/owner"

        SETUP_RECOVERY_INVALID_REASON="invalid marker"
        [[ -d "$marker_dir" && ! -L "$marker_dir" ]] || {
            SETUP_RECOVERY_INVALID_REASON="unexpected files"
            return 73
        }
        [[ "$marker_token" =~ ^recovery-[0-9]+-[0-9]+-[0-9]+-[0-9]+$ ]] || {
            SETUP_RECOVERY_INVALID_REASON="unexpected files"
            return 73
        }

        # An empty token directory is the safe residue left when a stale
        # owner was removed immediately before a reclaiming process stopped.
        # It is valid only as a reclaimable marker; every other non-owner
        # entry remains fail-closed state.
        if lock_dir_is_empty "$marker_dir"; then
            return 0
        fi
        lock_dir_contains_only_owner "$marker_dir" "$owner_file" || {
            SETUP_RECOVERY_INVALID_REASON="unexpected files"
            return 73
        }
        read_setup_lock_record "$marker_dir" || {
            SETUP_RECOVERY_INVALID_REASON="without a valid owner record"
            return 73
        }
        [[ "$SETUP_RECORD_TOKEN" == "$marker_token" ]] || {
            SETUP_RECOVERY_INVALID_REASON="marker token does not match its owner record"
            return 73
        }
    }

    recovery_markers_validate_all() {
        local entry

        SETUP_RECOVERY_MARKER_COUNT=0
        [[ -d "$SETUP_LOCK_RECOVERY_DIR" && ! -L "$SETUP_LOCK_RECOVERY_DIR" ]] || return 73
        for entry in "$SETUP_LOCK_RECOVERY_DIR"/* "$SETUP_LOCK_RECOVERY_DIR"/.[!.]* "$SETUP_LOCK_RECOVERY_DIR"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            recovery_marker_validate "$entry" || return 73
            SETUP_RECOVERY_MARKER_COUNT=$((SETUP_RECOVERY_MARKER_COUNT + 1))
        done
    }

    recovery_marker_remove_own() {
        local marker_dir="$SETUP_LOCK_RECOVERY_DIR/$SETUP_LOCK_RECOVERY_TOKEN"
        local owner_file="$marker_dir/owner"

        [[ ! -e "$marker_dir" && ! -L "$marker_dir" ]] && return 0
        recovery_marker_validate "$marker_dir" || return 73
        if ! lock_dir_is_empty "$marker_dir"; then
            read_setup_lock_record "$marker_dir" || return 73
            [[ "$SETUP_RECORD_PID" == "$$" &&
                "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_RECOVERY_TOKEN" ]] || return 75
            lock_dir_contains_only_owner "$marker_dir" "$owner_file" || return 73
            rm -f "$owner_file" || {
                [[ ! -e "$owner_file" && ! -L "$owner_file" ]] || return 75
            }
        fi
        rmdir "$marker_dir" 2>/dev/null || {
            [[ ! -e "$marker_dir" && ! -L "$marker_dir" ]] || return 75
        }
        rmdir "$SETUP_LOCK_RECOVERY_DIR" 2>/dev/null || true
    }

    recovery_markers_reclaim_dead() {
        local entry owner_file

        recovery_markers_validate_all || return 73

        # Validate and observe every marker before removing any one of them.
        # This lets several dead markers converge while a live owner keeps
        # the whole recovery operation busy.
        for entry in "$SETUP_LOCK_RECOVERY_DIR"/* "$SETUP_LOCK_RECOVERY_DIR"/.[!.]* "$SETUP_LOCK_RECOVERY_DIR"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            recovery_marker_validate "$entry" || return 73
            lock_dir_is_empty "$entry" && continue
            read_setup_lock_record "$entry" || return 73
            if setup_owner_process_is_live; then
                return 75
            fi
        done

        # Recheck each keyed path immediately before its idempotent cleanup so
        # a dead owner cannot be replaced by a live record in the same marker.
        for entry in "$SETUP_LOCK_RECOVERY_DIR"/* "$SETUP_LOCK_RECOVERY_DIR"/.[!.]* "$SETUP_LOCK_RECOVERY_DIR"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            recovery_marker_validate "$entry" || return 73
            if lock_dir_is_empty "$entry"; then
                rmdir "$entry" 2>/dev/null || {
                    [[ ! -e "$entry" && ! -L "$entry" ]] || return 75
                }
                continue
            fi
            owner_file="$entry/owner"
            read_setup_lock_record "$entry" || return 73
            setup_owner_process_is_live && return 75
            lock_dir_contains_only_owner "$entry" "$owner_file" || return 73
            rm -f "$owner_file" || {
                [[ ! -e "$owner_file" && ! -L "$owner_file" ]] || return 75
            }
            rmdir "$entry" 2>/dev/null || {
                [[ ! -e "$entry" && ! -L "$entry" ]] || return 75
            }
        done

        # Removing the shared root is conditional on it remaining empty; a
        # concurrent publisher owns only its own token directory.
        rmdir "$SETUP_LOCK_RECOVERY_DIR" 2>/dev/null || true
    }

    release_setup_lock_recovery() {
        local marker_dir="$SETUP_LOCK_RECOVERY_DIR/$SETUP_LOCK_RECOVERY_TOKEN"
        local owner_file="$marker_dir/owner"

        [[ "$SETUP_LOCK_RECOVERY_HELD" == true ]] || return 0
        if [[ -d "$marker_dir" && ! -L "$marker_dir" ]]; then
            if read_setup_lock_record "$marker_dir" &&
                [[ "$SETUP_RECORD_PID" == "$$" &&
                    "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_RECOVERY_TOKEN" ]] &&
                lock_dir_contains_only_owner "$marker_dir" "$owner_file"; then
                rm -f "$owner_file"
                rmdir "$marker_dir" 2>/dev/null || true
                rmdir "$SETUP_LOCK_RECOVERY_DIR" 2>/dev/null || true
            fi
        fi
        SETUP_LOCK_RECOVERY_HELD=false
    }

    release_setup_lock() {
        local owner_file="$SETUP_LOCK_DIR/owner"

        if [[ "$SETUP_LOCK_CREATING" == true ]]; then
            if read_setup_lock_record "$SETUP_LOCK_DIR" &&
                [[ "$SETUP_RECORD_PID" == "$$" && "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_TOKEN" ]] &&
                setup_lock_dir_contains_only_owner "$owner_file"; then
                rm -f "$owner_file"
            fi
            if [[ -d "$SETUP_LOCK_DIR" && ! -L "$SETUP_LOCK_DIR" ]]; then
                rmdir "$SETUP_LOCK_DIR" 2>/dev/null || true
            fi
            SETUP_LOCK_CREATING=false
        fi

        if [[ "$SETUP_LOCK_HELD" == true ]]; then
            if read_setup_lock_record "$SETUP_LOCK_DIR" &&
                [[ "$SETUP_RECORD_PID" == "$$" && "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_TOKEN" ]] &&
                setup_lock_dir_contains_only_owner "$owner_file"; then
                rm -f "$owner_file"
                rmdir "$SETUP_LOCK_DIR" 2>/dev/null || true
            fi
            SETUP_LOCK_HELD=false
        fi
        release_setup_lock_recovery
    }

    setup_write_lock_owner() {
        local owner_file="$SETUP_LOCK_DIR/owner"
        local temporary_owner="$SETUP_LOCK_DIR/.owner-$$-$RANDOM"
        local profile="${DOTFILES_PROFILE:-desktop}"
        local start_identity

        start_identity="$(process_start_identity "$$" 2>/dev/null || true)"
        [[ -n "$start_identity" ]] || {
            printf '%s\n' "ERROR: Could not determine setup process start identity" >&2
            return 73
        }

        if ! (umask 077; set -o noclobber; printf '%s|%s|%s|%s\n' \
            "$$" "$SETUP_LOCK_TOKEN" "$profile" "$(date +%s)|$start_identity" \
            >"$temporary_owner") 2>/dev/null; then
            printf '%s\n' "ERROR: Could not publish setup lock ownership" >&2
            return 73
        fi
        chmod 600 "$temporary_owner" || return 73
        mv -f "$temporary_owner" "$owner_file" || {
            printf '%s\n' "ERROR: Could not publish setup lock ownership" >&2
            return 73
        }
        chmod 600 "$owner_file" || return 73
        read_setup_lock_record "$SETUP_LOCK_DIR" || {
            printf '%s\n' "ERROR: Setup lock ownership record is invalid" >&2
            return 73
        }
        [[ "$SETUP_RECORD_PID" == "$$" && "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_TOKEN" ]] || {
            printf '%s\n' "ERROR: Setup lock ownership record changed during publication" >&2
            return 73
        }
    }

    setup_write_recovery_owner() {
        local marker_dir="$SETUP_LOCK_RECOVERY_DIR/$SETUP_LOCK_RECOVERY_TOKEN"
        local claim_dir="$STATE_DIR/.setup-recovery-claim-$$-$RANDOM"
        local owner_file="$claim_dir/owner"
        local profile="${DOTFILES_PROFILE:-desktop}"
        local start_identity

        [[ -d "$SETUP_LOCK_RECOVERY_DIR" && ! -L "$SETUP_LOCK_RECOVERY_DIR" ]] || return 75
        [[ ! -e "$marker_dir" && ! -L "$marker_dir" ]] || return 75
        while [[ -e "$claim_dir" || -L "$claim_dir" ]]; do
            claim_dir="$STATE_DIR/.setup-recovery-claim-$$-$RANDOM"
        done
        if ! (umask 077; mkdir -m 700 "$claim_dir") 2>/dev/null; then
            printf '%s\n' "ERROR: Could not stage setup recovery ownership" >&2
            return 73
        fi
        start_identity="$(process_start_identity "$$" 2>/dev/null || true)"
        [[ -n "$start_identity" ]] || {
            rmdir "$claim_dir" 2>/dev/null || true
            printf '%s\n' "ERROR: Could not determine recovery process start identity" >&2
            return 73
        }
        if ! (umask 077; set -o noclobber; printf '%s|%s|%s|%s|%s\n' \
            "$$" "$SETUP_LOCK_RECOVERY_TOKEN" "$profile" "$(date +%s)" \
            "$start_identity" >"$owner_file") 2>/dev/null; then
            rm -f "$owner_file" 2>/dev/null || true
            rmdir "$claim_dir" 2>/dev/null || true
            return 73
        fi
        chmod 600 "$owner_file" || {
            rm -f "$owner_file" 2>/dev/null || true
            rmdir "$claim_dir" 2>/dev/null || true
            return 73
        }
        [[ ! -e "$marker_dir" && ! -L "$marker_dir" ]] || {
            rm -f "$owner_file" 2>/dev/null || true
            rmdir "$claim_dir" 2>/dev/null || true
            return 75
        }
        if ! mv "$claim_dir" "$marker_dir" 2>/dev/null; then
            rmdir "$claim_dir" 2>/dev/null || true
            return 75
        fi
        recovery_marker_validate "$marker_dir" || return 73
        read_setup_lock_record "$marker_dir" || return 73
        [[ "$SETUP_RECORD_PID" == "$$" &&
            "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_RECOVERY_TOKEN" ]] || return 75
    }

    acquire_setup_lock_recovery() {
        local recovery_attempt=0
        local recovery_attempt_limit=40
        local recovery_status=0
        local created_root=false
        local marker_dir=""

        SETUP_LOCK_RECOVERY_TOKEN=""
        SETUP_LOCK_RECOVERY_HELD=false
        while [[ "$recovery_attempt" -lt "$recovery_attempt_limit" ]]; do
            recovery_attempt=$((recovery_attempt + 1))
            created_root=false
            if [[ -L "$SETUP_LOCK_RECOVERY_DIR" ||
                ( -e "$SETUP_LOCK_RECOVERY_DIR" && ! -d "$SETUP_LOCK_RECOVERY_DIR" ) ]]; then
                printf '%s\n' \
                    "ERROR: Setup recovery path is not a safe directory: $SETUP_LOCK_RECOVERY_DIR" >&2
                return 73
            fi
            if [[ ! -e "$SETUP_LOCK_RECOVERY_DIR" ]]; then
                if ! mkdir -m 700 "$SETUP_LOCK_RECOVERY_DIR" 2>/dev/null; then
                    if [[ -d "$SETUP_LOCK_RECOVERY_DIR" && ! -L "$SETUP_LOCK_RECOVERY_DIR" ]]; then
                        continue
                    fi
                    printf '%s\n' \
                        "ERROR: Could not create the setup recovery path: $SETUP_LOCK_RECOVERY_DIR" >&2
                    return 73
                fi
                created_root=true
            fi

            recovery_markers_validate_all || {
                printf '%s\n' \
                    "ERROR: Setup recovery contains ${SETUP_RECOVERY_INVALID_REASON:-an invalid marker}; refusing to remove it: $SETUP_LOCK_RECOVERY_DIR" >&2
                return 73
            }
            if [[ "$SETUP_RECOVERY_MARKER_COUNT" -gt 0 ]]; then
                recovery_status=0
                recovery_markers_reclaim_dead || recovery_status=$?
                if [[ "$recovery_status" -eq 75 ]]; then
                    printf '%s\n' \
                        "ERROR: Setup recovery is busy; already running: PID $SETUP_RECORD_PID token $SETUP_RECORD_TOKEN." >&2
                    return 75
                fi
                [[ "$recovery_status" -eq 0 ]] || return "$recovery_status"
                # A dead or ownerless marker may have left an empty root. Its
                # removal is conditional, and the next attempt recreates it.
                rmdir "$SETUP_LOCK_RECOVERY_DIR" 2>/dev/null || true
                sleep 0.01
                continue
            fi

            # An existing empty root is an interrupted pre-publication claim.
            # Remove it conditionally and retry, while a root created by this
            # attempt can be used for our atomic token-directory publication.
            if [[ "$created_root" != true ]]; then
                rmdir "$SETUP_LOCK_RECOVERY_DIR" 2>/dev/null || true
                sleep 0.01
                continue
            fi

            # Every publication attempt gets a fresh keyed name. A delayed
            # cleanup of an older contender can therefore never target a
            # later retry's marker path.
            SETUP_LOCK_RECOVERY_TOKEN="recovery-$$-$(date +%s)-$recovery_attempt-$RANDOM"
            recovery_status=0
            setup_write_recovery_owner || recovery_status=$?
            if [[ "$recovery_status" -eq 0 ]]; then
                marker_dir="$SETUP_LOCK_RECOVERY_DIR/$SETUP_LOCK_RECOVERY_TOKEN"
                recovery_markers_validate_all || return 73
                if [[ "$SETUP_RECOVERY_MARKER_COUNT" -eq 1 ]] &&
                    [[ -d "$marker_dir" && ! -L "$marker_dir" ]] &&
                    read_setup_lock_record "$marker_dir" &&
                    [[ "$SETUP_RECORD_PID" == "$$" &&
                        "$SETUP_RECORD_TOKEN" == "$SETUP_LOCK_RECOVERY_TOKEN" ]] &&
                    lock_dir_contains_only_owner "$marker_dir" "$marker_dir/owner"; then
                    SETUP_LOCK_RECOVERY_HELD=true
                    return 0
                fi
                # Multiple keyed publishers are transient contenders. A
                # contender removes only its own marker, then retries with a
                # bounded cap; it never quarantines or recursively removes R.
                recovery_status=0
                recovery_marker_remove_own || recovery_status=$?
                [[ "$recovery_status" -eq 0 ]] || return "$recovery_status"
                sleep 0.01
                continue
            fi
            [[ "$recovery_status" -eq 75 ]] && {
                sleep 0.01
                continue
            }
            return "$recovery_status"
        done
        printf '%s\n' "ERROR: Setup recovery remained busy during bounded claim retries: $SETUP_LOCK_RECOVERY_DIR" >&2
        return 75
    }

    recover_stale_setup_lock() {
        local stale_pid="$1"
        local stale_token="$2"
        local stale_start_identity="${3:-}"
        local stale_dir="$STATE_DIR/.setup-lock-stale-$stale_token"
        local owner_file="$SETUP_LOCK_DIR/owner"
        local stale_owner="$stale_dir/owner"

        local recovery_status=0
        acquire_setup_lock_recovery || {
            recovery_status=$?
            printf '%s\n' "ERROR: Setup lock recovery is busy or unsafe; retry after the active recovery finishes." >&2
            return "$recovery_status"
        }

        if ! read_setup_lock_record "$SETUP_LOCK_DIR" ||
            [[ "$SETUP_RECORD_PID" != "$stale_pid" ||
                "$SETUP_RECORD_TOKEN" != "$stale_token" ||
                "$SETUP_RECORD_START_IDENTITY" != "$stale_start_identity" ]]; then
            printf '%s\n' "ERROR: Setup lock changed while stale recovery was being prepared; retry." >&2
            release_setup_lock_recovery
            return 75
        fi
        if setup_owner_process_is_live; then
            printf '%s\n' "ERROR: Setup is busy; already running: PID $SETUP_RECORD_PID token $SETUP_RECORD_TOKEN." >&2
            release_setup_lock_recovery
            return 75
        fi
        if [[ -e "$stale_dir" || -L "$stale_dir" ]]; then
            printf '%s\n' "ERROR: Stale setup lock quarantine already exists: $stale_dir" >&2
            release_setup_lock_recovery
            return 73
        fi
        if ! read_setup_lock_record "$SETUP_LOCK_DIR" ||
            [[ "$SETUP_RECORD_PID" != "$stale_pid" ||
                "$SETUP_RECORD_TOKEN" != "$stale_token" ||
                "$SETUP_RECORD_START_IDENTITY" != "$stale_start_identity" ]]; then
            printf '%s\n' "ERROR: Setup lock changed before stale recovery quarantine; retry." >&2
            release_setup_lock_recovery
            return 75
        fi
        if setup_owner_process_is_live; then
            printf '%s\n' "ERROR: Setup is busy; already running: PID $SETUP_RECORD_PID token $SETUP_RECORD_TOKEN." >&2
            release_setup_lock_recovery
            return 75
        fi
        setup_lock_dir_contains_only_owner "$owner_file" || {
            printf '%s\n' "ERROR: Setup lock contains unexpected files; refusing stale recovery." >&2
            release_setup_lock_recovery
            return 73
        }
        mv "$SETUP_LOCK_DIR" "$stale_dir" || {
            printf '%s\n' "ERROR: Could not quarantine the stale setup lock; retry." >&2
            release_setup_lock_recovery
            return 73
        }
        [[ -f "$stale_owner" && ! -L "$stale_owner" ]] || {
            printf '%s\n' "ERROR: Stale setup lock quarantine is unsafe: $stale_dir" >&2
            release_setup_lock_recovery
            return 73
        }
        if ! read_setup_lock_record "$stale_dir" ||
            [[ "$SETUP_RECORD_PID" != "$stale_pid" ||
                "$SETUP_RECORD_TOKEN" != "$stale_token" ||
                "$SETUP_RECORD_START_IDENTITY" != "$stale_start_identity" ]]; then
            printf '%s\n' "ERROR: Stale setup lock quarantine changed; refusing recovery." >&2
            release_setup_lock_recovery
            return 73
        fi
        if setup_owner_process_is_live; then
            printf '%s\n' "ERROR: Setup became busy during stale recovery; refusing quarantine removal." >&2
            release_setup_lock_recovery
            return 75
        fi
        rm -f "$stale_owner"
        rmdir "$stale_dir" 2>/dev/null || {
            printf '%s\n' "ERROR: Could not finish stale setup lock recovery: $stale_dir" >&2
            release_setup_lock_recovery
            return 73
        }
        printf '%s\n' "WARNING: Recovered stale setup lock from dead PID $stale_pid (token $stale_token)."
        release_setup_lock_recovery
    }

    setup_on_signal() {
        local signal="$1"
        local status=1
        [[ "$signal" == INT ]] && status=130
        [[ "$signal" == TERM ]] && status=143
        if [[ "$SETUP_LOCK_TRANSITIONING" == true ]]; then
            SETUP_LOCK_PENDING_SIGNAL="$signal"
            return 0
        fi
        if [[ "$SETUP_CHILD_STARTING" == true ]]; then
            SETUP_PENDING_SIGNAL="$signal"
            return 0
        fi
        trap - EXIT INT TERM
        retire_setup_child "$signal"
        release_sudo || true
        release_setup_lock || true
        exit "$status"
    }

    finish_setup_lock_transition() {
        local pending_signal="$SETUP_LOCK_PENDING_SIGNAL"
        local result="${1:-0}"

        SETUP_LOCK_PENDING_SIGNAL=""
        SETUP_LOCK_TRANSITIONING=false
        if [[ -n "$pending_signal" ]]; then
            setup_on_signal "$pending_signal"
        fi
        return "$result"
    }

    setup_on_exit() {
        local status=$?
        trap - EXIT
        release_sudo || true
        release_setup_lock || true
        exit "$status"
    }

    run_setup_child() {
        local status observed_pgid="" pending_signal=""
        SETUP_PENDING_SIGNAL=""
        SETUP_CHILD_TREE_PIDS=""
        SETUP_CHILD_STARTING=true
        # Bash assigns /dev/null to fd 0 for asynchronous commands when job
        # control is disabled. Duplicate the caller's stdin first so both tty
        # and piped collaborators receive the exact original input stream.
        exec 9<&0
        if [[ -t 0 ]]; then
            # A non-interactive bash can create a process group, but it cannot
            # transfer the terminal foreground group to that job. Keep an
            # interactive child in the caller's group so it can read the tty;
            # signal cleanup walks only this child's process tree.
            SETUP_CHILD_TTY_MODE=true
            (
                exec "$@" <&9 9<&-
            ) &
        else
            SETUP_CHILD_TTY_MODE=false
            set -m
            (
                exec "$@" <&9 9<&-
            ) &
            set +m
        fi
        exec 9<&-
        SETUP_CHILD_PID=$!
        if [[ "$SETUP_CHILD_TTY_MODE" == false ]]; then
            SETUP_CHILD_PGID="$SETUP_CHILD_PID"
            observed_pgid="$(ps -o pgid= -p "$SETUP_CHILD_PID" 2>/dev/null | tr -d ' ' || true)"
        else
            SETUP_CHILD_PGID=""
        fi
        SETUP_CHILD_STARTING=false
        pending_signal="$SETUP_PENDING_SIGNAL"
        SETUP_PENDING_SIGNAL=""
        if [[ -n "$pending_signal" ]]; then
            setup_on_signal "$pending_signal"
        fi
        if [[ "$observed_pgid" != "$SETUP_CHILD_PGID" ]]; then
            if [[ -z "$observed_pgid" ]]; then
                # A quick child may have exited between launch and `ps`. Keep
                # the process-group contract when descendants are still live;
                # otherwise let wait report the completed child's real status.
                if ! setup_child_scope_live; then
                    SETUP_CHILD_PGID=""
                fi
            else
                printf '%s\n' "ERROR: Could not isolate setup child process group" >&2
                retire_setup_child TERM
                return 73
            fi
        fi
        if wait "$SETUP_CHILD_PID"; then
            status=0
        else
            status=$?
        fi
        if setup_child_scope_live; then
            retire_setup_child TERM
            [[ "$status" -eq 0 ]] && status=73
        else
            SETUP_CHILD_PID=""
            SETUP_CHILD_PGID=""
            SETUP_CHILD_TREE_PIDS=""
        fi
        return "$status"
    }

    setup_child_tree_pids() {
        local parent="$1" child
        while IFS= read -r child; do
            [[ "$child" =~ ^[0-9]+$ ]] || continue
            setup_child_tree_pids "$child"
            printf '%s\n' "$child"
        done < <(ps -axo pid=,ppid= 2>/dev/null | awk -v parent="$parent" '$2 == parent { print $1 }')
    }

    setup_child_scope_live() {
        if [[ -n "$SETUP_CHILD_PGID" ]]; then
            kill -0 -- "-$SETUP_CHILD_PGID" 2>/dev/null
        else
            local pid
            if [[ -n "$SETUP_CHILD_PID" ]] && kill -0 "$SETUP_CHILD_PID" 2>/dev/null; then
                return 0
            fi
            while IFS= read -r pid; do
                [[ "$pid" =~ ^[0-9]+$ ]] || continue
                kill -0 "$pid" 2>/dev/null && return 0
            done <<<"$SETUP_CHILD_TREE_PIDS"
            return 1
        fi
    }

    signal_setup_child_scope() {
        local signal="$1"
        local pid

        if [[ -n "$SETUP_CHILD_PGID" ]]; then
            kill -"$signal" -- "-$SETUP_CHILD_PGID" 2>/dev/null || true
        elif [[ -n "$SETUP_CHILD_PID" ]]; then
            while IFS= read -r pid; do
                [[ "$pid" =~ ^[0-9]+$ ]] || continue
                kill -"$signal" "$pid" 2>/dev/null || true
            done <<<"$SETUP_CHILD_TREE_PIDS"
            kill -"$signal" "$SETUP_CHILD_PID" 2>/dev/null || true
        fi
    }

    retire_setup_child() {
        local signal="$1"
        local attempt=0

        if [[ -z "$SETUP_CHILD_PGID" && -n "$SETUP_CHILD_PID" ]]; then
            SETUP_CHILD_TREE_PIDS="$(setup_child_tree_pids "$SETUP_CHILD_PID")"
        fi
        signal_setup_child_scope "$signal"
        while setup_child_scope_live && [[ "$attempt" -lt 20 ]]; do
            sleep 0.01
            attempt=$((attempt + 1))
        done
        if setup_child_scope_live; then
            signal_setup_child_scope TERM
        fi
        attempt=0
        while setup_child_scope_live && [[ "$attempt" -lt 20 ]]; do
            sleep 0.01
            attempt=$((attempt + 1))
        done
        if setup_child_scope_live; then
            signal_setup_child_scope KILL
        fi
        [[ -z "$SETUP_CHILD_PID" ]] || wait "$SETUP_CHILD_PID" 2>/dev/null || true
        SETUP_CHILD_PID=""
        SETUP_CHILD_PGID=""
        SETUP_CHILD_TREE_PIDS=""
    }

    acquire_setup_lock() {
        local lock_owner_pid lock_owner_token

        ensure_state_dir
        SETUP_LOCK_TOKEN="setup-$$-$(date +%s)-$RANDOM"
        SETUP_LOCK_PENDING_SIGNAL=""
        trap 'setup_on_exit' EXIT
        trap 'setup_on_signal INT' INT
        trap 'setup_on_signal TERM' TERM
        SETUP_LOCK_TRANSITIONING=true

        if [[ -L "$SETUP_LOCK_DIR" || ( -e "$SETUP_LOCK_DIR" && ! -d "$SETUP_LOCK_DIR" ) ]]; then
            printf '%s\n' "ERROR: Setup lock path is not a safe directory: $SETUP_LOCK_DIR" >&2
            finish_setup_lock_transition 73
            return $?
        fi
        if mkdir -m 700 "$SETUP_LOCK_DIR" 2>/dev/null; then
            SETUP_LOCK_CREATING=true
            if ! setup_write_lock_owner; then
                release_setup_lock
                finish_setup_lock_transition 73
                return $?
            fi
            SETUP_LOCK_CREATING=false
            SETUP_LOCK_HELD=true
            finish_setup_lock_transition 0
            return $?
        fi

        read_setup_lock_record "$SETUP_LOCK_DIR" || {
            printf '%s\n' \
                "ERROR: Setup lock exists without a valid owner record; refusing to remove it: $SETUP_LOCK_DIR" >&2
            finish_setup_lock_transition 73
            return $?
        }
        lock_owner_pid="$SETUP_RECORD_PID"
        lock_owner_token="$SETUP_RECORD_TOKEN"
        local lock_owner_start_identity="$SETUP_RECORD_START_IDENTITY"
        if setup_owner_process_is_live; then
            printf '%s\n' "ERROR: Setup is busy; already running: PID $lock_owner_pid token $lock_owner_token." >&2
            finish_setup_lock_transition 75
            return $?
        fi
        if [[ "$SETUP_STALE_RECOVERY_ALLOWED" != true ]]; then
            printf '%s\n' \
                "ERROR: Setup lock is stale (PID $lock_owner_pid token $lock_owner_token); rerun with --resume to recover it." >&2
            finish_setup_lock_transition 75
            return $?
        fi
        local recovery_status=0
        recover_stale_setup_lock "$lock_owner_pid" "$lock_owner_token" \
            "$lock_owner_start_identity" || recovery_status=$?
        if [[ "$recovery_status" -ne 0 ]]; then
            finish_setup_lock_transition "$recovery_status"
            return $?
        fi
        if mkdir -m 700 "$SETUP_LOCK_DIR" 2>/dev/null; then
            SETUP_LOCK_CREATING=true
            if ! setup_write_lock_owner; then
                release_setup_lock
                finish_setup_lock_transition 73
                return $?
            fi
            SETUP_LOCK_CREATING=false
            SETUP_LOCK_HELD=true
            finish_setup_lock_transition 0
            return $?
        fi
        printf '%s\n' "ERROR: Setup lock became busy while stale recovery completed; retry." >&2
        finish_setup_lock_transition 75
        return $?
    }

    require_canonical_activation_checkout() {
        local git_dir common_dir
        [[ -e "$setup_script_dir/.git" ]] || return 0
        git -C "$setup_script_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
        git_dir="$(git -C "$setup_script_dir" rev-parse --absolute-git-dir 2>/dev/null)" || {
            log_error "Cannot classify the activation checkout: $setup_script_dir"
            exit 1
        }
        common_dir="$(git -C "$setup_script_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
            log_error "Cannot classify the activation checkout: $setup_script_dir"
            exit 1
        }

        if [[ "$git_dir" != "$common_dir" ]]; then
            log_error "Activation from a linked worktree is blocked: $setup_script_dir"
            log_error "Review in the worktree, then activate from $DOTFILES_DIR after the change is accepted."
            exit 1
        fi
    }

    canonical_homebrew_path() {
        local candidate
        for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
            [[ -f "$candidate" && -x "$candidate" ]] || continue
            printf '%s\n' "$candidate"
            return 0
        done
        return 1
    }

    hydrate_canonical_homebrew_environment() {
        local brew_path shellenv
        brew_path="$(canonical_homebrew_path)" || return 0

        shellenv="$("$brew_path" shellenv)" || {
            log_error "Unable to load the Homebrew environment from $brew_path"
            return 1
        }
        eval "$shellenv"
        log "Homebrew environment hydrated: $brew_path"
    }

    # ========================================================================
    # Sudo management
    # ========================================================================
    acquire_sudo() {
        log "Requesting administrator access (you may be prompted for your password)..."

        # Try non-interactive first (cached credentials or NOPASSWD)
        if sudo -n true 2>/dev/null; then
            log "Administrator access: OK (cached)"
        # Fall back to /dev/tty for password prompt (required for curl | bash
        # where stdin is the pipe, not the terminal)
        elif [[ -e /dev/tty ]] && sudo -v < /dev/tty 2>&1; then
            log "Administrator access: OK"
        else
            log_error "Failed to acquire sudo access. Some phases require administrator privileges."
            log_error "If running via curl | bash over SSH, pre-cache sudo first:"
            log_error "  echo <password> | sudo -S true && curl ... | bash -s -- --server"
            exit 1
        fi

        # Keep sudo alive in background (refresh every 50s, timeout is 5min)
        while true; do
            sudo -n true 2>/dev/null
            sleep 50
        done &
        SUDO_KEEPALIVE_PID=$!
    }

    release_sudo() {
        if [[ -n "${SUDO_KEEPALIVE_PID:-}" ]]; then
            kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
            wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
            unset SUDO_KEEPALIVE_PID
        fi
    }

    # ========================================================================
    # Profile helpers
    # ========================================================================
    profile_is_valid() {
        case "$1" in
            desktop|server)
                return 0
                ;;
            *)
                return 1
                ;;
        esac
    }

    validate_profile_value() {
        local value="$1"
        local source="$2"
        profile_is_valid "$value" ||
            reject_input "Invalid $source profile '$value'; expected desktop or server."
    }

    validate_profile_inputs() {
        local stored_profile=""

        validate_state_root

        if [[ "${DOTFILES_PROFILE+x}" == x ]]; then
            validate_profile_value "$DOTFILES_PROFILE" "DOTFILES_PROFILE"
        fi

        if [[ -L "$STATE_DIR/profile" ]]; then
            reject_input "Stored profile is a symbolic link: $STATE_DIR/profile"
        elif [[ -e "$STATE_DIR/profile" ]]; then
            [[ -f "$STATE_DIR/profile" ]] ||
                reject_input "Stored profile is not a regular file: $STATE_DIR/profile"
            stored_profile="$(< "$STATE_DIR/profile")"
            validate_profile_value "$stored_profile" "stored"
        fi
    }

    get_profile() {
        if [[ "${DOTFILES_PROFILE+x}" == x ]]; then
            echo "$DOTFILES_PROFILE"
        elif [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" && -f "$STATE_DIR/profile" && ! -L "$STATE_DIR/profile" ]]; then
            cat "$STATE_DIR/profile"
        else
            echo "desktop"  # Default
        fi
    }

    # ========================================================================
    # Checkpoint system
    # ========================================================================
    save_checkpoint() {
        local phase="$1"
        [[ "$phase" =~ ^[1-7]$ ]] || {
            printf '%s\n' "ERROR: Cannot save an invalid setup checkpoint: $phase" >&2
            return 73
        }
        atomic_write_state_text "$STATE_DIR/checkpoint" "$phase"
        atomic_append_history "$phase"
    }

    get_checkpoint() {
        local checkpoint="0"
        if [[ -L "$STATE_DIR/checkpoint" ]]; then
            reject_input "Stored checkpoint is a symbolic link: $STATE_DIR/checkpoint"
        elif [[ -e "$STATE_DIR/checkpoint" ]]; then
            [[ -f "$STATE_DIR/checkpoint" ]] ||
                reject_input "Stored checkpoint is not a regular file: $STATE_DIR/checkpoint"
            checkpoint="$(< "$STATE_DIR/checkpoint")"
            [[ "$checkpoint" =~ ^[0-7]$ ]] ||
                reject_input "Invalid stored checkpoint '$checkpoint'; expected a phase value from 0 through 7."
            printf '%s\n' "$checkpoint"
        else
            echo "0"
        fi
    }

    clear_checkpoint() {
        if [[ -L "$STATE_DIR/checkpoint" || ( -e "$STATE_DIR/checkpoint" && ! -f "$STATE_DIR/checkpoint" ) ]]; then
            reject_input "Stored checkpoint is not a safe regular file: $STATE_DIR/checkpoint"
        fi
        rm -f "$STATE_DIR/checkpoint"
    }

    write_result_record() {
        local result_file="$1"
        local result_status="$2"
        local profile="$3"
        local start_phase="$4"
        local phase_suffix="$5"
        local verification_status="$6"
        local repair_route="$7"
        local verification_summary="$8"
        local verification_output="$9"
        local warnings="${10}"

        {
            printf 'status=%s\n' "$result_status"
            printf 'profile=%s\n' "$profile"
            printf 'start_phase=%s\n' "$start_phase"
            printf 'phase_suffix=%s\n' "$phase_suffix"
            printf 'verification=%s\n' "$verification_status"
            printf 'verification_summary=%s\n' "$verification_summary"
            printf 'verification_output=%s\n' "$verification_output"
            printf 'repair=%s\n' "$repair_route"
            printf 'warnings=%s\n' "$warnings"
        } | atomic_publish_file "$result_file"
    }

    write_setup_result() {
        local result_status="$1"
        local profile="$2"
        local start_phase="$3"
        local phase_suffix="$4"
        local verification_status="$5"
        local repair_route="$6"
        local verification_summary="$7"
        local verification_output="$8"
        local result_file="$STATE_DIR/setup-result"
        local warnings=none

        ensure_state_dir || return 1
        [[ "$result_status" == qualified ]] && warnings='see verification_output'
        if [[ "$result_status" == verified || "$result_status" == qualified ]]; then
            write_last_accepted_result \
                "$result_status" "$profile" "$start_phase" "$phase_suffix" \
                "$verification_status" "$repair_route" "$verification_summary" ||
                return 1
        fi
        write_result_record \
            "$result_file" "$result_status" "$profile" "$start_phase" \
            "$phase_suffix" "$verification_status" "$repair_route" \
            "$verification_summary" "$verification_output" "$warnings"
    }

    write_last_accepted_result() {
        local result_status="$1"
        local profile="$2"
        local start_phase="$3"
        local phase_suffix="$4"
        local verification_status="$5"
        local repair_route="$6"
        local verification_summary="$7"
        local result_file="$STATE_DIR/last-accepted-result"
        local accepted_output='none (accepted summary only; verification.log is mutable)'
        local accepted_repair="$repair_route"
        local accepted_warnings=none

        if [[ "$result_status" == qualified ]]; then
            accepted_repair='Review warning counts in verification_summary; accepted raw verification log is not retained'
            accepted_warnings='summary-only (raw verification log not retained)'
        fi
        ensure_state_dir || return 1
        write_result_record \
            "$result_file" "$result_status" "$profile" "$start_phase" \
            "$phase_suffix" "$verification_status" "$accepted_repair" \
            "$verification_summary" "$accepted_output" "$accepted_warnings"
    }

    parse_verification_summary() {
        local output_file="$1"
        local line=""
        local summary_line=""
        local summary_count=0
        local value=""
        local -a summary_fields=()

        VERIFICATION_SUMMARY_LINE=""
        VERIFICATION_STATUS=""
        VERIFICATION_PASSED=0
        VERIFICATION_FAILED=0
        VERIFICATION_WARNINGS=0

        [[ -f "$output_file" ]] || return 1
        while IFS= read -r line; do
            if [[ "$line" == "DOTFILES_VERIFY_SUMMARY "* ]]; then
                summary_line="$line"
                summary_count=$((summary_count + 1))
            fi
        done <"$output_file"

        [[ "$summary_count" -eq 1 ]] || return 1
        read -r -a summary_fields <<<"$summary_line"
        [[ "${#summary_fields[@]}" -eq 6 ]] || return 1
        [[ "${summary_fields[0]}" == DOTFILES_VERIFY_SUMMARY ]] || return 1
        [[ "${summary_fields[1]}" == version=1 ]] || return 1
        case "${summary_fields[2]}" in
            status=verified|status=qualified|status=failed)
                ;;
            *)
                return 1
                ;;
        esac
        [[ "${summary_fields[3]}" == passed=* ]] || return 1
        [[ "${summary_fields[4]}" == failed=* ]] || return 1
        [[ "${summary_fields[5]}" == warnings=* ]] || return 1

        VERIFICATION_SUMMARY_LINE="$summary_line"
        VERIFICATION_STATUS="${summary_fields[2]#status=}"
        VERIFICATION_PASSED="${summary_fields[3]#passed=}"
        VERIFICATION_FAILED="${summary_fields[4]#failed=}"
        VERIFICATION_WARNINGS="${summary_fields[5]#warnings=}"

        for value in \
            "$VERIFICATION_PASSED" \
            "$VERIFICATION_FAILED" \
            "$VERIFICATION_WARNINGS"; do
            [[ "$value" =~ ^[0-9]+$ ]] || return 1
        done

        if (( VERIFICATION_FAILED > 0 )); then
            [[ "$VERIFICATION_STATUS" == failed ]] || return 1
        elif (( VERIFICATION_WARNINGS > 0 )); then
            [[ "$VERIFICATION_STATUS" == qualified ]] || return 1
        elif [[ "$VERIFICATION_STATUS" != verified ]]; then
            return 1
        fi
    }

    read_accepted_result() {
        local result_file="$1"
        local result_status profile verification summary start_phase phase_suffix
        local summary_status summary_warnings

        LAST_ACCEPTED_RESULT_STATUS=""
        LAST_ACCEPTED_RESULT_PROFILE=""
        LAST_ACCEPTED_RESULT_SUMMARY=""
        LAST_ACCEPTED_RESULT_START_PHASE="0"
        LAST_ACCEPTED_RESULT_PHASE_SUFFIX="legacy"

        if [[ ! -e "$result_file" && ! -L "$result_file" ]]; then
            return 2
        fi
        if [[ -L "$result_file" || ! -f "$result_file" ]]; then
            return 3
        fi

        result_status="$(sed -n 's/^status=//p' "$result_file" 2>/dev/null || true)"
        profile="$(sed -n 's/^profile=//p' "$result_file" 2>/dev/null || true)"
        verification="$(sed -n 's/^verification=//p' "$result_file" 2>/dev/null || true)"
        summary="$(sed -n 's/^verification_summary=//p' "$result_file" 2>/dev/null || true)"
        start_phase="$(sed -n 's/^start_phase=//p' "$result_file" 2>/dev/null || true)"
        phase_suffix="$(sed -n 's/^phase_suffix=//p' "$result_file" 2>/dev/null || true)"

        case "$result_status" in
            verified|qualified)
                ;;
            *)
                return 3
                ;;
        esac
        profile_is_valid "$profile" || return 3
        [[ "$verification" == passed ]] || return 3
        [[ "$start_phase" =~ ^[0-7]$ ]] || return 3
        [[ "$phase_suffix" != *$'\n'* ]] || return 3
        [[ "$summary" =~ ^DOTFILES_VERIFY_SUMMARY\ version=1\ status=(verified|qualified)\ passed=[0-9]+\ failed=0\ warnings=([0-9]+)$ ]] ||
            return 3
        summary_status="${BASH_REMATCH[1]}"
        summary_warnings="${BASH_REMATCH[2]}"
        [[ "$summary_status" == "$result_status" ]] || return 3
        if [[ "$result_status" == verified ]]; then
            [[ "$summary_warnings" == 0 ]] || return 3
        else
            [[ "$summary_warnings" -gt 0 ]] || return 3
        fi

        LAST_ACCEPTED_RESULT_STATUS="$result_status"
        LAST_ACCEPTED_RESULT_PROFILE="$profile"
        LAST_ACCEPTED_RESULT_SUMMARY="$summary"
        LAST_ACCEPTED_RESULT_START_PHASE="$start_phase"
        [[ -n "$phase_suffix" ]] && LAST_ACCEPTED_RESULT_PHASE_SUFFIX="$phase_suffix"
        return 0
    }

    preserve_legacy_last_accepted_result() {
        local result_file="$STATE_DIR/last-accepted-result"
        local legacy_result="$STATE_DIR/setup-result"
        local read_status=0

        if [[ -e "$result_file" || -L "$result_file" ]]; then
            return 0
        fi
        if [[ ! -e "$legacy_result" && ! -L "$legacy_result" ]]; then
            return 0
        fi

        read_accepted_result "$legacy_result" || read_status=$?
        [[ "$read_status" -eq 0 ]] || return 0
        write_last_accepted_result \
            "$LAST_ACCEPTED_RESULT_STATUS" "$LAST_ACCEPTED_RESULT_PROFILE" \
            "$LAST_ACCEPTED_RESULT_START_PHASE" "$LAST_ACCEPTED_RESULT_PHASE_SUFFIX" \
            passed "No repair required" "$LAST_ACCEPTED_RESULT_SUMMARY"
    }

    report_resume_context() {
        local read_status=0

        read_accepted_result "$STATE_DIR/last-accepted-result" || read_status=$?
        if [[ "$read_status" -eq 0 ]]; then
            log "Last accepted verification: status=$LAST_ACCEPTED_RESULT_STATUS profile=$LAST_ACCEPTED_RESULT_PROFILE summary=$LAST_ACCEPTED_RESULT_SUMMARY"
        elif [[ "$read_status" -eq 2 ]]; then
            log "Last accepted verification: none (no prior accepted result available)"
        else
            log "Last accepted verification: none (prior receipt invalid or unsafe)"
        fi
    }

    # ========================================================================
    # Usage
    # ========================================================================
    usage() {
        echo "Usage: $0 [OPTIONS] [COMMAND]"
        echo ""
        echo "Unified dotfiles installer for macOS."
        echo ""
        echo "Commands (run from repo):"
        echo "  symlinks         Just create symlinks"
        echo "  prefs            Just apply macOS preferences"
        echo "  status           Show current symlink status"
        echo "  verify           Run installation verification"
        echo ""
        echo "Options:"
        echo "  --desktop, -d    Desktop workstation profile - default"
        echo "  --server, -s     Headless server profile"
        echo "  --resume         Resume from checkpoint or recover a validated stale setup lock"
        echo "  --start-phase N  Start from phase N (0-6)"
        echo "  --help, -h       Show this help message"
        echo ""
        echo "Completion: final verification must pass before the checkpoint is cleared."
        echo "If verification fails or is unavailable, repair it and run --resume."
        echo ""
        echo "Phases:"
        echo "  0: Preflight     - Validate environment"
        echo "  1: Foundation    - Xcode CLT + Homebrew + repo clone"
        echo "  2: AI Rescue     - Native Claude Code + managed Codex CLIs"
        echo "  3: Core Tools    - Essential CLI tools"
        echo "  4: Toolchain     - Fallback runtimes + verified Mise apply"
        echo "  5: Applications  - GUI apps from Brewfile"
        echo "  6: Configuration - Symlinks + macOS preferences"
        echo ""
        echo "Full install (fresh Mac):"
        echo "  curl -fsSL https://raw.githubusercontent.com/nathanvale/dotfiles-private/main/setup.sh | bash"
        echo "  curl ... | bash -s -- --server"
        echo ""
        echo "Update existing installation:"
        echo "  ./setup.sh symlinks    # Recreate symlinks"
        echo "  ./setup.sh prefs       # Reapply macOS preferences"
        echo ""
        echo "Profile: $(get_profile)"
        exit 0
    }

    # ========================================================================
    # Subcommands
    # ========================================================================

    # Auto-detect dotfiles directory (for subcommands run from repo)
    detect_dotfiles_dir() {
        if [[ -d "$DOTFILES_DIR" ]]; then
            echo "$DOTFILES_DIR"
        else
            # Fall back to script location
            cd "$(dirname "$0")" && pwd
        fi
    }

    install_symlinks() {
        require_canonical_activation_checkout
        local dotfiles
        dotfiles=$(detect_dotfiles_dir)
        log_section "Creating symlinks"

        local symlinks_script="$dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh"
        if [[ -f "$symlinks_script" ]]; then
            # Use --force in non-interactive mode (e.g., curl | bash)
            if [[ -t 0 ]]; then
                run_setup_child "$symlinks_script" --link
            else
                run_setup_child "$symlinks_script" --link --force
            fi
        else
            log_warn "Symlinks script not found: $symlinks_script"
        fi
    }

    install_prefs() {
        require_canonical_activation_checkout
        local dotfiles
        dotfiles=$(detect_dotfiles_dir)
        local profile
        profile=$(get_profile)

        log_section "Applying macOS preferences"
        log "Profile: $profile"

        # Common preferences (works for both desktop and server)
        local prefs_script="$dotfiles/config/macos/defaults.common.sh"
        if [[ -f "$prefs_script" ]]; then
            log "Applying common macOS preferences..."
            run_setup_child "$prefs_script" --set
        else
            log_warn "Preferences script not found: $prefs_script"
        fi

    }

    show_status() {
        local dotfiles
        dotfiles=$(detect_dotfiles_dir)
        local symlinks_script="$dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh"
        if [[ -f "$symlinks_script" ]]; then
            "$symlinks_script" --status
        else
            log_error "Symlinks script not found: $symlinks_script"
            exit 1
        fi
    }

    run_verify() {
        local dotfiles
        dotfiles=$(detect_dotfiles_dir)
        if [[ -f "$dotfiles/verify_install.sh" ]]; then
            "$dotfiles/verify_install.sh" "$@"
        else
            log_error "verify_install.sh not found: $dotfiles/verify_install.sh"
            exit 1
        fi
    }

    # Handle subcommand routing
    run_subcommand() {
        local cmd="$1"
        shift
        case "$cmd" in
            symlinks)
                install_symlinks
                ;;
            prefs)
                install_prefs
                ;;
            status)
                show_status
                ;;
            verify)
                run_verify "$@"
                ;;
        esac
    }

    # ========================================================================
    # Phase 0: Preflight Checks
    # ========================================================================
    phase_0_preflight() {
        log_phase 0 "Preflight checks"

        # Check macOS version (require Sequoia 15+ or Tahoe 26+)
        local os_version
        os_version=$(sw_vers -productVersion)
        local major_version
        major_version=$(echo "$os_version" | cut -d. -f1)

        if [[ "$major_version" -lt 15 ]]; then
            log_error "Requires macOS 15+ (Sequoia/Tahoe). Found: $os_version"
            exit 1
        fi
        log "macOS version: $os_version"

        # Check architecture (Apple Silicon only)
        local arch
        arch=$(uname -m)
        if [[ "$arch" != "arm64" ]]; then
            log_error "Requires Apple Silicon (arm64). Found: $arch"
            exit 1
        fi
        log "Architecture: $arch (Apple Silicon)"

        # Check network connectivity
        if ! curl -fsS --max-time 5 https://github.com > /dev/null 2>&1; then
            log_error "No network connectivity to github.com"
            exit 1
        fi
        log "Network connectivity: OK"

        # Check disk space (need ~10GB free)
        local free_gb
        free_gb=$(df -g "$HOME" | tail -1 | awk '{print $4}')
        if [[ "$free_gb" -lt 10 ]]; then
            log_error "Need 10GB free disk space, have ${free_gb}GB"
            exit 1
        fi
        log "Disk space: ${free_gb}GB free"

        # Display profile
        log "Profile: $(get_profile)"

        # Store macOS version for later phases (Tahoe compatibility)
        atomic_write_state_text "$STATE_DIR/macos_version" "$major_version"

        # Acquire sudo for the Homebrew install phase
        acquire_sudo

        log "Preflight: PASSED"
    }

    # ========================================================================
    # Phase 1: Foundation (Xcode CLT + Homebrew + Repo Clone)
    # ========================================================================
    phase_1_foundation() {
        log_phase 1 "Foundation (Xcode CLT + Homebrew)"

        # Xcode Command Line Tools
        if ! xcode-select -p &>/dev/null; then
            log "Installing Xcode Command Line Tools..."

            # Use softwareupdate for non-interactive install (works over SSH)
            # xcode-select --install requires a GUI dialog click
            touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
            local clt_pkg
            clt_pkg=$(softwareupdate -l 2>/dev/null | grep -o '.*Command Line Tools.*' | head -1 | sed 's/^[* ]*//' | sed 's/^Label: //' | sed 's/ *$//')

            if [[ -n "$clt_pkg" ]]; then
                log "Found package: $clt_pkg"
                softwareupdate -i "$clt_pkg" --verbose 2>&1 | tee -a "$LOG_FILE"
            fi
            rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress

            # Verify installation succeeded, fall back to xcode-select --install
            if ! xcode-select -p &>/dev/null; then
                log_warn "softwareupdate didn't install CLT, falling back to xcode-select --install"
                log_warn "You may need to click 'Install' in the dialog if running with a display"
                xcode-select --install 2>/dev/null || true

                # Wait for installation
                log "Waiting for Xcode CLT installation..."
                until xcode-select -p &>/dev/null; do
                    sleep 5
                done
            fi

            log "Xcode CLT installed"
        else
            log "Xcode CLT already installed: $(xcode-select -p)"
        fi

        # Homebrew
        local brew_path
        brew_path="$(canonical_homebrew_path)" || brew_path=""
        if [[ -z "$brew_path" ]]; then
            log "Installing Homebrew..."
            NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

            hydrate_canonical_homebrew_environment
            log "Homebrew installed"
        else
            log "Homebrew already installed: $("$brew_path" --version | head -1)"
        fi

        # macOS Tahoe (26+) compatibility fix
        # Older Homebrew versions don't recognize macOS 26, causing version detection errors
        # See: https://github.com/orgs/Homebrew/discussions/6206
        local macos_version
        macos_version=$(cat "$STATE_DIR/macos_version" 2>/dev/null || echo "0")
        if [[ "$macos_version" -ge 26 ]]; then
            log "Applying Homebrew fix for macOS Tahoe..."
            brew update-reset || log_warn "brew update-reset failed, continuing anyway"
        fi

        # Clone dotfiles if not already done (for curl | bash flow)
        if [[ ! -d "$DOTFILES_DIR" ]]; then
            log "Cloning dotfiles repository..."
            mkdir -p "$(dirname "$DOTFILES_DIR")"

            # Try SSH first, fall back to HTTPS
            if ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
                log "Using SSH to clone"
                git clone "$DOTFILES_REPO" "$DOTFILES_DIR"
            else
                log_warn "SSH not configured, using HTTPS"
                git clone "$DOTFILES_REPO_HTTPS" "$DOTFILES_DIR"
            fi
        fi

        log "Foundation: COMPLETE"
    }

    # ========================================================================
    # Phase 2: AI Rescue (Claude Code + Codex)
    # ========================================================================
    # CRITICAL: This phase installs both agent CLIs ASAP so either can help
    # debug failures in subsequent phases. This is the "AI rescue" pattern.
    # ========================================================================
    phase_2_ai_rescue() {
        log_phase 2 "AI Rescue (Claude Code + Codex)"

        log "Installing Claude Code (enables AI debugging for remaining phases)..."

        # The native installer targets ~/.local/bin, which is not on PATH until
        # the symlinked .zprofile lands in Phase 6, so this run extends PATH
        # itself to keep the rescue command usable in later phases.
        export PATH="$HOME/.local/bin:$PATH"

        if command -v claude &>/dev/null; then
            log "Claude Code already installed"
        else
            if curl -fsSL https://claude.ai/install.sh | bash; then
                log "Claude Code installed successfully"
            else
                log_warn "Claude Code install failed - continuing without AI rescue"
                log_warn "You can install it later: curl -fsSL https://claude.ai/install.sh | bash"
            fi
        fi

        # Verify Claude Code is available
        if command -v claude &>/dev/null; then
            log "SUCCESS: Claude Code ready - AI debugging available"
            atomic_write_state_text "$STATE_DIR/ai_rescue_ready" "ai_rescue_ready"
            log ""
            log "TIP: If later phases fail, run:"
            log "  claude 'Help me debug this setup failure. Check ~/.dotfiles_state/setup.log'"
        else
            log_warn "Claude Code installed but 'claude' command not in PATH yet"
            log_warn "After restart, you can use: claude 'Help me debug...'"
        fi

        local managed_codex="$HOME/.codex/packages/standalone/current/codex"
        log "Installing managed Codex CLI..."

        if [[ -x "$managed_codex" ]]; then
            log "Managed Codex already installed"
        elif curl -fsSL https://chatgpt.com/codex/install.sh | sh &&
             [[ -x "$managed_codex" ]]; then
            log "Managed Codex installed successfully"
        else
            log_warn "Managed Codex install failed - continuing without Codex"
            log_warn "You can install it later: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
        fi

        log "AI Rescue: COMPLETE"
    }

    # ========================================================================
    # Phase 3: Core Tools
    # ========================================================================
    phase_3_core_tools() {
        log_phase 3 "Core Tools"

        # Xcode CLT supplies the selected system Git. Installing Homebrew Git
        # here would shadow that exact owner in every hydrated setup shell.
        local essentials=(
            zsh
            tmux
            zoxide
            fzf
            ripgrep
            fd
            bat
            eza
            gh
            jq
            yq
            lazygit
            wget
            coreutils
            tree
            htop
        )

        log "Installing ${#essentials[@]} essential tools..."

        for tool in "${essentials[@]}"; do
            if brew list "$tool" &>/dev/null; then
                log "  $tool: already installed"
            else
                log "  $tool: installing..."
                brew install "$tool" || log_warn "Failed to install $tool"
            fi
        done

        log "Core Tools: COMPLETE"
    }

    # ========================================================================
    # Phase 4: Development Toolchain
    # ========================================================================
    phase_4_development() {
        log_phase 4 "Development Toolchain"

        local node_version_file="$DOTFILES_DIR/config/node/version"
        if [[ ! -f "$node_version_file" ]]; then
            log_error "Node version declaration not found: $node_version_file"
            return 1
        fi

        local node_version
        node_version=$(< "$node_version_file")
        if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            log_error "Invalid Node version declaration: $node_version_file"
            return 1
        fi

        local dev_tools=(
            bun
            python
            uv
            pipx
            pyenv
            fnm
            mise
            pnpm
            shfmt
            shellcheck
            git-delta
        )

        log "Installing ${#dev_tools[@]} development tools..."

        for tool in "${dev_tools[@]}"; do
            local tool_name
            tool_name=$(basename "$tool")
            if brew list "$tool_name" &>/dev/null; then
                log "  $tool_name: already installed"
            else
                log "  $tool_name: installing..."
                brew install "$tool" || log_warn "Failed to install $tool"
            fi
        done

        if ! command -v fnm &>/dev/null; then
            log_error "fnm is unavailable; cannot install Node $node_version"
            return 1
        fi

        log "Installing Node $node_version with Corepack..."
        if ! fnm install --corepack-enabled "$node_version"; then
            log_error "Failed to install Node $node_version with fnm"
            return 1
        fi

        if ! fnm default "$node_version"; then
            log_error "Failed to set Node $node_version as the fnm default"
            return 1
        fi

        if ! brew list mise &>/dev/null; then
            log_error "The Brewfile-declared Mise formula is unavailable"
            return 1
        fi

        if ! command -v mise &>/dev/null; then
            log_error "The Brewfile-declared Mise formula has no executable on PATH"
            return 1
        fi

        local toolchain_command="$DOTFILES_DIR/bin/dotfiles/toolchain"
        if [[ ! -x "$toolchain_command" ]]; then
            log_error "Toolchain apply command is unavailable: $toolchain_command"
            return 1
        fi

        log "Applying the verified Mise toolchain revision..."
        if ! "$toolchain_command" update --apply; then
            log_error "Failed to apply the verified Mise toolchain revision"
            return 1
        fi

        log "Development Toolchain: COMPLETE"
    }

    # ========================================================================
    # Phase 5: Applications (Profile-aware Brewfile)
    # ========================================================================
    phase_5_applications() {
        log_phase 5 "Applications"

        local profile
        profile=$(get_profile)
        local brewfile="$DOTFILES_DIR/config/brew/Brewfile"

        # Check Brewfile exists
        if [[ ! -f "$brewfile" ]]; then
            log_error "Brewfile not found: $brewfile"
            return 1
        fi

        log "Installing packages for profile: $profile"
        log "This may take 10-15 minutes for a full install..."

        # Pre-cleanup: Remove orphaned cask apps not managed by Homebrew
        # On macOS Tahoe, Homebrew fails with "xattr: Operation not permitted" when
        # it tries to "adopt" an existing app and write kMDItemAlternateNames metadata
        # inside a signed app bundle. Removing the orphan lets Homebrew do a clean install.
        local orphan_casks=("OrbStack")
        for app_name in "${orphan_casks[@]}"; do
            if [[ -d "/Applications/${app_name}.app" ]] && ! brew list --cask "${app_name,,}" &>/dev/null 2>&1; then
                log "Removing orphaned ${app_name}.app (not managed by Homebrew)..."
                rm -rf "/Applications/${app_name}.app"
            fi
        done

        # Run brew bundle with profile environment variable. Serial downloads avoid
        # connection resets from the desktop cask burst on a clean host. One
        # immediate retry keeps a remaining transient failure inside this setup
        # invocation.
        # NOTE: Must use HOMEBREW_ prefix for env vars to pass through to Brewfile Ruby context.
        # Regular env vars are filtered out by Homebrew for security/isolation.
        local bundle_attempt=1
        local bundle_max_attempts=2
        local bundle_download_concurrency=1
        local bundle_exit=0
        log "Profile package download concurrency: $bundle_download_concurrency"
        while [[ "$bundle_attempt" -le "$bundle_max_attempts" ]]; do
            log "Running profile package bundle (attempt $bundle_attempt of $bundle_max_attempts)"
            if HOMEBREW_DOWNLOAD_CONCURRENCY="$bundle_download_concurrency" \
                HOMEBREW_DOTFILES_PROFILE="$profile" brew bundle --file="$brewfile"; then
                log "Profile package bundle attempt $bundle_attempt of $bundle_max_attempts exited 0"
                log "All packages installed successfully"
                break
            else
                bundle_exit=$?
            fi
            log_warn "Profile package bundle attempt $bundle_attempt of $bundle_max_attempts exited $bundle_exit"

            if [[ "$bundle_attempt" -eq "$bundle_max_attempts" ]]; then
                log_error "The profile package bundle failed after $bundle_max_attempts attempts"
                log_error "Retry: HOMEBREW_DOWNLOAD_CONCURRENCY=$bundle_download_concurrency HOMEBREW_DOTFILES_PROFILE=$profile brew bundle --file=$brewfile"
                return 1
            fi

            log_warn "Retrying the profile package bundle once within this setup invocation"
            bundle_attempt=$((bundle_attempt + 1))
        done

        log "Applications: COMPLETE"
    }

    # ========================================================================
    # Phase 6: Configuration (symlinks + macOS preferences)
    # ========================================================================
    phase_6_configuration() {
        log_phase 6 "Configuration (symlinks + preferences)"

        install_symlinks
        install_prefs

        log "Configuration: COMPLETE"
    }

    run_final_verification() {
        local profile="$1"
        local start_phase="$2"
        local phase_suffix="$3"
        local verifier="$DOTFILES_DIR/verify_install.sh"
        local verification_output="$STATE_DIR/verification.log"
        local verification_stage="$STATE_DIR/.setup-verification-$$-$RANDOM"
        local verifier_exit=0

        if ! state_file_is_safe "$verification_output"; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                verification-log-unsafe \
                "Replace the unsafe verification log path, then run ./setup.sh --resume" \
                none "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Installation verification log is not a safe regular file: $verification_output"
            return 1
        fi

        if [[ ! -x "$verifier" ]]; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                missing "Restore $verifier, then run ./setup.sh --resume" \
                none "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Installation verification is unavailable: $verifier"
            log_error "Repair: restore $verifier, then run ./setup.sh --resume"
            return 1
        fi

        log_section "Running installation verification"
        # The machine summary is the completion contract; human output is retained
        # in the same log but never determines whether setup may clear recovery.
        if ! (umask 077; set -o noclobber; : >"$verification_stage") 2>/dev/null; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                verification-log-stage-failed \
                "Repair the verification log staging path, then run ./setup.sh --resume" \
                none "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Could not stage installation verification output: $verification_stage"
            return 1
        fi
        chmod 600 "$verification_stage" || {
            rm -f "$verification_stage" 2>/dev/null || true
            log_error "Could not secure installation verification output: $verification_stage"
            return 1
        }
        if run_setup_child "$verifier" --machine-summary >"$verification_stage" 2>&1; then
            verifier_exit=0
        else
            verifier_exit=$?
        fi
        if ! atomic_publish_file "$verification_output" <"$verification_stage"; then
            rm -f "$verification_stage" 2>/dev/null || true
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                verification-log-publish-failed \
                "Repair the verification log path, then run ./setup.sh --resume" \
                none "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Could not publish installation verification output: $verification_output"
            return 1
        fi
        rm -f "$verification_stage" 2>/dev/null || true
        cat "$verification_output"

        if ! parse_verification_summary "$verification_output"; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                summary-missing-or-malformed \
                "Inspect $verification_output for the required machine summary, repair the verifier, then run ./setup.sh --resume" \
                none "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Installation verification did not emit one valid machine-readable summary"
            log_error "Repair: inspect $verification_output, repair the verifier, then run ./setup.sh --resume"
            return 1
        fi

        if [[ "$verifier_exit" -ne 0 && "$VERIFICATION_STATUS" != failed ]]; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                "summary-exit-mismatch:$verifier_exit" \
                "Inspect $verification_output and verifier exit status, then run ./setup.sh --resume" \
                "$VERIFICATION_SUMMARY_LINE" "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Installation verification summary disagrees with exit $verifier_exit"
            log_error "Repair: inspect $verification_output, repair the verifier, then run ./setup.sh --resume"
            return 1
        fi

        if [[ "$verifier_exit" -eq 0 && "$VERIFICATION_STATUS" == failed ]]; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                summary-exit-mismatch \
                "Inspect $verification_output and verifier exit status, then run ./setup.sh --resume" \
                "$VERIFICATION_SUMMARY_LINE" "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Installation verification summary reports failure with exit 0"
            log_error "Repair: inspect $verification_output, repair the verifier, then run ./setup.sh --resume"
            return 1
        fi

        if [[ "$verifier_exit" -ne 0 ]]; then
            if ! write_setup_result \
                failed "$profile" "$start_phase" "$phase_suffix" \
                "failed:$verifier_exit" \
                "Inspect $verification_output, repair the reported checks, then run ./setup.sh --resume" \
                "$VERIFICATION_SUMMARY_LINE" "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_error "Installation verification failed (exit $verifier_exit)"
            log_error "Repair: inspect $verification_output, fix the reported checks, then run ./setup.sh --resume"
            return 1
        fi

        if [[ "$VERIFICATION_STATUS" == qualified ]]; then
            if ! write_setup_result \
                qualified "$profile" "$start_phase" "$phase_suffix" \
                passed "Review the warnings in $verification_output, then run ./setup.sh --resume after repair" \
                "$VERIFICATION_SUMMARY_LINE" "$verification_output"; then
                log_error "Could not publish the setup result"
                return 1
            fi
            log_warn "Installation verification passed with warnings; setup is qualified, not verified"
            log_warn "Review warnings: $verification_output"
            return 0
        fi

        if ! write_setup_result \
            verified "$profile" "$start_phase" "$phase_suffix" \
            passed "No repair required" \
            "$VERIFICATION_SUMMARY_LINE" "$verification_output"; then
            log_error "Could not publish the setup result"
            return 1
        fi
        log "Installation verification passed"
    }

    # ========================================================================
    # Full install flow
    # ========================================================================
    run_full_install() {
        require_canonical_activation_checkout
        local start_phase="$1"

        hydrate_canonical_homebrew_environment

        local profile
        profile=$(get_profile)

        # Banner
        echo ""
        echo "===================================================="
        echo "     nathanvale/dotfiles-private setup                      "
        echo "===================================================="
        echo ""
        log "Dotfiles location: $DOTFILES_DIR"
        log "Profile: $profile"
        log "Log file: $LOG_FILE"

        # Run phases
        local phases=(
            phase_0_preflight
            phase_1_foundation
            phase_2_ai_rescue
            phase_3_core_tools
            phase_4_development
            phase_5_applications
            phase_6_configuration
        )

        local phase_suffix=""
        if [[ "$start_phase" -lt "${#phases[@]}" ]]; then
            for ((i = start_phase; i < ${#phases[@]}; i++)); do
                if [[ -n "$phase_suffix" ]]; then
                    phase_suffix+=" "
                fi
                phase_suffix+="$i"
            done
        else
            phase_suffix="none (verification only)"
        fi
        log "Executing phase suffix: $phase_suffix"

        for i in "${!phases[@]}"; do
            if [[ "$i" -ge "$start_phase" ]]; then
                ${phases[$i]}
                save_checkpoint "$((i + 1))"
            else
                log "Skipping phase $i (already completed)"
            fi
        done

        if ! run_final_verification "$profile" "$start_phase" "$phase_suffix"; then
            release_sudo
            return 1
        fi

        # Only a verified or explicitly qualified verification result can clear
        # the recovery checkpoint. A failed or unavailable verifier returns above
        # with the checkpoint intact and a durable repair route.
        clear_checkpoint

        echo ""
        log "===================================================="
        if [[ -f "$STATE_DIR/setup-result" ]] && grep -q '^status=qualified$' "$STATE_DIR/setup-result"; then
            log "SETUP COMPLETE WITH WARNINGS"
        else
            log "SETUP VERIFIED"
        fi
        log "===================================================="
        log "Profile: $profile"
        echo ""

        echo "Next steps:"
        echo "  1. Restart your terminal (or run: source ~/.zshrc)"
        echo "  2. Check credential custody: run bin/with-one-password-token check and follow its attended repair route"
        echo "  3. Run 'tmux' to start a session"
        if [[ "$profile" == "server" ]]; then
            echo "  4. Verify server settings: pmset -g"
            echo "  5. Test SSH access from another machine"
        fi
        echo ""

        # Release sudo keep-alive before final banner
        release_sudo

        echo ""
        echo -e "${GREEN}════════════════════════════════════════════════════${RESET}"
        if [[ -f "$STATE_DIR/setup-result" ]] && grep -q '^status=qualified$' "$STATE_DIR/setup-result"; then
            echo -e "${YELLOW}  ! Setup complete with warnings${RESET}"
        else
            echo -e "${GREEN}  ✓ Setup verified!${RESET}"
        fi
        echo -e "${GREEN}════════════════════════════════════════════════════${RESET}"
        echo ""
    }

    # ========================================================================
    # Parse arguments and route
    # ========================================================================
    local profile_arg=""
    local start_phase=0
    local checkpoint_value=""
    local resume=false
    local subcommand=""
    local subcommand_args=()

    while [[ "$#" -gt 0 ]]; do
        case $1 in
            --help|-h)
                usage
                ;;
            --server|-s)
                profile_arg="server"
                shift
                ;;
            --desktop|-d)
                profile_arg="desktop"
                shift
                ;;
            --resume)
                resume=true
                shift
                ;;
            --start-phase)
                [[ "$#" -ge 2 ]] ||
                    reject_input "--start-phase requires a phase number from 0 through 6."
                start_phase="$2"
                case "$start_phase" in
                    0|1|2|3|4|5|6)
                        ;;
                    *)
                        reject_input "Invalid start phase '$start_phase'; expected a number from 0 through 6."
                        ;;
                esac
                shift 2
                ;;
            symlinks|prefs|status|verify)
                subcommand="$1"
                shift
                subcommand_args=("$@")
                break
                ;;
            *)
                log_error "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done

    if $resume; then
        SETUP_STALE_RECOVERY_ALLOWED=true
    fi

    # Work-profile state migration.
    #
    # Work-profile selection moved into the machine-state store beside the machine
    # profile above. `.zshrc` now loads $HOME/code/<slug>-dotfiles/profile.zsh only
    # when $STATE_DIR/work-profile holds a slug that passes a conservative grammar.
    #
    # The loaders that shape replaced were an unvalidated ambient $WORK_PROFILE and
    # a literal employer-named line in a public repository. Removing them without
    # writing the state file would silently disable a working work environment on a
    # machine that had one, so this seeds the scalar from what is actually present.
    #
    # It never overwrites an existing selection, and it only ever writes a slug it
    # derived from a directory name that already exists on this machine.
    migrate_work_profile_state() {
        local state_file="$STATE_DIR/work-profile"

        [[ -e "$state_file" ]] && return 0

        local slug=""

        # Prefer an ambient value if this shell still carries the retired variable,
        # but only when it names a directory that exists.
        if [[ -n "${WORK_PROFILE:-}" && -f "$HOME/code/${WORK_PROFILE}-dotfiles/profile.zsh" ]]; then
            slug="$WORK_PROFILE"
        else
            # Otherwise adopt a private profile repository if exactly one is present.
            # More than one is ambiguous, and guessing would pick someone's work
            # configuration for them.
            local -a candidates=()
            local dir base
            for dir in "$HOME/code/"*-dotfiles; do
                [[ -f "$dir/profile.zsh" ]] || continue
                base="${dir##*/}"
                candidates+=("${base%-dotfiles}")
            done
            if [[ ${#candidates[@]} -eq 1 ]]; then
                slug="${candidates[0]}"
            elif [[ ${#candidates[@]} -gt 1 ]]; then
                log_warn "Multiple private profile repositories found in ~/code."
                log_warn "  Select one:  echo '<slug>' > $state_file"
                return 0
            fi
        fi

        [[ -n "$slug" ]] || return 0

        # Apply the same grammar .zshrc enforces, so setup cannot write a value the
        # shell will refuse. A rejected value is reported rather than written. The
        # pattern bounds repetitions, and a `-x` repetition is two characters, so
        # the length check is what enforces the documented 32-character total.
        if [[ ! "$slug" =~ ^[a-z0-9]([a-z0-9]|-[a-z0-9]){0,31}$ ]] || (( ${#slug} > 32 )); then
            log_warn "Work profile '$slug' is not a valid slug; not migrated."
            log_warn "  Set one by hand:  echo '<slug>' > $state_file"
            return 0
        fi

        # Apply the same containment .zshrc enforces after the grammar: a
        # well-formed slug whose directory is a symlink out of $HOME/code is a
        # candidate the shell refuses at every startup, so writing it here
        # would seed a selection that silently never loads.
        local code_root="" resolved=""
        code_root="$(CDPATH='' cd "$HOME/code" 2>/dev/null && pwd -P)" || code_root=""
        resolved="$(CDPATH='' cd "$HOME/code/${slug}-dotfiles" 2>/dev/null && pwd -P)" || resolved=""
        if [[ -z "$code_root" || -z "$resolved" || "$resolved" != "$code_root"/* ]]; then
            log_warn "Work profile '$slug' resolves outside $HOME/code; not migrated."
            log_warn "  Set one by hand:  echo '<slug>' > $state_file"
            return 0
        fi

        atomic_write_state_text "$state_file" "$slug"
        log "Migrated work profile selection: $slug"
    }

    # Read-only subcommands do not create state or acquire the mutation lock.
    if [[ "$subcommand" == status || "$subcommand" == verify ]]; then
        if [[ ${#subcommand_args[@]} -gt 0 ]]; then
            run_subcommand "$subcommand" "${subcommand_args[@]}"
        else
            run_subcommand "$subcommand"
        fi
        return 0
    fi

    # Validate all ambient profile inputs before creating state or selecting a
    # setup phase. An explicit flag may override a valid stored value, but a
    # malformed environment or state value is still refused instead of being
    # silently masked.
    validate_profile_inputs

    # Mutating subcommands share the same state-root and lock boundary as a
    # complete install.
    if [[ -n "$subcommand" ]]; then
        DOTFILES_PROFILE="$(get_profile)"
        export DOTFILES_PROFILE
        validate_profile_value "$DOTFILES_PROFILE" "effective"
        ensure_state_dir
        acquire_setup_lock
        if [[ ${#subcommand_args[@]} -gt 0 ]]; then
            run_subcommand "$subcommand" "${subcommand_args[@]}"
        else
            run_subcommand "$subcommand"
        fi
        return 0
    fi

    # Full install flow: profile selection
    if [[ -n "$profile_arg" ]]; then
        DOTFILES_PROFILE="$profile_arg"
    elif $resume && [[ -n "${DOTFILES_PROFILE:-}" ||
        ( -d "$STATE_DIR" && ! -L "$STATE_DIR" && -f "$STATE_DIR/profile" && ! -L "$STATE_DIR/profile" ) ]]; then
        DOTFILES_PROFILE="$(get_profile)"
    elif [[ -t 0 ]]; then
        # Interactive mode - prompt for profile
        echo ""
        echo "===================================================="
        echo "     nathanvale/dotfiles-private setup                      "
        echo "===================================================="
        echo ""
        echo "Select machine profile:"
        echo "  1) Desktop - GUI apps, development tools"
        echo "  2) Server - headless, containers, AI workloads"
        echo ""
        read -p "Choice [1/2] (default: 1): " -n 1 -r
        echo
        case $REPLY in
            2) DOTFILES_PROFILE="server" ;;
            *) DOTFILES_PROFILE="desktop" ;;
        esac
    else
        # Piped input (curl | bash) - require explicit flag
        reject_input "Profile not specified. When using curl | bash, specify --desktop or --server."
    fi

    validate_profile_value "$DOTFILES_PROFILE" "effective"
    # Reject any existing checkpoint before creating the mutation lock or
    # publishing profile, log, or migrated work-profile state. With --resume,
    # the stored checkpoint remains authoritative over any parsed --start-phase;
    # without --resume, the explicit --start-phase remains selected after
    # validation. The value is read again after lock acquisition below so
    # durable mutation uses the state that the owner actually serialized.
    if [[ -e "$STATE_DIR/checkpoint" || -L "$STATE_DIR/checkpoint" ]]; then
        checkpoint_value="$(get_checkpoint)"
        if $resume; then
            start_phase="$checkpoint_value"
        fi
    fi
    ensure_state_dir
    acquire_setup_lock

    # Revalidate the state inputs after acquiring the lock so a concurrent
    # writer cannot change the profile or state-root between validation and
    # publication.
    validate_profile_inputs

    checkpoint_value="0"
    if [[ -e "$STATE_DIR/checkpoint" || -L "$STATE_DIR/checkpoint" ]]; then
        checkpoint_value="$(get_checkpoint)"
    fi
    if $resume; then
        start_phase="$checkpoint_value"
    fi

    # Save profile to state directory for child scripts
    atomic_write_state_text "$STATE_DIR/profile" "$DOTFILES_PROFILE"
    export DOTFILES_PROFILE

    log "Selected profile: $DOTFILES_PROFILE"

    migrate_work_profile_state
    preserve_legacy_last_accepted_result

    # Handle resume
    if $resume; then
        log "Resume next phase: phase $start_phase"
        report_resume_context
        if [[ "$start_phase" == "0" ]]; then
            log "No checkpoint found, starting from beginning"
        else
            log "Resuming from phase $start_phase"
        fi
    fi

    # Check if dotfiles already exist (curl | bash flow)
    if [[ -d "$DOTFILES_DIR" ]] &&
        [[ ! -f "$DOTFILES_DIR/setup.sh" || ! "$DOTFILES_DIR/setup.sh" -ef "${BASH_SOURCE[0]:-$0}" ]]; then
        log_warn "Dotfiles directory already exists: $DOTFILES_DIR"

        if [[ -t 0 ]]; then
            read -p "Pull latest changes and continue? [y/N] " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log "Exiting. Run ./setup.sh manually when ready."
                exit 0
            fi
        fi

        # Pull latest
        log "Pulling latest changes..."
        cd "$DOTFILES_DIR"
        git pull
    fi

    # Prompt before full install (interactive only)
    if [[ -t 0 ]] && [[ "$start_phase" -eq 0 ]] && ! $resume; then
        echo ""
        echo "This will:"
        echo "  Phase 0: Validate environment (macOS, arch, network, disk)"
        echo "  Phase 1: Install Xcode CLT + Homebrew + clone repo"
        echo "  Phase 2: Install native Claude Code + managed Codex CLIs"
        echo "  Phase 3: Install 16+ essential CLI tools"
        echo "  Phase 4: Install fallback runtimes and apply the verified Mise toolchain"
        echo "  Phase 5: Install all GUI apps from Brewfile"
        echo "  Phase 6: Create symlinks + apply macOS preferences"
        echo ""

        read -p "Continue with full installation? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "Skipped. Run ./setup.sh when ready."
            exit 0
        fi
    fi

    run_full_install "$start_phase"
}

# Execute main function with all arguments
main "$@"
