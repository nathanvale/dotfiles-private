#!/bin/bash

# HyperFlow - Hyper key app launcher and workspace switcher
# Usage: hyperflow.sh <workspace-id>
# Examples: hyperflow.sh 1, hyperflow.sh M, hyperflow.sh F

set -euo pipefail

WORKSPACE="$1"
WORKSPACE_STATE_FILE="/tmp/hyperflow-current-workspace.txt"

WORKSPACES_BASE="$HOME/.config/hyperflow"
WORKSPACES_CONFIG="$WORKSPACES_BASE/workspaces.json"

# Work overlay selection reads the fixed machine-state selector that .zshrc
# owns, ~/.dotfiles_state/work-profile, never the ambient WORK_PROFILE
# variable: an ambient value lets anything able to set an environment variable
# choose which config this launcher reads. The file must hold exactly one
# scalar that passes the same conservative grammar and 32-character total
# length as the shell selector; anything else keeps the base config.
select_workspaces_config() {
    local state_file="$HOME/.dotfiles_state/work-profile"
    [[ -r "$state_file" ]] || return 0

    # Two reads on one descriptor, as in .zshrc: a single read cannot tell a
    # well-formed one-line file from the first line of a file carrying more.
    local slug="" extra="" slug_status=0 extra_status=0
    exec 9<"$state_file" || return 0
    IFS= read -r -u 9 slug || slug_status=$?
    IFS= read -r -u 9 extra || extra_status=$?
    exec 9<&-

    if (( slug_status != 0 )) && [[ -z "$slug" ]]; then
        return 0
    fi
    if (( extra_status == 0 )) || [[ -n "$extra" ]]; then
        return 0
    fi
    if [[ ! "$slug" =~ ^[a-z0-9]([a-z0-9]|-[a-z0-9]){0,31}$ ]] || (( ${#slug} > 32 )); then
        return 0
    fi

    local overlay="$WORKSPACES_BASE/workspaces.${slug}.json"
    if [[ -f "$overlay" ]]; then
        WORKSPACES_CONFIG="$overlay"
    fi
    return 0
}

select_workspaces_config

# Function to get the current workspace from state file
get_current_workspace() {
    if [[ -f "$WORKSPACE_STATE_FILE" ]]; then
        cat "$WORKSPACE_STATE_FILE"
    else
        echo ""
    fi
}

# Function to set the current workspace in state file
set_current_workspace() {
    local workspace="$1"
    echo "$workspace" > "$WORKSPACE_STATE_FILE"
}

# Function to wait for app to be frontmost
wait_for_app_focus() {
    local app_name="$1"
    local process_name
    process_name=$(get_process_name "$app_name")
    local max_attempts=10
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        local frontmost
        frontmost=$(osascript -e 'tell application "System Events" to name of first process whose frontmost is true' 2>/dev/null || echo "")
        if [[ "$frontmost" == "$process_name" ]]; then
            return 0
        fi
        sleep 0.05
        ((attempt++))
    done
    return 1
}

# Function to cycle through windows using Option+N
cycle_windows() {
    # Send Option+N keystroke to cycle through windows
    osascript -e 'tell application "System Events" to keystroke "n" using {option down}' 2>/dev/null || true
}

# Map application names to their actual process names
get_process_name() {
    local app_name="$1"
    case "$app_name" in
        "Visual Studio Code")
            echo "Code"
            ;;
        "Microsoft Teams")
            echo "MSTeams"
            ;;
        "Ghostty")
            echo "ghostty"
            ;;
        "Codex")
            echo "ChatGPT"
            ;;
        "System Settings")
            echo "System Settings"
            ;;
        *)
            echo "$app_name"
            ;;
    esac
}

# Function to check if an app is running
is_app_running() {
    local app_name="$1"
    osascript -e "tell application \"System Events\" to (name of processes) contains \"$app_name\"" 2>/dev/null
}

# Function to open and activate an app
# If app is not running, opens it
# If app is already running, just focuses it
open_and_activate() {
    local app_name="$1"

    # Check if app is already running
    local is_running
    is_running=$(is_app_running "$app_name")

    if [[ "$is_running" == "false" ]]; then
        # App not running - open it
        open -a "$app_name"
    fi

    # Always activate (handles both new and existing apps)
    osascript -e "tell application \"$app_name\" to activate" 2>/dev/null || true
}

# Main workspace handler with cycling support
handle_workspace() {
    local workspace_id="$1"
    local app_name="$2"

    # Finder activation alone can leave only the desktop visible. Restore a
    # window on every press, including when this workspace is already active.
    if [[ "$app_name" == "Finder" ]]; then
        osascript <<'APPLESCRIPT'
tell application "Finder"
    if (count of Finder windows) is 0 then
        make new Finder window to home
    end if
    set collapsed of Finder window 1 to false
    set index of Finder window 1 to 1
    activate
end tell
APPLESCRIPT
        set_current_workspace "$workspace_id"
        return 0
    fi

    local current_workspace
    current_workspace=$(get_current_workspace)

    if [[ "$current_workspace" == "$workspace_id" ]]; then
        # Same workspace pressed - check if app is actually focused
        local process_name
        process_name=$(get_process_name "$app_name")
        local frontmost
        frontmost=$(osascript -e 'tell application "System Events" to name of first process whose frontmost is true' 2>/dev/null || echo "")

        if [[ "$frontmost" == "$process_name" ]]; then
            # App IS focused - cycle through its windows
            cycle_windows
        else
            # App lost focus (user clicked elsewhere) - re-activate it
            open_and_activate "$app_name"
            wait_for_app_focus "$app_name"
        fi
    else
        # Different workspace - full switch
        # 1. Mark workspace FIRST (prevents race on rapid presses)
        set_current_workspace "$workspace_id"

        # 2. Open/activate app
        open_and_activate "$app_name"

        # 3. Wait for app to be focused before continuing
        wait_for_app_focus "$app_name"
    fi
}

# Multi-app workspace handler (opens multiple apps and toggles between them)
handle_multi_workspace() {
    local workspace_id="$1"
    shift 1
    local apps=("$@")

    local current_workspace
    current_workspace=$(get_current_workspace)

    if [[ "$current_workspace" == "$workspace_id" ]]; then
        # Same workspace - toggle between apps
        # Check which app is currently frontmost
        local frontmost
        frontmost=$(osascript -e 'tell application "System Events" to name of first process whose frontmost is true' 2>/dev/null || echo "")

        # Find which app is currently active and switch to the next one
        local next_app=""
        for i in "${!apps[@]}"; do
            local process_name
            process_name=$(get_process_name "${apps[$i]}")
            if [[ "$frontmost" == "$process_name" ]]; then
                # Found current app, switch to next (or wrap around)
                local next_index
                next_index=$(( (i + 1) % ${#apps[@]} ))
                next_app="${apps[$next_index]}"
                break
            fi
        done

        # If no match found (focus was lost to non-workspace app), activate first app
        if [[ -z "$next_app" ]]; then
            next_app="${apps[0]}"
        fi
        open_and_activate "$next_app"
    else
        # Different workspace - full switch
        # 1. Mark workspace FIRST (prevents race on rapid presses)
        set_current_workspace "$workspace_id"

        # 2. Open all apps
        for app_name in "${apps[@]}"; do
            open_and_activate "$app_name"
        done

        # 3. Wait for first app to be focused
        wait_for_app_focus "${apps[0]}"
    fi
}

# Load workspace configuration from JSON
if [[ ! -f "$WORKSPACES_CONFIG" ]]; then
    echo "Error: Workspaces config not found: $WORKSPACES_CONFIG"
    exit 1
fi

# Parse workspace config for requested workspace ID
WORKSPACE_DATA=$(jq -r ".workspaces[\"$WORKSPACE\"] // empty" "$WORKSPACES_CONFIG")

if [[ -z "$WORKSPACE_DATA" ]]; then
    echo "Unknown workspace: $WORKSPACE"
    exit 1
fi

# Extract apps array
# Use a safer method to handle app names with spaces
APPS=()
while IFS= read -r app; do
    APPS+=("$app")
done < <(echo "$WORKSPACE_DATA" | jq -r '.apps[]')

# Determine which handler to use based on number of apps
if [[ ${#APPS[@]} -eq 1 ]]; then
    # Single app - use standard handler
    handle_workspace "$WORKSPACE" "${APPS[0]}"
else
    # Multiple apps - use multi-app handler
    handle_multi_workspace "$WORKSPACE" "${APPS[@]}"
fi
