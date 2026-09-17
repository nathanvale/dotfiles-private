#!/usr/bin/env bash
# verify_install.sh - Post-installation verification
#
# Validates that all bootstrap phases completed successfully.
# Run after setup.sh to verify.
#
# Usage:
#   ./verify_install.sh           # Run all verifications
#   ./verify_install.sh --quiet   # Only show failures
#   ./verify_install.sh --verbose # Show every check individually
#   ./verify_install.sh --machine-summary # Add a stable completion record

# Note: Not using set -e because we want to continue on verification failures
set -uo pipefail

# The executable location owns verification identity. Ambient DOTFILES must not
# redirect checks to a different checkout or fixture.
DOTFILES="$(CDPATH='' cd "$(dirname "$0")" && pwd -P)"
STATE_DIR="$HOME/.dotfiles_state"
NODE_VERSION_FILE="$DOTFILES/config/node/version"
PROFILE_REQUIREMENTS_FILE="$DOTFILES/config/brew/profile-requirements.tsv"
NODE_VERSION=""
if [[ -f "$NODE_VERSION_FILE" ]]; then
    NODE_VERSION=$(< "$NODE_VERSION_FILE")
fi

# Ensure Homebrew is in PATH for this script (Apple Silicon)
if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Colors (self-contained -- don't source colour_log.sh, this runs when things may be broken)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
RESET='\033[0m'

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Track warning and failure names for recap
# Note: Guard array iteration with length check for bash 3.2 compatibility.
# On bash <4.4, "${arr[@]}" on an empty array triggers "unbound variable"
# under set -u. Always check ${#arr[@]} before iterating.
WARN_ITEMS=()
FAIL_ITEMS=()

# Per-phase counters for collapsed output
PHASE_PASS=0
PHASE_FAIL=0
PHASE_WARN=0
PHASE_SKIP=0
PHASE_ISSUES=()

# Display mode
MODE="normal"  # normal, quiet, verbose
MACHINE_SUMMARY=false

# Get profile
get_profile() {
    if [[ -n "${DOTFILES_PROFILE:-}" ]]; then
        echo "$DOTFILES_PROFILE"
    elif [[ -f "$STATE_DIR/profile" ]]; then
        cat "$STATE_DIR/profile"
    else
        echo "desktop"
    fi
}

pmset_setting_is_zero() {
    local setting="$1"
    local value

    value="$(pmset -g | awk -v setting="$setting" '$1 == setting { print $2; exit }')"
    [[ "$value" == "0" ]]
}

# Start a new phase (resets per-phase counters)
phase_start() {
    PHASE_PASS=0
    PHASE_FAIL=0
    PHASE_WARN=0
    PHASE_SKIP=0
    PHASE_ISSUES=()
}

# End a phase (prints collapsed summary)
phase_end() {
    local name="$1"
    local total=$((PHASE_PASS + PHASE_FAIL + PHASE_WARN + PHASE_SKIP))

    if [[ $PHASE_FAIL -eq 0 && $PHASE_WARN -eq 0 && $PHASE_SKIP -eq 0 ]]; then
        # All passed -- single line
        if [[ "$MODE" != "quiet" ]]; then
            echo -e "${GREEN}${name}:${RESET} ${PHASE_PASS}/${total} passed"
            if [[ "$MODE" == "verbose" && ${#PHASE_ISSUES[@]} -gt 0 ]]; then
                for issue in "${PHASE_ISSUES[@]}"; do
                    echo -e "  $issue"
                done
            fi
        fi
    elif [[ $PHASE_FAIL -eq 0 && $PHASE_WARN -eq 0 ]]; then
        if [[ "$MODE" != "quiet" ]]; then
            echo -e "${GREEN}${name}:${RESET} ${PHASE_PASS}/${total} passed, ${PHASE_SKIP} not applicable"
            if [[ ${#PHASE_ISSUES[@]} -gt 0 ]]; then
                for issue in "${PHASE_ISSUES[@]}"; do
                    echo -e "  $issue"
                done
            fi
        fi
    else
        # Has issues -- show summary + expand failures/warnings
        echo -e "${CYAN}${name}:${RESET} ${PHASE_PASS}/${total} passed"
        if [[ ${#PHASE_ISSUES[@]} -gt 0 ]]; then
            for issue in "${PHASE_ISSUES[@]}"; do
                echo -e "  $issue"
            done
        fi
    fi
}

record_pass() {
    local name="$1"
    PASS_COUNT=$((PASS_COUNT + 1))
    PHASE_PASS=$((PHASE_PASS + 1))
    if [[ "$MODE" == "verbose" ]]; then
        PHASE_ISSUES+=("${GREEN}✓${RESET} $name")
    fi
}

record_fail() {
    local name="$1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAIL_ITEMS+=("$name")
    PHASE_FAIL=$((PHASE_FAIL + 1))
    PHASE_ISSUES+=("${RED}✗ $name${RESET}")
}

record_warn() {
    local name="$1"
    WARN_COUNT=$((WARN_COUNT + 1))
    WARN_ITEMS+=("$name")
    PHASE_WARN=$((PHASE_WARN + 1))
    PHASE_ISSUES+=("${YELLOW}⚠ $name${RESET}")
}

record_skip() {
    local name="$1"
    PHASE_SKIP=$((PHASE_SKIP + 1))
    PHASE_ISSUES+=("${DIM}· $name (not applicable)${RESET}")
}

# Verification helper
verify() {
    local name="$1"
    local cmd="$2"

    if eval "$cmd" &>/dev/null; then
        record_pass "$name"
        return 0
    else
        record_fail "$name"
        return 0  # Don't fail the script, just record the failure
    fi
}

# Warning helper (non-fatal)
verify_warn() {
    local name="$1"
    local cmd="$2"

    if eval "$cmd" &>/dev/null; then
        record_pass "$name"
        return 0
    else
        record_warn "$name"
        return 0
    fi
}

# The native Claude installer writes its executable to ~/.local/bin. Setup
# hydrates that directory for its own shell, but the final verifier is a child
# process and must remain truthful when it inherits the pre-install PATH.
claude_code_available() {
    command -v claude &>/dev/null ||
        [[ -f "$HOME/.local/bin/claude" && -x "$HOME/.local/bin/claude" ]]
}

# The profile package table is shared with config/brew/Brewfile. Keep the
# verification checks typed so a malformed table cannot become shell code.
profile_requirement_holds() {
    local check_kind="$1"
    local check_value="$2"

    case "$check_kind" in
        app)
            [[ -d "$check_value" ]]
            ;;
        command)
            command -v "$check_value" &>/dev/null
            ;;
        home-executable)
            [[ -x "$HOME/$check_value" ]]
            ;;
        *)
            return 1
            ;;
    esac
}

verify_profile_requirements() {
    local requested_phase="$1"
    local scope severity package_type package label check_kind check_value phase inactive

    if [[ ! -r "$PROFILE_REQUIREMENTS_FILE" ]]; then
        record_fail "Profile package requirements manifest"
        return 0
    fi

    while IFS=$'\t' read -r scope severity package_type package label check_kind check_value phase inactive ||
        [[ -n "$scope" ]]; do
        [[ -z "$scope" || "$scope" == \#* ]] && continue

        if [[ "$scope" != all && "$scope" != desktop && "$scope" != server ]] ||
            [[ "$severity" != required && "$severity" != warn ]] ||
            [[ "$package_type" != cask && "$package_type" != brew && "$package_type" != preexisting ]] ||
            [[ -z "$package" || -z "$label" || -z "$check_value" ]] ||
            [[ "$phase" != applications && "$phase" != server ]] ||
            [[ "$inactive" != omit && "$inactive" != skip ]]; then
            record_fail "Profile package requirements manifest"
            return 0
        fi

        case "$check_kind" in
            app|command|home-executable) ;;
            *)
                record_fail "Profile package requirements manifest"
                return 0
                ;;
        esac

        [[ "$phase" == "$requested_phase" ]] || continue

        if [[ "$scope" != all && "$scope" != "$PROFILE" ]]; then
            [[ "$inactive" == skip ]] && record_skip "$label"
            continue
        fi

        case "$severity" in
            required)
                if profile_requirement_holds "$check_kind" "$check_value"; then
                    record_pass "$label"
                else
                    record_fail "$label"
                fi
                ;;
            warn)
                if profile_requirement_holds "$check_kind" "$check_value"; then
                    record_pass "$label"
                else
                    record_warn "$label"
                fi
                ;;
        esac
    done < "$PROFILE_REQUIREMENTS_FILE"
}

# Called indirectly through the command string passed to verify().
# shellcheck disable=SC2329
node_version_declared() {
    [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Called indirectly through the command string passed to verify().
# shellcheck disable=SC2329
fnm_default_matches_declaration() {
    [[ "$(fnm default)" == "v$NODE_VERSION" ]]
}

# Called indirectly through the command string passed to verify().
# shellcheck disable=SC2329
node_default_matches_declaration() {
    [[ "$(fnm exec --using=default node --version)" == "v$NODE_VERSION" ]]
}

# Called indirectly through the command strings passed to verify(). These keep
# malformed declarations separate from the expected source-only qualification
# warning while the current fallback runtimes remain intentionally active.
# shellcheck disable=SC2329
toolchain_status_json() {
    if [[ "${TOOLCHAIN_STATUS_LOADED:-false}" != true ]]; then
        TOOLCHAIN_STATUS_JSON="$("$DOTFILES/bin/dotfiles/toolchain" status --json 2>/dev/null)"
        TOOLCHAIN_STATUS_EXIT=$?
        TOOLCHAIN_STATUS_LOADED=true
    fi
}

# shellcheck disable=SC2329
toolchain_manifest_healthy() {
    toolchain_status_json
    [[ "$TOOLCHAIN_STATUS_EXIT" -ne 64 && "$TOOLCHAIN_STATUS_EXIT" -ne 65 ]] || return 1
    printf '%s' "$TOOLCHAIN_STATUS_JSON" | jq -e '.status != "error" and (.tools | type == "array") and all(.tools[]; .declaration_matches == true)' >/dev/null 2>&1
}

# shellcheck disable=SC2329
toolchain_reconstruction_ready() {
    toolchain_manifest_healthy || return 1
    [[ "$TOOLCHAIN_STATUS_EXIT" -eq 0 ]]
}

# Called indirectly through verify(). Run the same POSIX bootstrap used by Git
# hooks in a fresh environment so an inherited interactive shell cannot make an
# invalid selection look active.
# shellcheck disable=SC2329
mise_applied_selection_healthy() {
    local mise_path
    mise_path="$(command -v mise 2>/dev/null)" || return 1
    mise_path="${mise_path%/*}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    # The child expands these variables after env supplies its isolated values.
    # shellcheck disable=SC2016
    env -i HOME="$HOME" DOTFILES="$DOTFILES" \
        PATH="$mise_path" \
        /bin/sh -c '
            . "$DOTFILES/config/mise/bootstrap.sh"
            [ "${DOTFILES_MISE_ACTIVE:-0}" = 1 ] &&
                [ -r "$MISE_GLOBAL_CONFIG_FILE" ]
        '
}

# shellcheck disable=SC2329
mise_effective_toolchain_healthy() {
    local mise_path output status
    mise_path="$(command -v mise 2>/dev/null)" || return 1
    mise_path="${mise_path%/*}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    # The child expands these variables after env supplies its isolated values.
    # shellcheck disable=SC2016
    output="$(env -i HOME="$HOME" DOTFILES="$DOTFILES" \
        PATH="$mise_path" \
        /bin/sh -c '
            . "$DOTFILES/config/mise/bootstrap.sh"
            [ "${DOTFILES_MISE_ACTIVE:-0}" = 1 ] || exit 69
            exec "$DOTFILES/bin/dotfiles/toolchain" status --json
        ' 2>/dev/null)"
    status=$?
    [[ "$status" -eq 0 || "$status" -eq 2 ]] || return 1
    printf '%s' "$output" | jq -e '
        .status == "ready" and
        ([.tools[] | select(.name == "node" or .name == "bun" or .name == "python" or .name == "bd" or .name == "npm")] | length == 5) and
        all(.tools[] | select(.name == "node" or .name == "bun" or .name == "python" or .name == "bd" or .name == "npm");
            .selected_owner == "mise" and .observed_owner == "mise" and
            .selected_owner_matches == true and .version_matches == true) and
        (.tools[] | select(.name == "npm") | .owning_node_runtime |
            .status == "observed" and .tool == "node" and
            .matches_declared_parent == true and
            (.effective_version | length > 0) and
            (.executable_path | length > 0) and
            (.npm_effective_version | length > 0) and
            (.npm_executable_path | length > 0) and
            .mise_routed_npm_path == .npm_executable_path)
    ' >/dev/null 2>&1
}

managed_symlink_status_contract_failed() {
    verify "Managed symlink status contract" "false"
    return 0
}

verify_managed_symlinks() {
    local manager="$DOTFILES/bin/dotfiles/symlinks/symlinks_manage.sh"
    local manager_status=0
    local status_output=""
    local line=""
    local header_records=""
    local row_index=0
    local requirement=""
    local scope=""
    local destination=""
    local expected=""
    local actual=""
    local object=""
    local status=""
    local active="false"
    local seen_destination=""
    local -a rows=()
    local -a header_fields=()
    local -a fields=()
    local -a seen_destinations=()

    if [[ ! -x "$manager" ]]; then
        managed_symlink_status_contract_failed
        return 0
    fi

    status_output="$("$manager" --status --machine 2>/dev/null)"
    manager_status=$?
    if [[ $manager_status -ne 0 ]]; then
        managed_symlink_status_contract_failed
        return 0
    fi

    while IFS= read -r line || [[ -n "$line" ]]; do
        rows+=("$line")
    done <<<"$status_output"
    if [[ ${#rows[@]} -lt 2 ]]; then
        managed_symlink_status_contract_failed
        return 0
    fi

    IFS=' ' read -r -a header_fields <<<"${rows[0]}"
    if [[ ${#header_fields[@]} -ne 4 ||
        "${header_fields[0]:-}" != DOTFILES_SYMLINK_STATUS ||
        "${header_fields[1]:-}" != version=1 ||
        "${header_fields[2]:-}" != "profile=$PROFILE" ||
        "${header_fields[3]:-}" != records=* ]]; then
        managed_symlink_status_contract_failed
        return 0
    fi
    header_records="${header_fields[3]#records=}"
    if [[ ! "$header_records" =~ ^[1-9][0-9]*$ ]]; then
        managed_symlink_status_contract_failed
        return 0
    fi
    if [[ $(( ${#rows[@]} - 1 )) -ne $header_records ]]; then
        managed_symlink_status_contract_failed
        return 0
    fi

    for ((row_index = 1; row_index < ${#rows[@]}; row_index++)); do
        IFS=$'\t' read -r -a fields <<<"${rows[$row_index]}"
        if [[ ${#fields[@]} -ne 8 ||
            "${fields[0]:-}" != DOTFILES_SYMLINK_RECORD ]]; then
            managed_symlink_status_contract_failed
            return 0
        fi

        requirement="${fields[1]}"
        scope="${fields[2]}"
        destination="${fields[3]}"
        expected="${fields[4]}"
        actual="${fields[5]}"
        object="${fields[6]}"
        status="${fields[7]}"

        if [[ "$requirement" != required && "$requirement" != optional ]] ||
            [[ "$scope" != common && "$scope" != desktop && "$scope" != server ]] ||
            [[ "$destination" != /* || "$expected" != /* ]] ||
            [[ "$destination" == *$'\n'* || "$destination" == *$'\r'* || "$destination" == *$'\t'* ]] ||
            [[ "$expected" == *$'\n'* || "$expected" == *$'\r'* || "$expected" == *$'\t'* ]] ||
            [[ "$actual" == *$'\n'* || "$actual" == *$'\r'* || "$actual" == *$'\t'* ]]; then
            managed_symlink_status_contract_failed
            return 0
        fi
        case "$object" in
            symlink|missing|file|directory|unknown|not-applicable) ;;
            *)
                managed_symlink_status_contract_failed
                return 0
                ;;
        esac
        case "$status" in
            ok|wrong-target|dangling|nonlink|missing|not-applicable) ;;
            *)
                managed_symlink_status_contract_failed
                return 0
                ;;
        esac

        if [[ ${#seen_destinations[@]} -gt 0 ]]; then
            for seen_destination in "${seen_destinations[@]}"; do
                if [[ "$seen_destination" == "$destination" ]]; then
                    managed_symlink_status_contract_failed
                    return 0
                fi
            done
        fi
        seen_destinations+=("$destination")

        if [[ "$scope" == common || "$scope" == "$PROFILE" ]]; then
            active="true"
        else
            active="false"
        fi

        if [[ "$active" == false ]]; then
            if [[ "$requirement" != optional || "$actual" != - ||
                "$object" != not-applicable || "$status" != not-applicable ]]; then
                managed_symlink_status_contract_failed
                return 0
            fi
            record_skip "Managed symlink: $destination"
            continue
        fi

        if [[ "$status" == not-applicable || "$object" == not-applicable ]]; then
            managed_symlink_status_contract_failed
            return 0
        fi
        case "$status" in
            ok)
                [[ "$requirement" == required || "$requirement" == optional ]] || {
                    managed_symlink_status_contract_failed
                    return 0
                }
                [[ "$object" == symlink && "$actual" == "$expected" ]] || {
                    managed_symlink_status_contract_failed
                    return 0
                }
                if [[ "$requirement" == required ]]; then
                    record_pass "Managed symlink: $destination"
                else
                    record_pass "Optional managed symlink: $destination"
                fi
                ;;
            wrong-target|dangling)
                [[ "$object" == symlink ]] || {
                    managed_symlink_status_contract_failed
                    return 0
                }
                if [[ "$requirement" == required ]]; then
                    record_fail "Managed symlink: $destination"
                else
                    record_warn "Optional managed symlink: $destination"
                fi
                ;;
            nonlink)
                [[ "$object" != symlink && "$actual" == - ]] || {
                    managed_symlink_status_contract_failed
                    return 0
                }
                if [[ "$requirement" == required ]]; then
                    record_fail "Managed symlink: $destination"
                else
                    record_warn "Optional managed symlink: $destination"
                fi
                ;;
            missing)
                [[ "$object" == missing && "$actual" == - ]] || {
                    managed_symlink_status_contract_failed
                    return 0
                }
                if [[ "$requirement" == required ]]; then
                    record_fail "Managed symlink: $destination"
                else
                    record_warn "Optional managed symlink: $destination"
                fi
                ;;
            *)
                managed_symlink_status_contract_failed
                return 0
                ;;
        esac
    done

    record_pass "Managed symlink status contract"
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --quiet|-q)
            MODE="quiet"
            shift
            ;;
        --verbose|-v)
            MODE="verbose"
            shift
            ;;
        --machine-summary)
            MACHINE_SUMMARY=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--quiet] [--verbose] [--machine-summary]"
            echo ""
            echo "Options:"
            echo "  --quiet, -q    Only show phases with failures"
            echo "  --verbose, -v  Show every individual check"
            echo "  --machine-summary  Append a stable completion record"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

PROFILE=$(get_profile)

echo ""
echo -e "${CYAN}=== Installation Verification ===${RESET}"
echo -e "Profile: $PROFILE"
echo ""

# ============================================================================
# Phase 1: Foundation
# ============================================================================
phase_start
verify "Homebrew" "command -v brew"
verify "Dotfiles repo" "[[ -d '$DOTFILES' ]]"
verify "Xcode CLT" "xcode-select -p"
phase_end "Phase 1: Foundation"

# ============================================================================
# Phase 2: AI Rescue
# ============================================================================
phase_start
verify_warn "Claude Code" "claude_code_available"
verify_warn "Managed Codex" "[[ -x '$HOME/.codex/packages/standalone/current/codex' ]]"
# Only check AI rescue marker if Claude Code itself is missing (otherwise it's noise)
if ! claude_code_available; then
    verify_warn "AI rescue marker" "[[ -f '$STATE_DIR/ai_rescue_ready' ]]"
else
    # Count it as passed silently
    PASS_COUNT=$((PASS_COUNT + 1))
    PHASE_PASS=$((PHASE_PASS + 1))
fi
phase_end "Phase 2: AI Rescue"

# ============================================================================
# Phase 3: Core Tools
# ============================================================================
phase_start
verify "Git" "command -v git"
verify "Zsh" "command -v zsh"
verify "Tmux" "command -v tmux"
verify "Zoxide" "command -v zoxide"
verify "Fzf" "command -v fzf"
verify "Ripgrep" "command -v rg"
verify "Fd" "command -v fd"
verify "Bat" "command -v bat"
verify "Eza" "command -v eza"
verify "GitHub CLI" "command -v gh"
verify "jq" "command -v jq"
verify "yq" "command -v yq"
phase_end "Phase 3: Core Tools"

# ============================================================================
# Phase 4: Development
# ============================================================================
phase_start
verify "Bun" "command -v bun"
verify "Bun version" "bun --version"
verify "Bun revision" "bun --revision"
verify "Bun Homebrew ownership" "brew list --versions bun"
verify "Python" "command -v python3"
verify "UV" "command -v uv"
verify "Mise" "command -v mise"
verify "Mise applied selection" "mise_applied_selection_healthy"
verify "Mise effective toolchain ownership" "mise_effective_toolchain_healthy"
verify "fnm (Node)" "command -v fnm"
verify "Node version declaration" "node_version_declared"
verify "fnm default Node" "fnm_default_matches_declaration"
verify "Node $NODE_VERSION" "node_default_matches_declaration"
verify "npm" "fnm exec --using=default npm --version"
verify "npx" "fnm exec --using=default npx --version"
verify "Corepack" "fnm exec --using=default corepack --version"
verify "pnpm" "command -v pnpm"
verify "shellcheck" "command -v shellcheck"
verify "Toolchain declaration manifest" "toolchain_manifest_healthy"
if toolchain_manifest_healthy; then
    verify_warn "Toolchain reconstruction qualification" "toolchain_reconstruction_ready"
fi
phase_end "Phase 4: Development"

# ============================================================================
# Phase 5: Applications (Profile-specific)
# ============================================================================
phase_start
verify_profile_requirements applications
phase_end "Phase 5: Applications"

# ============================================================================
# Phase 6: Configuration
# ============================================================================
phase_start
verify_managed_symlinks
verify_warn "Full Disk Access" "plutil -lint /Library/Preferences/com.apple.TimeMachine.plist"
verify "Profile saved" "[[ -f '$STATE_DIR/profile' ]]"
phase_end "Phase 6: Configuration"

# ============================================================================
# Server-specific verification
# ============================================================================
if [[ "$PROFILE" == "server" ]]; then
    phase_start
    verify_profile_requirements server
    verify "LM Studio recovery script" "[[ -f '$HOME/.local/bin/lm-studio-ensure.sh' && -x '$HOME/.local/bin/lm-studio-ensure.sh' ]]"
    verify "LM Studio recovery agent" "[[ -f '$HOME/Library/LaunchAgents/com.nathanvale.lm-studio-ensure.plist' ]]"
    verify "Sleep disabled" "pmset_setting_is_zero sleep"
    verify "Display sleep disabled" "pmset_setting_is_zero displaysleep"
    verify_warn "SSH enabled" "nc -z localhost 22"
    verify_warn "Screen saver disabled" "[[ \$(defaults read com.apple.screensaver idleTime 2>/dev/null) == '0' ]]"
    phase_end "Server Settings"
fi

# ============================================================================
# Summary
# ============================================================================
TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))
echo ""
if [[ $FAIL_COUNT -eq 0 && $WARN_COUNT -eq 0 ]]; then
    echo -e "${GREEN}=== ${TOTAL}/${TOTAL} checks passed ===${RESET}"
else
    echo -e "${CYAN}=== Verification Summary ===${RESET}"
    echo -e "  ${GREEN}Passed:${RESET}   $PASS_COUNT"
    if [[ $FAIL_COUNT -gt 0 ]]; then
        echo -e "  ${RED}Failed:${RESET}   $FAIL_COUNT"
    fi
    if [[ $WARN_COUNT -gt 0 ]]; then
        echo -e "  ${YELLOW}Warnings:${RESET} $WARN_COUNT"
    fi
fi

# ============================================================================
# Actionable recap for warnings and failures
# ============================================================================
if [[ $FAIL_COUNT -gt 0 || $WARN_COUNT -gt 0 ]]; then
    local_action_count=0

    echo ""
    echo -e "${YELLOW}╔══════════════════════════════════════════╗${RESET}"
    echo -e "${YELLOW}  Action needed${RESET}"
    echo -e "${YELLOW}╚══════════════════════════════════════════╝${RESET}"

    # Helper to print a numbered action item
    action() {
        local_action_count=$((local_action_count + 1))
        local color="$1"
        local title="$2"
        local desc="$3"
        shift 3
        echo ""
        echo -e "  ${color}${local_action_count}. ${title}${RESET} -- ${desc}"
        for line in "$@"; do
            echo "     $line"
        done
    }

    # Recap failed items
    if [[ ${#FAIL_ITEMS[@]} -gt 0 ]]; then
        for item in "${FAIL_ITEMS[@]}"; do
            case "$item" in
                "Homebrew")
                    action "$RED" "Homebrew" "not installed" \
                        "Fix: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
                    ;;
                "Dotfiles repo")
                    action "$RED" "Dotfiles repo" "missing" \
                        "Fix: git clone https://github.com/nathanvale/dotfiles-private.git ~/code/dotfiles"
                    ;;
                "Xcode CLT")
                    action "$RED" "Xcode CLT" "not installed" \
                        "Fix: xcode-select --install"
                    ;;
                "Bun"|"Bun version"|"Bun revision"|"Bun Homebrew ownership")
                    action "$RED" "Bun" "Homebrew-managed installation unavailable" \
                        "Fix: brew install bun" \
                        "Upgrade: brew upgrade bun" \
                        "Check: bun --version && bun --revision"
                    ;;
                "Toolchain declaration manifest")
                    action "$RED" "Toolchain declaration manifest" "unreadable, malformed, or invalid toolchain JSON" \
                        "Check: $DOTFILES/bin/dotfiles/toolchain status --json" \
                        "Repair: restore config/toolchain/versions.tsv with exactly Node, Bun, Python, Beads, Git, and npm rows"
                    ;;
                "Mise")
                    action "$RED" "Mise" "declared package owner is unavailable" \
                        "Fix: HOMEBREW_DOTFILES_PROFILE=$PROFILE brew bundle --file=$DOTFILES/config/brew/Brewfile" \
                        "Check: command -v mise"
                    ;;
                "Mise applied selection")
                    action "$RED" "Mise applied selection" "current is missing, malformed, unreadable, or unsafe" \
                        "Repair: $DOTFILES/bin/dotfiles/toolchain update --apply --json" \
                        "Inspect: readlink $STATE_DIR/toolchain/current"
                    ;;
                "Mise effective toolchain ownership")
                    action "$RED" "Mise effective toolchain ownership" "a selected runtime has the wrong version or owner" \
                        "Check: env -i HOME=\"$HOME\" PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /bin/sh -c '. \"$DOTFILES/config/mise/bootstrap.sh\"; \"$DOTFILES/bin/dotfiles/toolchain\" status --json'" \
                        "Repair: $DOTFILES/bin/dotfiles/toolchain update --apply --retry --json"
                    ;;
                "Managed symlink status contract")
                    action "$RED" "Managed symlink status contract" "missing, malformed, or inconsistent" \
                        "Fix: cd ~/code/dotfiles && bin/dotfiles/symlinks/symlinks_manage.sh --status --machine" \
                        "Repair: cd ~/code/dotfiles && bin/dotfiles/symlinks/symlinks_manage.sh --link"
                    ;;
                "Managed symlink:"*|"LM Studio recovery script"|"LM Studio recovery agent")
                    action "$RED" "$item" "broken, missing, or points to the wrong source" \
                        "Fix: cd ~/code/dotfiles && bin/dotfiles/symlinks/symlinks_manage.sh --link"
                    ;;
                "Profile package requirements manifest")
                    action "$RED" "$item" "unreadable, malformed, or inconsistent" \
                        "Repair: $DOTFILES/config/brew/profile-requirements.tsv" \
                        "Check: HOMEBREW_DOTFILES_PROFILE=$PROFILE brew bundle check --file=$DOTFILES/config/brew/Brewfile"
                    ;;
                "LM Studio CLI (preexisting server prerequisite)")
                    action "$RED" "LM Studio CLI" "preexisting server prerequisite is unavailable" \
                        "Fix: install the LM Studio cask and bootstrap its lms CLI on this server" \
                        "Check: test -x ~/.lmstudio/bin/lms"
                    ;;
                "Profile saved")
                    action "$RED" "Profile saved" "state file missing" \
                        "Fix: echo 'server' > ~/.dotfiles_state/profile  (or 'desktop')"
                    ;;
                "Sleep disabled"|"Display sleep disabled")
                    action "$RED" "$item" "pmset not configured" \
                        "Fix: sudo pmset -a sleep 0 && sudo pmset -a displaysleep 0"
                    ;;
                *)
                    action "$RED" "$item" "failed" \
                        "Fix: re-run setup or install manually"
                    ;;
            esac
        done
    fi

    # Recap warned items
    if [[ ${#WARN_ITEMS[@]} -gt 0 ]]; then
        for item in "${WARN_ITEMS[@]}"; do
            case "$item" in
                "Toolchain reconstruction qualification")
                    action "$YELLOW" "Toolchain reconstruction qualification" "live selection is separate from clean-machine exact reconstruction" \
                        "Check: $DOTFILES/bin/dotfiles/toolchain status --json" \
                        "Keep fnm, pyenv, and Homebrew fallbacks until a clean no-cache Mac and exact Git owner are qualified"
                    ;;
                "OrbStack")
                    action "$YELLOW" "OrbStack" "not installed (may be an orphaned app issue)" \
                        "Fix: rm -rf /Applications/OrbStack.app && brew install --cask orbstack" \
                        "Or re-run: setup.sh --server (pre-cleanup handles this automatically)"
                    ;;
                "SSH enabled")
                    action "$YELLOW" "SSH" "could not verify (needs sudo)" \
                        "Fix:   sudo systemsetup -setremotelogin on" \
                        "Check: sudo systemsetup -getremotelogin"
                    ;;
                "Screen saver disabled")
                    action "$YELLOW" "Screen saver" "could not verify setting" \
                        "Fix:   defaults write com.apple.screensaver idleTime 0" \
                        "Check: defaults read com.apple.screensaver idleTime"
                    ;;
                "Full Disk Access")
                    action "$YELLOW" "Full Disk Access" "not granted (5 Safari prefs skipped)" \
                        "Fix:" \
                        "  1. System Settings > Privacy & Security > Full Disk Access" \
                        "  2. Add your terminal app (Ghostty, Terminal, etc.)" \
                        "  3. Relaunch terminal" \
                        "  4. Run: ~/code/dotfiles/config/macos/defaults.common.sh --set"
                    ;;
                "Claude Code")
                    action "$YELLOW" "Claude Code" "not installed" \
                        "Fix: curl -fsSL https://claude.ai/install.sh | bash"
                    ;;
                "Managed Codex")
                    action "$YELLOW" "Managed Codex" "not installed" \
                        "Fix: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
                    ;;
                "Optional managed symlink:"*)
                    action "$YELLOW" "$item" "optional managed destination is broken or missing" \
                        "Fix: cd ~/code/dotfiles && bin/dotfiles/symlinks/symlinks_manage.sh --link"
                    ;;
                "VS Code")
                    action "$YELLOW" "VS Code" "not installed" \
                        "Fix: brew install --cask visual-studio-code"
                    ;;
                "Slack")
                    action "$YELLOW" "Slack" "not installed" \
                        "Fix: brew install --cask slack"
                    ;;
                "Discord")
                    action "$YELLOW" "Discord" "not installed" \
                        "Fix: brew install --cask discord"
                    ;;
                "AI rescue marker")
                    # Suppress entirely -- Claude Code handles this
                    if claude_code_available; then
                        continue
                    fi
                    action "$YELLOW" "AI rescue" "Claude Code not available" \
                        "Fix: curl -fsSL https://claude.ai/install.sh | bash"
                    ;;
                "Ollama")
                    action "$YELLOW" "Ollama" "not installed" \
                        "Fix: brew install ollama"
                    ;;
                *)
                    action "$YELLOW" "$item" "not available" \
                        "Fix: check brew bundle output above"
                    ;;
            esac
        done
    fi

    echo ""
    echo -e "  ${DIM}Tip: claude 'Help me fix these. Log: ~/.dotfiles_state/setup.log'${RESET}"
fi

echo ""

if $MACHINE_SUMMARY; then
    verification_status="verified"
    if [[ $FAIL_COUNT -gt 0 ]]; then
        verification_status="failed"
    elif [[ $WARN_COUNT -gt 0 ]]; then
        verification_status="qualified"
    fi
    printf 'DOTFILES_VERIFY_SUMMARY version=1 status=%s passed=%d failed=%d warnings=%d\n' \
        "$verification_status" "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT"
fi

if [[ $FAIL_COUNT -gt 0 ]]; then
    exit 1
fi
exit 0
