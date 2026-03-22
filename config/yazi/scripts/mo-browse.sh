#!/bin/bash
# Mo browse: open markdown files in Mo browser viewer
# Usage: mo-browse.sh <path>
# - If path is a folder: watches all .md files in that folder (live-reload)
# - If path is a file: opens that single file

TARGET="$1"

# Clean slate
mo --shutdown 2>/dev/null
echo y | mo --clear 2>/dev/null

if [ -d "$TARGET" ]; then
  cd "$TARGET" || exit 1
  NAME=$(basename "$TARGET")
  # Use -w to watch recursively for .md files (can't combine with file args)
  mo --open -w "**/*.md" -t "$NAME"
else
  mo --open "$TARGET"
fi
