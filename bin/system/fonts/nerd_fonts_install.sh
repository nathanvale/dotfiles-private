#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/../../colour_log.sh"

log "$INFO" "Adding JetBrains Mono fonts."

"$SCRIPT_DIR/nerd_fonts_manage.sh" --add
