#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FONT_DIR="$REPO_ROOT/misc/jetbrains-mono"
DEST_DIR="$HOME/Library/Fonts"

# Source the shared logger from the repository.
source "$REPO_ROOT/bin/colour_log.sh"

# Function to display usage
usage() {
    echo "Usage: $0 [-a | --add] [-r | --remove] [-h | --help]"
    echo "  -a, --add     Add JetBrains Mono fonts"
    echo "  -r, --remove  Remove JetBrains Mono fonts"
    echo "  -h, --help    Display this help message"
    exit 1
}

# Function to add fonts
add_fonts() {
    mkdir -p "$DEST_DIR"
    cp "$FONT_DIR"/*.ttf "$DEST_DIR"
    if [ $? -eq 0 ]; then
        log "$INFO" "JetBrains Mono fonts added successfully."
        exit 0
    else
        log "$ERROR" "Failed to add JetBrains Mono fonts."
        exit 1
    fi
}

# Function to remove fonts
remove_fonts() {
    rm -f "$DEST_DIR"/JetBrainsMono-*.ttf
    if [ $? -eq 0 ]; then
        log "$INFO" "JetBrains Mono fonts removed successfully."
        exit 0
    else
        log "$ERROR" "Failed to remove JetBrains Mono fonts."
        exit 1
    fi
}

# Check if no arguments are provided
if [ $# -eq 0 ]; then
    usage
fi

# Parse command-line arguments
while [[ "$1" != "" ]]; do
    case $1 in
    -a | --add)
        shift
        add_fonts
        ;;
    -r | --remove)
        shift
        remove_fonts
        ;;
    -h | --help)
        usage
        ;;
    *)
        usage
        ;;
    esac
    shift
done
